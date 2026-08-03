import { desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "../schema.ts";
import { sessions } from "../schema.ts";

/** 生产走 node-postgres、测试走 PGlite，两者的查询构造 API 是同一套 */
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 更新 updatedAt 一律用数据库时钟，不用 JS 的 new Date()。
 * INSERT 走 schema 的 defaultNow()（即 Postgres now()，微秒精度），
 * 而 new Date() 只有毫秒精度；两者混用时，同一毫秒内被 touch 过的会话
 * 时间戳可能反而小于刚插入的会话，导致左栏「最近更新在最上面」的排序翻转。
 *
 * 注意 now() 是 transaction_timestamp()，同一个事务里恒定。本文件的每条语句都各自
 * 成事务，所以互不影响（全仓唯一的 db.transaction() 在 messages.append 里，
 * 它只写 messages）；将来若把一批 touch() 包进同一个事务，它们会拿到并列的时间戳。
 *（不要为此换成 clock_timestamp()，那会让写入与 defaultNow() 不再是同一个时钟源，
 * 正是这里要避免的。）
 */
const NOW = sql`now()`;

export function createSessionRepository(db: Database) {
  return {
    async listByUser(userId: string): Promise<SessionSummary[]> {
      return db
        .select({
          id: sessions.id,
          title: sessions.title,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.updatedAt));
    },

    async findById(id: string) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return rows[0];
    },

    /**
     * 已存在时只更新 updatedAt，不碰 title——
     * 否则用户重命名过的会话会在下一条消息时被打回首句截断。
     */
    async upsert(input: { id: string; userId: string; title: string }): Promise<void> {
      await db
        .insert(sessions)
        .values(input)
        .onConflictDoUpdate({
          target: sessions.id,
          set: { updatedAt: NOW },
        });
    },

    // 注意：这里用 0 参 returning() 而不是 returning({ id })。
    // TS 在「NodePgDatabase | PgliteDatabase」联合类型上调用带泛型的 returning(fields)
    // 会错误解析到 0 参重载而报 TS2554（select(fields) 无此问题）；
    // 返回全列与返回 { id } 对 length > 0 的判断等价，所以取前者。
    async rename(id: string, title: string): Promise<boolean> {
      const updated = await db
        .update(sessions)
        .set({ title, updatedAt: NOW })
        .where(eq(sessions.id, id))
        .returning();
      return updated.length > 0;
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await db.delete(sessions).where(eq(sessions.id, id)).returning();
      return deleted.length > 0;
    },

    async touch(id: string): Promise<void> {
      await db.update(sessions).set({ updatedAt: NOW }).where(eq(sessions.id, id));
    },
  };
}

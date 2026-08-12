import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import { userMemories } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface Memory {
  id: string;
  content: string;
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchHit extends Memory {
  /** 余弦相似度：1 = 完全一致，0 = 正交。由 1 - cosineDistance 算得 */
  similarity: number;
}

/**
 * embedding 不出现在任何返回类型里：1024 个浮点数对调用方没有用处，
 * 返回它只会把它塞进 HTTP 响应和日志。
 */
const COLUMNS = {
  id: userMemories.id,
  content: userMemories.content,
  sourceSessionId: userMemories.sourceSessionId,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
};

/**
 * 用户级长期记忆的读写。
 *
 * **所有方法首参都是 userId，不提供任何不带 userId 的查询入口**——
 * 让「忘记按用户收窄」在类型层就写不出来。这是记忆系统用户隔离的主要手段。
 */
export function createMemoryRepository(db: Database) {
  return {
    async insert(
      userId: string,
      values: { content: string; embedding: number[]; sourceSessionId: string | null },
    ): Promise<Memory> {
      // 0 参 returning()：TS 在 NodePgDatabase | PgliteDatabase 联合上调用带泛型的
      // returning(fields) 会误解析到 0 参重载而报 TS2554（同 sessions.ts 的说明）
      const rows = await db
        .insert(userMemories)
        .values({ userId, ...values })
        .returning();
      // 没有 onConflict，插不进去只可能是异常（已经抛了），所以这里必有一行
      const row = rows[0];
      if (!row) throw new Error("插入记忆后没有返回行");
      const { id, content, sourceSessionId, createdAt, updatedAt } = row;
      return { id, content, sourceSessionId, createdAt, updatedAt };
    },

    async countByUserId(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userMemories)
        .where(eq(userMemories.userId, userId));
      return rows[0]?.count ?? 0;
    },

    async listByUserId(userId: string): Promise<Memory[]> {
      return db
        .select(COLUMNS)
        .from(userMemories)
        .where(eq(userMemories.userId, userId))
        .orderBy(desc(userMemories.createdAt));
    },

    /** 返回是否真的删到。删不存在的与删别人的在路由层是同一个响应（404），repo 只如实报告 */
    async deleteById(userId: string, id: string): Promise<boolean> {
      // 0 参 returning()：同上，联合类型上的 returning(fields) 会误报 TS2554
      const rows = await db
        .delete(userMemories)
        .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
        .returning();
      return rows.length > 0;
    },

    /**
     * 按余弦相似度倒序取前 limit 条。
     *
     * 用余弦而不是内积：内积只在向量已 L2 归一化时与余弦等价，
     * 而 embedding 模型是否归一化是 provider 的实现细节，不该被这里假设。
     */
    async searchByEmbedding(userId: string, embedding: number[], limit: number): Promise<MemorySearchHit[]> {
      const similarity = sql<number>`1 - (${cosineDistance(userMemories.embedding, embedding)})`;
      return db
        .select({ ...COLUMNS, similarity })
        .from(userMemories)
        .where(eq(userMemories.userId, userId))
        .orderBy(desc(similarity))
        .limit(limit);
    },
  };
}

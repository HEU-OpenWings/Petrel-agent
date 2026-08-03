import { desc, eq } from "drizzle-orm";
import { users } from "../schema.ts";
import type { Database } from "./sessions.ts";

/** 对外可见的用户字段。passwordHash 永远不在里面 */
export interface PublicUser {
  id: string;
  email: string;
  role: string;
  disabled: boolean;
  createdAt: Date;
}

/** 只有登录校验用得到，不要泄漏到 route 层 */
export interface UserWithSecret extends PublicUser {
  passwordHash: string;
}

/**
 * 公开字段的投影集中在这里定义一次。
 *
 * 不用 db.select() 取全列再删字段：那样每加一个敏感列都要记得去每个调用点删，
 * 漏一处就是把哈希吐给前端。
 */
const PUBLIC_COLUMNS = {
  id: users.id,
  email: users.email,
  role: users.role,
  disabled: users.disabled,
  createdAt: users.createdAt,
} as const;

export function createUserRepository(db: Database) {
  return {
    async create(input: { email: string; passwordHash: string; role?: string }): Promise<PublicUser> {
      const inserted = await db
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          role: input.role ?? "user",
          // username 是待删的遗留列，仍是 notNull unique，先用邮箱填上。
          // Task 16 删掉这一列后这行也要删
          username: input.email,
        })
        .returning();
      // 0 参 returning()：TS 在 NodePgDatabase | PgliteDatabase 联合上调用带泛型的
      // returning(fields) 会误解析到 0 参重载而报 TS2554（同 sessions.ts 的说明）
      // biome-ignore lint/style/noNonNullAssertion: Drizzle insert 必然返回一行，否则抛错
      const row = inserted[0]!;
      return {
        id: row.id,
        email: row.email,
        role: row.role,
        disabled: row.disabled,
        createdAt: row.createdAt,
      };
    },

    /** 登录校验专用：带 passwordHash */
    async findByEmail(email: string): Promise<UserWithSecret | undefined> {
      const rows = await db
        .select({ ...PUBLIC_COLUMNS, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0];
    },

    async findById(id: string): Promise<PublicUser | undefined> {
      const rows = await db.select(PUBLIC_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
      return rows[0];
    },

    async listAll(): Promise<PublicUser[]> {
      return db.select(PUBLIC_COLUMNS).from(users).orderBy(desc(users.createdAt));
    },

    async setDisabled(id: string, disabled: boolean): Promise<boolean> {
      // 0 参 returning()：TS 在 NodePgDatabase | PgliteDatabase 联合上调用带泛型的
      // returning(fields) 会误解析到 0 参重载而报 TS2554（同 sessions.ts 的说明）
      const updated = await db.update(users).set({ disabled }).where(eq(users.id, id)).returning();
      return updated.length > 0;
    },

    async setRole(id: string, role: string): Promise<boolean> {
      const updated = await db.update(users).set({ role }).where(eq(users.id, id)).returning();
      return updated.length > 0;
    },
  };
}

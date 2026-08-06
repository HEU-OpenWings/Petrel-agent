import { desc, eq, sql } from "drizzle-orm";
import { users } from "../schema.ts";
import type { Database } from "./sessions.ts";

/** 对外可见的用户字段。passwordHash 永远不在里面；emailVerifiedAt 非敏感，admin 列表可见 */
export interface PublicUser {
  id: string;
  email: string;
  role: string;
  disabled: boolean;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

/** 只有登录 / 验证 / 重置校验用得到，不要泄漏到 route 层 */
export interface UserWithSecret extends PublicUser {
  passwordHash: string;
  emailVerifyTokenExpiresAt: Date | null;
  passwordResetTokenExpiresAt: Date | null;
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
  emailVerifiedAt: users.emailVerifiedAt,
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
        emailVerifiedAt: row.emailVerifiedAt,
        createdAt: row.createdAt,
      };
    },

    /** 登录校验专用：带 passwordHash */
    async findByEmail(email: string): Promise<UserWithSecret | undefined> {
      const rows = await db
        .select({
          ...PUBLIC_COLUMNS,
          passwordHash: users.passwordHash,
          emailVerifyTokenExpiresAt: users.emailVerifyTokenExpiresAt,
          passwordResetTokenExpiresAt: users.passwordResetTokenExpiresAt,
        })
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

    /**
     * 验证成功后置位。**不清掉验证 token 哈希**：用户（或邮件客户端）可能点两次链接，
     * 清掉后第二次会变成「链接无效」。保留哈希没有安全影响——账号已验证，
     * 哈希只是 sha256 的 256 位随机值；下次重发验证会覆盖它。
     */
    async setEmailVerified(id: string, at: Date): Promise<boolean> {
      const updated = await db.update(users).set({ emailVerifiedAt: at }).where(eq(users.id, id)).returning();
      return updated.length > 0;
    },

    async setEmailVerifyToken(id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({ emailVerifyTokenHash: tokenHash, emailVerifyTokenExpiresAt: expiresAt })
        .where(eq(users.id, id))
        .returning();
      return updated.length > 0;
    },

    /** 验证链接专用：按 token 哈希找用户，带 passwordHash 只是复用现有查询形状 */
    async findByEmailVerifyToken(tokenHash: string): Promise<UserWithSecret | undefined> {
      const rows = await db
        .select({
          ...PUBLIC_COLUMNS,
          passwordHash: users.passwordHash,
          emailVerifyTokenExpiresAt: users.emailVerifyTokenExpiresAt,
          passwordResetTokenExpiresAt: users.passwordResetTokenExpiresAt,
        })
        .from(users)
        .where(eq(users.emailVerifyTokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },

    async setPasswordResetToken(id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({ passwordResetTokenHash: tokenHash, passwordResetTokenExpiresAt: expiresAt })
        .where(eq(users.id, id))
        .returning();
      return updated.length > 0;
    },

    async findByPasswordResetToken(tokenHash: string): Promise<UserWithSecret | undefined> {
      const rows = await db
        .select({
          ...PUBLIC_COLUMNS,
          passwordHash: users.passwordHash,
          emailVerifyTokenExpiresAt: users.emailVerifyTokenExpiresAt,
          passwordResetTokenExpiresAt: users.passwordResetTokenExpiresAt,
        })
        .from(users)
        .where(eq(users.passwordResetTokenHash, tokenHash))
        .limit(1);
      return rows[0];
    },

    /**
     * 密码重置落库：换哈希 + 清空重置 token，并把邮箱顺带标记为已验证
     * （重置邮件本身就是邮箱所有权证明，也兜住「验证邮件丢了」的情况）。
     */
    async resetPassword(id: string, passwordHash: string, now: Date): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
          emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, ${now})`,
        })
        .where(eq(users.id, id))
        .returning();
      return updated.length > 0;
    },

    /** 只有「用户自己改密码」这一条路径会调它。admin 无权替人改密码 */
    async setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
      const updated = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning();
      return updated.length > 0;
    },
  };
}

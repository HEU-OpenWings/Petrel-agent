import { eq, sql } from "drizzle-orm";
import { userQuotaLimits } from "../schema.ts";
import type { Database } from "./sessions.ts";

/**
 * 用户级配额覆盖的 CRUD。
 *
 * 语义（与 schema.ts 注释一致）：无行 = 跟随系统默认（env）；有行 = 覆盖；
 * token_limit 为 null 也表示跟随默认（admin 把覆盖删掉等价于置回 null）。
 *
 * 不在这里维护 used_tokens / period_start：滚动窗口的已用量由 token-usage.ts
 * 实时 SUM，不缓存成可变状态——缓存在窗口翻转时会漂移。
 */
export function createQuotaLimitsRepository(db: Database) {
  return {
    /** 读用户覆盖额度。无行或 token_limit 为 null 返回 undefined（= 跟随系统默认）。 */
    async getLimit(userId: string): Promise<number | undefined> {
      const rows = await db
        .select({ tokenLimit: userQuotaLimits.tokenLimit })
        .from(userQuotaLimits)
        .where(eq(userQuotaLimits.userId, userId))
        .limit(1);
      const value = rows[0]?.tokenLimit;
      // bigint 列在 node-postgres 上往返为字符串；number 在 PGlite。统一成 number | undefined。
      if (value === null || value === undefined) return undefined;
      return typeof value === "string" ? Number(value) : value;
    },

    /**
     * 设置/更新覆盖额度。tokenLimit 必须是具体数值。
     *
     * 「恢复系统默认」由 deleteLimit 负责（route 层 tokenLimit===null 时走它），
     * 所以这里不接受 undefined——原先的 `number | undefined` 分支在 route 层不可达：
     * tokenLimit===null → deleteLimit，否则一定是非负整数。收窄成 number 去掉投机灵活性。
     * 列仍保持 nullable（getLimit 把 null 行等同于「无行」），只是当前不会被写入 null。
     */
    async upsertLimit(userId: string, tokenLimit: number): Promise<void> {
      await db
        .insert(userQuotaLimits)
        .values({
          userId,
          tokenLimit,
          // 显式用 DB 时钟，与 sessions.ts 的 touch 一致（避免 new Date() 毫秒精度翻转）
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: userQuotaLimits.userId,
          set: {
            tokenLimit,
            updatedAt: sql`now()`,
          },
        });
    },

    /** 删除覆盖行，恢复跟随系统默认。无行时幂等成功。 */
    async deleteLimit(userId: string): Promise<void> {
      await db.delete(userQuotaLimits).where(eq(userQuotaLimits.userId, userId));
    },
  };
}

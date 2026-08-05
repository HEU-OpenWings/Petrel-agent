import { and, eq, gte, sql } from "drizzle-orm";
import { tokenUsage } from "../schema.ts";
import type { Database } from "./sessions.ts";

/**
 * 一条规范化后的用量事实。由 packages/agent 的 usage.ts 从 pi 的 SessionTreeEntry
 * 提取，再传到这里。database 层不认识 pi 类型——这是依赖方向的要求（database 不 import
 * 任何 pi 包），翻译工作全在 agent 层。
 *
 * `totalTokens` 必须等于四个分量之和：这是 DB 的 CHECK 约束（schema.ts），也是这里
 * DTO 的契约。提取方负责相加，不读 pi 的 usage.totalTokens（某些 provider 不填它会归零）。
 */
export interface UsageFact {
  entryId: string;
  userId: string;
  sessionId: string;
  sourceType: "message" | "compaction" | "branch_summary";
  model?: string;
  provider?: string;
  api?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** 美元成本。agent 层从 usage.cost.total 取，已折算。string 是因为 numeric 列的往返形式 */
  costTotal: string;
}

export function createTokenUsageRepository(db: Database) {
  return {
    /**
     * 幂等插入一条用量事实。
     *
     * `ON CONFLICT (entry_id) DO NOTHING`：entry_id 是 pi uuidv7，同一会话树条目
     * 被结算多少次都只落一行。这是事务双写方案的核心幂等保证——并发、followUp、
     * 重试都不会重复计量。
     *
     * 可选的 `tx` 参数用于 HEU-40 的 usage 双写：调用方在一个 db.transaction 内
     * 同时写 session_entries 与 token_usage，两者必须同成同败，于是复用同一个
     * 事务 handle。不传 tx 时走 repository 自己的 db 连接。
     */
    async insertFact(fact: UsageFact, tx?: Database): Promise<void> {
      const conn = tx ?? db;
      await conn
        .insert(tokenUsage)
        .values({
          entryId: fact.entryId,
          userId: fact.userId,
          sessionId: fact.sessionId,
          sourceType: fact.sourceType,
          model: fact.model,
          provider: fact.provider,
          api: fact.api,
          inputTokens: fact.inputTokens,
          outputTokens: fact.outputTokens,
          cacheReadTokens: fact.cacheReadTokens,
          cacheWriteTokens: fact.cacheWriteTokens,
          totalTokens: fact.totalTokens,
          costTotal: fact.costTotal,
        })
        .onConflictDoNothing();
    },

    /**
     * 某用户在滚动时间窗内的 token 总用量。
     *
     * 配额检查的热查询。窗口由调用方按 env QUOTA_WINDOW_HOURS 算出 `since`（now()-interval）传入，
     * 不在这里读 env——保持 database 层与 config 解耦。
     *
     * 返回 bigint 的 sum 在 node-postgres 上是字符串，这里统一转 number。
     * 单用户的窗口用量不会超过 Number.MAX_SAFE_INTEGER（哪怕一亿 token 也才 1e8），
     * 用 number 足够，前端显示也无压力。
     */
    async sumWindowUsage(userId: string, since: Date): Promise<number> {
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${tokenUsage.totalTokens}), 0)` })
        .from(tokenUsage)
        .where(and(eq(tokenUsage.userId, userId), gte(tokenUsage.recordedAt, since)));
      const value = rows[0]?.total;
      // node-postgres 的 sum(bigint) 返回字符串；PGlite 可能返回 number。统一兜底。
      return typeof value === "string" ? Number(value) : (value ?? 0);
    },

    /**
     * 配额拒绝时，计算距离「有足够旧用量过期后能再次放行」还需要多久（秒）。
     *
     * 思路：按 recorded_at 升序累计用户的窗口内用量，找出「累计量越过 (已用 - 上限)」
     * 的那条记录——它过期之后，窗口内用量就降到上限以下，可以重试。
     *
     * 实现成一条窗口函数 SQL：累计和减去当前窗口已用量，等于「这条记录及其更早的
     * 还在窗口内的记录」之和；最早一条使「已用 - (该条及更早之和) < 上限」的记录的
     * 过期时刻即 Retry-After。
     *
     * 若算不出（边界情况、刚好打满），返回 undefined——调用方据此省略 Retry-After header，
     * 不返回一个可能仍无法重试的伪值。
     */
    async secondsUntilUnderLimit(userId: string, since: Date, limit: number): Promise<number | undefined> {
      // 窗口内、按时间升序累计。only those within the current window can expire into availability.
      const rows = await db.execute(sql`
        SELECT recorded_at, total_tokens,
               sum(total_tokens) OVER (ORDER BY recorded_at) AS running
        FROM token_usage
        WHERE user_id = ${userId} AND recorded_at >= ${since}
        ORDER BY recorded_at
      `);
      const result = rows as unknown as {
        rows: { recorded_at: string; total_tokens: string; running: string }[];
      };
      const entries = result.rows;
      const usedTotal = entries.reduce((acc, r) => acc + Number(r.total_tokens), 0);
      // 超出额：要让最早多少 token 过期。
      const overflow = usedTotal - limit;
      if (overflow <= 0) return undefined;
      // 累计找到第一条使 running >= overflow 的记录——它过期后即可重试
      let acc = 0;
      for (const r of entries) {
        acc += Number(r.total_tokens);
        if (acc >= overflow) {
          const expiresAt = new Date(r.recorded_at).getTime() + 24 * 60 * 60 * 1000;
          const diff = Math.ceil((expiresAt - Date.now()) / 1000);
          return diff > 0 ? diff : 0;
        }
      }
      return undefined;
    },
  };
}

import { env } from "@petrel/config";
import {
  createQuotaLimitsRepository,
  createTokenUsageRepository,
  type Database,
  getDb,
  type PublicUser,
} from "@petrel/database";
import { logger } from "@petrel/logger";

/**
 * HEU-40 配额错误。route 层翻译成 HTTP：
 * - "exceeded" → 429（配额用尽）
 * - "unavailable" → 503（配额查询失败，fail-closed 不调用模型）
 *
 * 与 services/auth.ts 的 AuthError 同模式：service 只表达「哪一种失败」。
 */
export class QuotaError extends Error {
  constructor(
    message: string,
    readonly kind: "exceeded" | "unavailable",
    /** 429 时距下次可重试的秒数；算不出则 undefined（省略 Retry-After，不返回伪值） */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

/**
 * 滚动窗口的起点（now - windowHours）。窗口长度来自 env，集中在这里算，
 * 避免调用方各算各的导致口径漂移。返回 Date 给 repository 的 gte(recorded_at)。
 */
export function windowStart(now: number = Date.now()): Date {
  return new Date(now - env.quotaWindowHours * 60 * 60 * 1000);
}

export function createQuotaService(db: Database) {
  const usageRepo = createTokenUsageRepository(db);
  const limitsRepo = createQuotaLimitsRepository(db);

  /**
   * 解析某用户的有效 token 上限：用户覆盖 ?? 系统默认（env）。
   */
  async function effectiveLimit(userId: string): Promise<number> {
    const override = await limitsRepo.getLimit(userId);
    // override 为 undefined（无行或 null）→ 跟随系统默认
    return override ?? env.quotaTokenLimit;
  }

  return {
    /**
     * 配额检查。allowed 时不抛；超限抛 QuotaError(exceeded)；查询失败抛 QuotaError(unavailable)。
     *
     * - enforcement 关闭（部署计量阶段）：直接 allowed，只落库不拦截。
     * - admin 用户：豁免拦截，直接 allowed（用量仍由 appendEntry 双写落库）。
     * - 普通用户：SUM 窗口用量，>= limit 则 exceeded。
     *
     * admin 豁免的是「拒绝」不是「计量」——appendEntry 的双写在 storage 层，与本函数无关。
     * 任何查询失败都转成 QuotaError(unavailable)，由 chat.ts 翻译成 503（fail-closed）：
     * 不能让 DB 故障把配额绕过去。
     */
    async check(user: PublicUser): Promise<void> {
      if (!env.quotaEnforcement) return;
      if (user.role === "admin") return;

      const limit = await guardQuery(() => effectiveLimit(user.id));
      if (limit <= 0) {
        // 用户被显式禁止调用模型（token_limit=0）
        throw new QuotaError("当前账号不可调用模型，请联系管理员", "exceeded");
      }

      const since = windowStart();
      const used = await guardQuery(() => usageRepo.sumWindowUsage(user.id, since));

      if (used >= limit) {
        // 算 Retry-After：累计过期计算。算不出则省略 header（不返回伪值）。
        const retryAfter = await guardQuery(() => usageRepo.secondsUntilUnderLimit(user.id, since, limit));
        throw new QuotaError(
          `已达到最近 ${env.quotaWindowHours} 小时的 token 配额，请稍后重试`,
          "exceeded",
          retryAfter,
        );
      }
    },
  };
}

/** 把任何查询异常翻译成 QuotaError(unavailable)，让 chat.ts 只需处理一种错误类型。 */
async function guardQuery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // 保留原始错误用于日志：QuotaError 自己不带 cause 字段，这里记下再抛
    logger.error({ err }, "quota query failed");
    throw new QuotaError("配额服务暂不可用，请稍后重试", "unavailable");
  }
}

/** 全应用共用一个实例（与 getAuthService / getRegistry 同模式）。 */
let instance: ReturnType<typeof createQuotaService> | undefined;

export function getQuotaService(): ReturnType<typeof createQuotaService> {
  instance ??= createQuotaService(getDb());
  return instance;
}

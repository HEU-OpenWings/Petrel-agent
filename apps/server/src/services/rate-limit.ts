/**
 * 固定窗口内存限流器。
 *
 * 与登录失败限流同一类实现：单实例内存、重启即失效、多副本部署下无效——
 * 那部分单独列在风控 issue（Redis）。窗口内首次命中从此刻起算，
 * 到达 max 后本窗口内一律拒绝；写入时惰性清理过期条目，避免 Map 无限增长。
 */
export interface RateLimiter {
  /** 记一次命中。返回 true 表示放行，false 表示超过窗口配额 */
  hit(key: string): boolean;
  reset(): void;
}

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<string, { count: number; firstAt: number }>();

  function prune(now: number): void {
    for (const [key, record] of hits) {
      if (now - record.firstAt >= windowMs) hits.delete(key);
    }
  }

  return {
    hit(key) {
      const now = Date.now();
      prune(now);
      const record = hits.get(key);
      if (!record || now - record.firstAt >= windowMs) {
        hits.set(key, { count: 1, firstAt: now });
        return true;
      }
      record.count += 1;
      return record.count <= max;
    },
    reset() {
      hits.clear();
    },
  };
}

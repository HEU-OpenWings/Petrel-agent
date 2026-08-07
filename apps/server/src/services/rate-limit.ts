/**
 * 固定窗口内存限流器。
 *
 * 与登录失败限流同一类实现：单实例内存、重启即失效、多副本部署下无效——
 * 那部分单独列在风控 issue（Redis）。
 *
 * 防 DoS 的两个设计点（review 要求）：
 * 1. **不逐次全表扫描**：key 全部攻击者可控（邮箱/IP），逐请求 `prune()` 会让
 *    Map 越大每个请求越慢。这里只在撞新 key 时做一次**时间门控**的 sweep
 *    （至多每 sweepMs 一次），全表扫描频率与请求量解耦。
 * 2. **容量上限**：Map 满时逐出最旧一条（插入序），内存有界。
 */
export interface RateLimiter {
  /** 记一次命中。返回 true 表示放行，false 表示超过窗口配额 */
  hit(key: string): boolean;
  reset(): void;
}

export interface RateLimiterOptions {
  /** Map 容量上限，默认 10 万条 */
  maxKeys?: number;
  /** 全表 sweep 的最短间隔，默认 min(窗口, 60s) */
  sweepMs?: number;
}

export function createRateLimiter(
  max: number,
  windowMs: number,
  options: RateLimiterOptions = {},
): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000;
  const sweepMs = options.sweepMs ?? Math.min(windowMs, 60_000);
  const hits = new Map<string, { bucketStart: number; count: number }>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < sweepMs) return;
    lastSweep = now;
    for (const [key, record] of hits) {
      if (now - record.bucketStart >= windowMs) hits.delete(key);
    }
  }

  return {
    hit(key) {
      const now = Date.now();
      const record = hits.get(key);
      if (record && now - record.bucketStart < windowMs) {
        record.count += 1;
        return record.count <= max;
      }

      sweep(now);
      // 容量满时逐出最旧一条（Map 迭代序 = 插入序），保证新请求仍能拿到槽位
      if (hits.size >= maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hits.set(key, { bucketStart: now, count: 1 });
      return true;
    },
    reset() {
      hits.clear();
      lastSweep = 0;
    },
  };
}

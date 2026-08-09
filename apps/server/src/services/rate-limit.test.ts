import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./rate-limit.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  it("窗口内超过 max 后拒绝，窗口滑动后重置", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter(3, 60_000);

    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(limiter.hit("k")).toBe(true);
  });

  it("不同 key 独立计数", () => {
    const limiter = createRateLimiter(1, 60_000);

    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
  });

  it("reset 清空计数", () => {
    const limiter = createRateLimiter(1, 60_000);
    limiter.hit("k");

    limiter.reset();

    expect(limiter.hit("k")).toBe(true);
  });

  it("容量满时逐出最旧 key，新 key 仍能拿到槽位（内存有界）", () => {
    const limiter = createRateLimiter(1, 60_000, { maxKeys: 2, sweepMs: 60_000 });

    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    // 满容量：插入 c 时逐出最旧的 a
    expect(limiter.hit("c")).toBe(true);
    expect(limiter.hit("c")).toBe(false);
    // a 已被逐出，重新计数
    expect(limiter.hit("a")).toBe(true);
  });

  it("sweep 受时间门控：窗口内多次撞新 key 不会逐次全扫（容量行为不受影响）", () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter(5, 60_000, { maxKeys: 100, sweepMs: 60_000 });

    for (let i = 0; i < 50; i++) {
      expect(limiter.hit(`k${i}`)).toBe(true);
    }
    // 模拟 15 分钟窗口后再次请求：sweep 触发并清掉过期条目
    vi.advanceTimersByTime(60_001);
    expect(limiter.hit("k0")).toBe(true);
    expect(limiter.hit("k0")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { createSseQueue } from "./sse-queue.ts";

/** 造一批占位帧，事件序号编进 data 里方便断言顺序 */
function frame(n: number) {
  return { event: "agent", data: String(n) };
}

/** MAX_QUEUE_EVENTS 在 sse-queue.ts 里是 2000，这里跟它保持一致但不 import 私有常量 */
const MAX_QUEUE_EVENTS = 2000;

describe("createSseQueue", () => {
  it("队列没满时 push 返回 true", () => {
    const queue = createSseQueue();
    expect(queue.push(frame(0))).toBe(true);
  });

  it("队列正好写满（第 2000 条）时 push 仍返回 true，第 2001 条才溢出", () => {
    const queue = createSseQueue();

    for (let i = 0; i < MAX_QUEUE_EVENTS; i += 1) {
      expect(queue.push(frame(i))).toBe(true);
    }
    // 溢出判断是「已经有 MAX 条在队列里」，第 2001 次 push 才会撞上限
    expect(queue.push(frame(MAX_QUEUE_EVENTS))).toBe(false);
  });

  it("溢出之后再 push 继续返回 false，不会把 overflowed 状态清掉", () => {
    const queue = createSseQueue();
    for (let i = 0; i < MAX_QUEUE_EVENTS; i += 1) queue.push(frame(i));
    expect(queue.push(frame(9998))).toBe(false);
    expect(queue.push(frame(9999))).toBe(false);
  });

  it("close() 之后 pump() 会先把已入队的剩余帧写完才退出（不丢 agent_end）", async () => {
    const queue = createSseQueue();
    queue.push(frame(1));
    queue.push(frame(2));
    queue.close();
    // close() 只是不再接受“新”事件，已经排队的两条必须被写出去

    const written: number[] = [];
    await queue.pump(async (f) => {
      written.push(Number(f.data));
    });

    expect(written).toEqual([1, 2]);
  });

  it("close() 之后再 push 返回 false，不会让已关闭的队列继续增长", () => {
    const queue = createSseQueue();
    queue.close();
    expect(queue.push(frame(1))).toBe(false);
  });

  it("溢出之后 pump() 写完溢出前已入队的帧就退出，不会一直等下去", async () => {
    const queue = createSseQueue();
    queue.push(frame(1));
    queue.push(frame(2));
    // 手动把队列推到溢出：写满剩余容量再多写一条
    for (let i = 3; i < MAX_QUEUE_EVENTS + 1; i += 1) queue.push(frame(i));
    expect(queue.push(frame(99999))).toBe(false); // 触发 overflowed

    const written: number[] = [];
    await queue.pump(async (f) => {
      written.push(Number(f.data));
    });

    // 溢出前排进去的 MAX_QUEUE_EVENTS 条全部写完，pump() 正常返回而不是挂起
    expect(written).toHaveLength(MAX_QUEUE_EVENTS);
    expect(written[0]).toBe(1);
    expect(written.at(-1)).toBe(MAX_QUEUE_EVENTS);
  });

  it("pump() 被并发调用第二次时明确抛错，而不是让两个消费者瓜分同一个队列", async () => {
    const queue = createSseQueue();
    // 第一份 pump 常驻不退出（close() 之前一直在等新事件）
    const first = queue.pump(async () => {});

    // pump() 是 async 函数，同步抛出的错误会被包成 rejected promise，不是同步 throw
    await expect(queue.pump(async () => {})).rejects.toThrow(/只能同时跑一份/);

    queue.close();
    await first;
  });

  it("pump() 结束之后可以再次调用（不是一次性用品，只是不能并发）", async () => {
    const queue = createSseQueue();
    queue.push(frame(1));
    queue.close();
    await queue.pump(async () => {});

    // 第一次 pump 已经跑完（pumping 标记复位），第二次调用不应该被当成并发误用
    await expect(queue.pump(async () => {})).resolves.toBeUndefined();
  });

  it("写出侧比生产侧慢时，事件顺序仍然按入队顺序，不会因为并发写入而错乱", async () => {
    const queue = createSseQueue();
    const written: number[] = [];

    const pumpDone = queue.pump(async (f) => {
      // 故意让写出变慢：写出耗时和数字大小成反比，制造「后写的可能先完成」的机会，
      // 顺序如果只靠 Promise 竞速而不是队列 FIFO，这里就会乱
      const n = Number(f.data);
      await new Promise((resolve) => setTimeout(resolve, n % 3 === 0 ? 5 : 0));
      written.push(n);
    });

    for (let i = 0; i < 20; i += 1) {
      queue.push(frame(i));
    }
    queue.close();
    await pumpDone;

    expect(written).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

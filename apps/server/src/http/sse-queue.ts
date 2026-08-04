export interface SseFrame {
  event: string;
  data: string;
}

/**
 * 有界队列 + 独立写出循环，把「生产者把事件塞进来」和「消费者真正把它写出去」解耦。
 *
 * 诞生背景（chat 路由）：pi 的 subscribe 是
 * `for (const listener of handlers) await listener(event)`
 * （@earendil-works/pi-agent-core 的 agent-harness.js emitAny/emitOwn）：串行 await、
 * 没有超时。listener 如果直接 `await stream.writeSSE(...)`，客户端不读流时 hono
 * streamSSE 底层 TransformStream（highWaterMark 1）的 writer.write() 就不会 resolve，
 * 直接冻死整条 agent loop——不止这一个连接：registry 那份维护 running 标记的常驻订阅
 * 收不到 settled、running 永远真、refCount 不释放、同会话其他连接的 send() 卡在
 * held.chain 上、abort() 内部的 waitForIdle() 也解不开。慢客户端因此能把整个会话、
 * 乃至（占满 200 个槽位后）整个进程冻住。
 *
 * 修法：生产侧只做同步入队，绝不 await 任何 I/O；真正的写出全部挪到 pump() 这个
 * 独立循环里——慢的是这个循环，不会反向传染给生产侧。这个模块本身不认识
 * AgentEvent、harness 或 HTTP，只认识"帧"，方便脱离 chat 路由单独测试其边界行为。
 */
export function createSseQueue() {
  /**
   * 上限按事件条数，不按字节：chunked 逐字流的一条长回答能拆成几百到上千个
   * delta 事件（token size 越小拆得越碎）。2000 留了几倍余量，正常回答不会碰到；
   * 顶到这个数只可能是消费侧完全不读，直接判定为死连接。
   */
  const MAX_QUEUE_EVENTS = 2000;
  const items: SseFrame[] = [];
  let waiter: (() => void) | undefined;
  let closed = false;
  let overflowed = false;
  let pumping = false;

  function wake() {
    const resolve = waiter;
    waiter = undefined;
    resolve?.();
  }

  return {
    /**
     * 生产侧调用：同步，不能在这里 await 任何 I/O。
     * 已经 close() 或已经溢出时返回 false——「停止接收新事件」这句注释原先只在
     * close() 里生效了一半（pump() 会认这个标记退出，但 push() 没查它），
     * 单测直接覆盖这个边界之后补上。
     */
    push(frame: SseFrame): boolean {
      if (overflowed || closed) return false;
      if (items.length >= MAX_QUEUE_EVENTS) {
        overflowed = true;
        wake();
        return false;
      }
      items.push(frame);
      wake();
      return true;
    },
    /** 停止接收新事件；已经排队的不清空，pump() 会先写完它们再退出（不丢尾部事件） */
    close(): void {
      closed = true;
      wake();
    },
    /**
     * 写出循环：写到队列空且（已 close 或已溢出）为止。
     *
     * 只允许调用一次：这是一个消费者的循环，不是可重入的资源池。并发调用两次会让
     * 两边同时 `items.shift()`，事件被两个消费者瓜分、顺序不再有意义——这是误用，
     * 不是需要支持的场景，所以直接抛错，而不是默默产生一个把事件抢岔了的行为。
     */
    async pump(write: (frame: SseFrame) => Promise<void>): Promise<void> {
      if (pumping) {
        throw new Error("createSseQueue: pump() 只能同时跑一份，不能并发调用两次");
      }
      pumping = true;
      try {
        for (;;) {
          const frame = items.shift();
          if (frame !== undefined) {
            await write(frame);
            continue;
          }
          if (closed || overflowed) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      } finally {
        pumping = false;
      }
    },
  };
}

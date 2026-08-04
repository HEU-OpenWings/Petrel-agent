import type { AgentHarness, Session } from "@petrel/agent";
import { createMemorySession, createPgSession, createHarness as createRealHarness } from "@petrel/agent";
import { createSessionRepository, type Database } from "@petrel/database";
import { logger } from "@petrel/logger";

/**
 * 纯业务错误，不带 HTTP 语义——与 services/auth.ts 的 AuthError、
 * routes/chat.ts 的 SessionOwnedByOther 同一模式：service 层只表达
 * 「哪一种失败」，翻译成状态码是调用方（route 层）的事。
 *
 * `kind` 区分两种互不相同的处置：
 * - "forbidden"：越权，调用方应当挡下（chat 路由目前翻成 403）
 * - "capacity"：容量已满，是运维信号而非客户端的错，调用方按 503 处理
 */
export class HarnessRegistryError extends Error {
  constructor(
    message: string,
    readonly kind: "forbidden" | "capacity",
  ) {
    super(message);
    this.name = "HarnessRegistryError";
  }
}

/** 空闲多久后回收。5 分钟：够覆盖「用户读完回答再追问」，又不会让内存长期挂着。 */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * 同时常驻的会话上限。
 *
 * 200 是单副本内部使用的估值，不是实测值：每个实例常驻的是一颗上下文树的引用，
 * 实际占用取决于会话长度。压测后按真实内存调整，调的时候同步改 spec §5。
 */
const DEFAULT_MAX_SESSIONS = 200;

interface Entry {
  harness: AgentHarness;
  session: Session;
  /** 有几个 SSE 连接正在用它。> 0 时不回收。 */
  refCount: number;
  lastUsedAt: number;
  /**
   * 是否正在跑一轮。
   *
   * AgentHarness.phase 是私有字段、没有 getter，所以只能自己跟：
   * agent_start 置真、settled 置假（settled 在 agent_end 之后发，且整个 run
   * 只发一次，followUp 排队的消息也在同一个 run 内，见 spec §2.3）。
   */
  running: boolean;
  /** 同一会话的调用串行化，避免「判断 running 时空闲、调用时已在跑」的竞态。 */
  chain: Promise<unknown>;
}

export interface HarnessHandle {
  harness: AgentHarness;
  session: Session;
  /** 空闲则 prompt，运行中则排进 followUp 队列。 */
  send(message: string): Promise<void>;
  /** 释放这个连接对实例的占用，允许它被回收。 */
  release(): void;
}

export interface HarnessRegistryOptions {
  db: Database;
  /**
   * 装配 harness。测试注入 faux provider + 内存 session。
   * 返回 session 而不是从 harness 上取：harness 不对外暴露自己的 session，
   * 而 registry 要把它交给调用方（读 transcript、投影历史）。
   */
  createHarness?: (sessionId: string) => Promise<{ harness: AgentHarness; session: Session }>;
  now?: () => number;
  idleTtlMs?: number;
  maxSessions?: number;
}

export function createHarnessRegistry(options: HarnessRegistryOptions) {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionRepo = createSessionRepository(db);
  const entries = new Map<string, Entry>();
  /**
   * 正在装配中的会话，key 是 sessionId。
   *
   * `entries.get` 判空 → `findById` → `build()` 之间都有 await 点，同一个
   * 尚未缓存的 sessionId 若被并发 acquire（重试、多标签页），两次都会看到
   * 缓存为空、各自 build 一个 harness——`entries.set` 只留下后者，前者成为
   * 孤儿实例但仍持有 session 引用，继续往同一份历史写，就是「会话意外分叉」。
   * 用这个 Map 去重：第二个请求直接 await 第一个的装配 promise，拿到同一个实例。
   */
  const building = new Map<string, Promise<Entry>>();

  /**
   * 惰性清理，不用 setInterval：定时器要管生命周期（测试里要 unref、进程退出要 clear），
   * 而清理只在 acquire 时才有意义——没有新请求时留着几个过期实例不造成问题。
   */
  function sweep(): void {
    for (const [sessionId, entry] of entries) {
      if (entry.refCount === 0 && !entry.running && now() - entry.lastUsedAt > idleTtlMs) {
        entries.delete(sessionId);
      }
    }
  }

  /** 容量到顶时淘汰最旧的空闲实例。@returns 是否腾出了位置 */
  function evictOldestIdle(): boolean {
    let oldest: [string, Entry] | undefined;
    for (const pair of entries) {
      const [, entry] = pair;
      if (entry.refCount > 0 || entry.running) continue;
      if (!oldest || entry.lastUsedAt < oldest[1].lastUsedAt) oldest = pair;
    }
    if (!oldest) return false;
    entries.delete(oldest[0]);
    return true;
  }

  async function build(sessionId: string, createdAt: Date, systemPrompt?: string): Promise<Entry> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : (() => {
          const session = createPgSession(db, sessionId, createdAt);
          // systemPrompt 只有这一次机会生效：AgentHarness 没有 setSystemPrompt()
          return { harness: createRealHarness({ session, systemPrompt }), session };
        })();
    const { harness, session } = built;

    const entry: Entry = {
      harness,
      session,
      refCount: 0,
      lastUsedAt: now(),
      running: false,
      chain: Promise.resolve(),
    };

    // 这一份订阅跟着实例活一辈子，与每个请求各自的 SSE 订阅无关。
    // listener 里只做同步赋值：pi 会 await listener 并把异常计入 run 的 settlement，
    // 抛异常会影响 agent 本身运行
    harness.subscribe((event) => {
      if (event.type === "agent_start") {
        entry.running = true;
      } else if (event.type === "settled") {
        entry.running = false;
        entry.lastUsedAt = now();
      }
    });

    return entry;
  }

  /**
   * 取（或装配）一个已通过归属校验的会话对应的 Entry。
   *
   * 归属校验（upsert）在调用方每次都做，不受这里的去重影响——两个不同用户
   * 撞同一个 sessionId 并发进来时，各自的 upsert 各跑一次，第二个该 403 还是
   * 403。这里去重的只是「装配」这一步：装配是幂等的（同一个 sessionId 应该
   * 只有一个 harness 实例），归属校验不是（谁调用、以谁的身份都要单独判）。
   */
  async function acquireEntry(sessionId: string, userId: string, systemPrompt?: string): Promise<Entry> {
    const cached = entries.get(sessionId);
    if (cached) return cached;

    const inFlight = building.get(sessionId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      if (entries.size >= maxSessions && !evictOldestIdle()) {
        logger.error({ sessionId, size: entries.size }, "harness registry at capacity");
        throw new HarnessRegistryError("服务繁忙，请稍后重试（会话容量已满）", "capacity");
      }
      const row = await sessionRepo.findById(sessionId, userId);
      const entry = await build(sessionId, row?.createdAt ?? new Date(), systemPrompt);
      entries.set(sessionId, entry);
      return entry;
    })();

    building.set(sessionId, promise);
    // 无论成功失败都要清掉：失败不清会让这个会话永久卡住（下次 acquire 会
    // await 一个已经 reject 的 promise）；成功则已经 entries.set 过，缓存
    // 命中会走上面的 cached 分支，不再需要 building 里的记录。
    promise.catch(() => undefined).finally(() => building.delete(sessionId));

    return promise;
  }

  /**
   * 降级用的一次性 handle：内存会话、不进缓存、不需要 running 标记与 chain
   * （它只服务当前这一个请求，不存在第二个请求撞上来的可能）。
   */
  async function ephemeral(sessionId: string, systemPrompt?: string): Promise<HarnessHandle> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : await (async () => {
          const session = await createMemorySession(sessionId);
          return { harness: createRealHarness({ session, systemPrompt }), session };
        })();
    return {
      harness: built.harness,
      session: built.session,
      send: (message) => built.harness.prompt(message).then(() => undefined),
      release: () => undefined,
    };
  }

  return {
    /**
     * 取一个会话的 harness。
     *
     * 归属校验就是这里的 upsert：会话 id 由前端生成，冲突且不属于自己时
     * DO UPDATE 不执行、returning 为空。**这一步必须在装配之前**——
     * 缓存 key 只有 sessionId，越权请求一旦走到装配就能拿到别人的活实例。
     */
    async acquire(
      sessionId: string,
      userId: string,
      firstMessage: string,
      systemPrompt?: string,
    ): Promise<HarnessHandle> {
      let owned: boolean;
      try {
        owned = await sessionRepo.upsert({
          id: sessionId,
          userId,
          title: buildTitle(firstMessage),
        });
      } catch (error) {
        // 注意与 owned === false 的区别：那是越权（必须 403），这是故障（可以降级）。
        // 降级实例不进缓存——它没有经过归属校验，留在 Map 里会被后续请求错误复用
        logger.error({ err: error, sessionId }, "session store unavailable, degrading to memory session");
        return ephemeral(sessionId, systemPrompt);
      }
      if (!owned) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }

      sweep();

      const entry = await acquireEntry(sessionId, userId, systemPrompt);
      const held = entry;
      held.refCount += 1;
      held.lastUsedAt = now();

      let released = false;
      return {
        harness: held.harness,
        session: held.session,
        /**
         * 空闲则 prompt，运行中则 followUp。
         *
         * chain 保护的临界区**只有「判断 running + 发起调用」**，绝不能把
         * 「等整轮跑完」也串进去：那样第二个请求会排在第一轮结束之后才发起，
         * 此时 running 已是 false，于是永远走 prompt，followUp 分支形同虚设。
         *
         * running 在发起 prompt 时**同步**置真，而不是等 agent_start 事件——
         * 事件是异步发出的，下一个请求完全可能在那之前就进到临界区。
         */
        send(message: string): Promise<void> {
          let outcome: Promise<void> | undefined;
          const started = held.chain.then(() => {
            if (held.running) {
              // followUp 只是 push 队列 + emit，是瞬时的，几乎立刻 resolve——
              // 但调用方（SSE 路由）需要等本轮真正结束才能收尾，否则并发的第二个
              // 连接会在自己那条消息还没被处理完时就关流。等 waitForIdle() 让
              // send() 的语义与 prompt 分支一致：都在整轮结束时才 resolve。
              // 它在 harness 内部 phase === "idle" 时会抛 invalid_state，而我们的 running
              // 与那个私有字段之间可能有一瞬不同步（比如上一轮刚好在这两句之间跑完），
              // 所以退回 prompt 而不是把错误抛给用户
              outcome = held.harness
                .followUp(message)
                .then(() => held.harness.waitForIdle())
                .catch((error) => {
                  logger.warn({ err: error, sessionId }, "followUp rejected, falling back to prompt");
                  held.running = true;
                  return held.harness
                    .prompt(message)
                    .then(() => undefined)
                    .finally(() => {
                      held.running = false;
                      held.lastUsedAt = now();
                    });
                });
              return outcome;
            }
            held.running = true;
            outcome = held.harness
              .prompt(message)
              .then(() => undefined)
              // settled 事件通常已经复位过；这里兜住「prompt 抛异常没走到 agent_end」
              // 的情况，否则这个会话会永远卡在 running=true，再也接不了新消息
              .finally(() => {
                held.running = false;
                held.lastUsedAt = now();
              });
            // 不 return outcome：chain 到此放行，下一个请求会看到 running=true
            return undefined;
          });
          held.chain = started.catch(() => undefined);
          return started.then(() => outcome);
        },
        release() {
          // 幂等：SSE 的正常收尾与 onAbort 都会调它
          if (released) return;
          released = true;
          held.refCount -= 1;
          held.lastUsedAt = now();
        },
      };
    },

    /** 显式停止。连接断开不再等于停止，所以这是唯一的中断入口。 */
    async abort(sessionId: string, userId: string): Promise<void> {
      if (!(await sessionRepo.findById(sessionId, userId))) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }
      // 没有活实例时什么都不做：abort 一个已经跑完的会话不是错误
      await entries.get(sessionId)?.harness.abort();
    },

    /** 会话被删除或用户被禁用时调用，否则内存里还有个活实例往已删会话写。 */
    async evict(sessionId: string): Promise<void> {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entries.delete(sessionId);
      await entry.harness.abort();
    },

    /** 仅供测试与监控。 */
    size(): number {
      return entries.size;
    },
  };
}

const TITLE_MAX_LENGTH = 30;
const FALLBACK_TITLE = "新对话";

/**
 * 标题取首条用户消息的前 30 字。与 services/session.ts 的 buildTitle 同源——
 * Task 9 会把 session.ts 的那份删掉，统一用这里的。
 */
function buildTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return FALLBACK_TITLE;
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}

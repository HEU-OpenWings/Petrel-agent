import type { AgentHarness, CompactionOutcome, CompactionState, Session } from "@petrel/agent";
import {
  createCompactionState,
  createMemorySession,
  createPgSession,
  createHarness as createRealHarness,
  DEFAULT_SYSTEM_PROMPT,
  maybeCompact,
  resolveModel,
} from "@petrel/agent";
import { env } from "@petrel/config";
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

/**
 * 压缩过程的可见信号。pi 只在压缩**结束**时发 session_compact（带摘要正文），
 * 「开始 / 失败 / 被守卫挡住」这三个信号它不给，只能我们自己发。
 */
export type HarnessNotice =
  | { phase: "start" }
  | { phase: "end"; outcome: CompactionOutcome }
  | { phase: "blocked"; reason: string };

/**
 * 追加给 pi 摘要提示词的 customInstructions。
 *
 * pi 库层已带一份完整的 7 段英文提示词（## Goal / ## Progress / ## Next Steps …），
 * 质量足够，这里只补「用中文」这一条要求，不接管整条摘要链路。
 */
const SUMMARY_INSTRUCTIONS = "用中文输出摘要；文件路径、函数名、错误信息原样保留不译。";

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
  /** 下一次新 run 使用的系统提示；before_agent_start hook 会读取它。 */
  systemPrompt: string;
  /** 当前 harness 对应的模型偏好；undefined 表示跟随系统默认。 */
  modelId: string | undefined;
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
  /**
   * 正在进行的压缩。非 undefined 即「正在压缩」。
   *
   * 一个字段三用：进临界区要 await 它、sweep()/evictOldestIdle() 视为忙、
   * abort()/evict() 靠它判断。不用额外的布尔量。
   */
  compaction: Promise<CompactionOutcome> | undefined;
  /** 抗抖动状态。跟随实例生命周期——实例被淘汰时状态跟着消失 */
  compactionState: CompactionState;
  /** 压缩期间收到 abort：压完之后不再发起新一轮 */
  abortRequested: boolean;
  /** 已被 evict（会话删除 / 用户禁用）：压完之后一律不再 prompt */
  retired: boolean;
}

/**
 * 装配 harness 时才用得上的选项。
 *
 * 两者都能在复用实例时更新：systemPrompt 由 `before_agent_start` hook
 * 在每个新 run 开始时注入，modelId 通过 `setModel()` 更新，见 `acquire()`。
 */
export interface HarnessAssemblyOptions {
  systemPrompt?: string;
  modelId?: string;
}

export interface SendOptions {
  /** 同步回调，调用方（SSE 路由）负责把它变成帧。绝不能在里面做网络 I/O */
  onNotice?: (notice: HarnessNotice) => void;
}

export interface HarnessHandle {
  harness: AgentHarness;
  session: Session;
  /** 空闲则（必要时先压缩再）prompt，运行中则排进 followUp 队列。 */
  send(message: string, options?: SendOptions): Promise<void>;
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
      // 压缩期间 running 是 false（compact() 不发 agent_start），只看 running
      // 会把正在压缩的实例回收掉，而压缩还在往它的树上写
      if (
        entry.refCount === 0 &&
        !entry.running &&
        !entry.compaction &&
        now() - entry.lastUsedAt > idleTtlMs
      ) {
        entries.delete(sessionId);
      }
    }
  }

  /** 容量到顶时淘汰最旧的空闲实例。@returns 是否腾出了位置 */
  function evictOldestIdle(): boolean {
    let oldest: [string, Entry] | undefined;
    for (const pair of entries) {
      const [, entry] = pair;
      if (entry.refCount > 0 || entry.running || entry.compaction) continue;
      if (!oldest || entry.lastUsedAt < oldest[1].lastUsedAt) oldest = pair;
    }
    if (!oldest) return false;
    entries.delete(oldest[0]);
    return true;
  }

  async function build(
    sessionId: string,
    createdAt: Date,
    assembly: HarnessAssemblyOptions = {},
  ): Promise<Entry> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : (() => {
          const session = createPgSession(db, sessionId, createdAt);
          // 首次装配先给初始值；缓存命中后的 systemPrompt 由 before_agent_start
          // hook 注入，modelId 通过 setModel() 更新，见 acquire()。
          return {
            harness: createRealHarness({
              session,
              systemPrompt: assembly.systemPrompt,
              modelId: assembly.modelId,
            }),
            session,
          };
        })();
    const { harness, session } = built;

    const entry: Entry = {
      harness,
      session,
      systemPrompt: assembly.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      modelId: assembly.modelId,
      refCount: 0,
      lastUsedAt: now(),
      running: false,
      chain: Promise.resolve(),
      compaction: undefined,
      compactionState: createCompactionState(),
      abortRequested: false,
      retired: false,
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
    // AgentHarness 没有 setSystemPrompt()，但这个 hook 会在每个新 run 开始时执行。
    // 读取 entry 上的可变值，让常驻实例复用时也能应用用户刚保存的偏好。
    harness.on("before_agent_start", () => ({ systemPrompt: entry.systemPrompt }));

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
  async function acquireEntry(
    sessionId: string,
    userId: string,
    assembly: HarnessAssemblyOptions = {},
  ): Promise<Entry> {
    const cached = entries.get(sessionId);
    if (cached) return cached;

    const inFlight = building.get(sessionId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      // building 里的实例已经占用了容量名额。不同 sessionId 的并发装配会在
      // 第一个 await 处交错；只看 entries.size 会让它们全部通过检查并突破上限。
      if (entries.size + building.size >= maxSessions && !evictOldestIdle()) {
        logger.error(
          { sessionId, size: entries.size, building: building.size },
          "harness registry at capacity",
        );
        throw new HarnessRegistryError("服务繁忙，请稍后重试（会话容量已满）", "capacity");
      }
      const row = await sessionRepo.findById(sessionId, userId);
      const entry = await build(sessionId, row?.createdAt ?? new Date(), assembly);
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
  async function ephemeral(sessionId: string, assembly: HarnessAssemblyOptions = {}): Promise<HarnessHandle> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : await (async () => {
          const session = await createMemorySession(sessionId);
          return {
            harness: createRealHarness({
              session,
              systemPrompt: assembly.systemPrompt,
              modelId: assembly.modelId,
            }),
            session,
          };
        })();
    return {
      harness: built.harness,
      session: built.session,
      // 降级实例不压缩：它是一次性内存会话，没有历史可压
      send: (message: string) => built.harness.prompt(message).then(() => undefined),
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
      assembly: HarnessAssemblyOptions = {},
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
        return ephemeral(sessionId, assembly);
      }
      if (!owned) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }

      sweep();

      const entry = await acquireEntry(sessionId, userId, assembly);
      const held = entry;
      held.refCount += 1;
      held.lastUsedAt = now();

      // systemPrompt 由 before_agent_start hook 在下一次新 run 开始时读取。
      // 当前正在跑时这里只更新下一轮的值，不会改变已开始的 run（含 followUp）。
      held.systemPrompt = assembly.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

      // 复用已有实例时按请求里的 modelId 换模型。undefined 也是一个明确状态：
      // 表示用户清空了显式选择、恢复系统默认，不能直接跳过。
      //
      // 只在确实变化时调：setModel 会往会话树写一条 model_change 条目，
      // 每轮无脑调会写一堆无用条目。
      // 正在跑时跳过：当轮（含 followUp 排队的消息）已经在用旧模型了。
      if (!held.running && held.modelId !== assembly.modelId) {
        const desired = resolveModel({ modelId: assembly.modelId });
        await held.harness.setModel(desired);
        held.modelId = assembly.modelId;
      }

      let released = false;
      return {
        harness: held.harness,
        session: held.session,
        /**
         * 空闲则（必要时先压缩再）prompt，运行中则 followUp。
         *
         * chain 保护的临界区**只有「判断 running/compaction + 发起调用」**，绝不能把
         * 「等整轮跑完」也串进去：那样第二个请求会排在第一轮结束之后才发起，
         * 此时 running 已是 false，于是永远走 prompt，followUp 分支形同虚设。
         * 压缩分支同理——held.compaction 必须在设值后立刻放行 chain，不能等
         * compact() 跑完才放行，否则几乎同时到达的第三个请求排进 chain 时
         * 压缩早已结束、看不到「正在压缩」这个事实。
         *
         * running 在发起 prompt 时**同步**置真，而不是等 agent_start 事件——
         * 事件是异步发出的，下一个请求完全可能在那之前就进到临界区。
         */
        send(message: string, options: SendOptions = {}): Promise<void> {
          const notify = options.onNotice ?? (() => undefined);
          let outcome: Promise<void> | undefined;
          // 同步读：我如果是「等待者」，先给个解释，别让前端看起来卡死
          if (held.compaction) notify({ phase: "start" });

          const started = held.chain.then(async () => {
            // 压缩的互斥不靠 chain：chain 在发起 prompt 之后就放行了，
            // 而 (d) 兜底的补救压缩发生在 prompt 之后、running 已复位为 false，
            // 那时第二个请求会径直走到下面自己再压一次，两个 compact() 撞在一起
            // 后者必抛 busy
            if (held.compaction) {
              notify({ phase: "start" }); // 上面那次同步读可能早于第一个请求设值
              await held.compaction.catch(() => undefined);
            }
            if (held.retired) {
              throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
            }
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
              // 只等 followUp 完成入队，不把 waitForIdle 串进 held.chain；否则第三个
              // 并发请求会等整轮结束后才进入临界区，无法加入当前 run。
              return undefined;
            }

            // 超阈值就先压。与 running+outcome 同一个模式：把 held.compaction
            // 赋值成「正在进行」的 promise 后立刻从 chain 里放行，绝不在这里
            // await 它——否则 chain 要等整个压缩跑完才放行，第三个几乎同时到达
            // 的请求就看不到「压缩正在进行」这个事实（等它排进 chain 时压缩
            // 早已经结束、held.compaction 已被清空），补发通知与排队等待都落空
            const compactionPromise = maybeCompact(
              held.harness,
              held.session,
              held.compactionState,
              { ...env.compaction, summaryInstructions: SUMMARY_INSTRUCTIONS },
              { pendingMessage: message, onPhase: () => notify({ phase: "start" }) },
            );
            held.compaction = compactionPromise;
            outcome = compactionPromise
              .catch(
                (error: unknown): CompactionOutcome => ({
                  kind: "failed",
                  error: error instanceof Error ? error : new Error(String(error)),
                }),
              )
              .then((compaction) => {
                held.compaction = undefined;
                held.lastUsedAt = now();
                if (compaction.kind === "skipped" && compaction.overThreshold) {
                  // 守卫挡住了、但阈值确实超了：必须告警。不告警的后果是上下文一路
                  // 静默涨到模型窗口硬墙，用户只看到「回答突然开始报错」
                  notify({ phase: "blocked", reason: compaction.reason });
                } else if (compaction.kind !== "skipped") {
                  // 低于阈值时完全静默：绝大多数请求都走那条路，发通知等于每轮都在前端闪一下
                  notify({ phase: "end", outcome: compaction });
                }
                if (compaction.kind === "failed") {
                  // 压缩失败不阻断本轮：阈值是 80%，还有余量；真超了会落到 (d)
                  logger.warn({ err: compaction.error, sessionId }, "自动压缩失败，本轮照常继续");
                }
                if (held.abortRequested || held.retired) {
                  held.abortRequested = false;
                  return undefined;
                }

                held.running = true;
                return (
                  held.harness
                    .prompt(message)
                    .then(() => undefined)
                    // settled 事件通常已经复位过；这里兜住「prompt 抛异常没走到 agent_end」
                    // 的情况，否则这个会话会永远卡在 running=true，再也接不了新消息
                    .finally(() => {
                      held.running = false;
                      held.lastUsedAt = now();
                    })
                );
              });
            // 不 return outcome：chain 到此放行，下一个请求会看到 compaction 已置真
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
      const entry = entries.get(sessionId);
      if (!entry) return;
      // pi 的 compact() 内部 signal 是 new AbortController().signal，永远不会被 abort，
      // 所以压缩本身停不下来。能保证的是「压完不再发起新一轮」——不加这一句，
      // 用户点了停止却照样跑一轮
      if (entry.compaction) entry.abortRequested = true;
      await entry.harness.abort();
    },

    /**
     * 会话被删除或用户被禁用时调用，否则内存里还有个活实例往已删会话写。
     *
     * 顺序有讲究：先置 retired（让 send() 的临界区在压缩结束后拒绝发起 prompt），
     * 再摘除 Map（不让新请求复用），最后等压缩落地。
     *
     * pi 的压缩不可取消，所以这里只能等它自己跑完；等的过程中的任何错误都吞掉——
     * 会话行已经删了，`session_entries.session_id` 是 cascade，appendCompaction
     * 必然撞外键约束，那不是调用方需要知道的失败。
     */
    async evict(sessionId: string): Promise<void> {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.retired = true;
      entries.delete(sessionId);
      if (entry.compaction) {
        await entry.compaction.catch((error: unknown) => {
          logger.warn({ err: error, sessionId }, "会话已被 evict，进行中的压缩以失败收场");
          return undefined;
        });
      }
      await entry.harness.abort();
    },

    /** 仅供测试与监控。 */
    size(): number {
      return entries.size;
    },

    /**
     * 仅供测试：拿到某个会话的抗抖动状态，用来把它推到「已连续两次无效压缩」
     * 那个分支。没有别的办法——那份状态刻意跟随实例生命周期（放全局 Map 会
     * 泄漏到已淘汰的会话），而 Entry 本身不对外暴露。
     */
    __stateForTest(sessionId: string): CompactionState | undefined {
      return entries.get(sessionId)?.compactionState;
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

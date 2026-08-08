import type {
  AgentHarness,
  CompactionOutcome,
  CompactionPolicy,
  CompactionState,
  ContextUsage,
  Session,
} from "@petrel/agent";
import {
  createCompactionState,
  createMemorySession,
  createPgSession,
  createHarness as createRealHarness,
  DEFAULT_SYSTEM_PROMPT,
  inspectContext,
  isContextOverflow,
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
 * `kind` 区分三种互不相同的处置：
 * - "forbidden"：越权，调用方应当挡下（chat 路由目前翻成 403）
 * - "capacity"：容量已满，是运维信号而非客户端的错，调用方按 503 处理
 * - "busy"：会话正在生成回答，手动压缩此刻做不了（pi 的 compact() 要求 idle），
 *   重试即可成功，调用方按 409 处理
 */
export class HarnessRegistryError extends Error {
  constructor(
    message: string,
    readonly kind: "forbidden" | "capacity" | "busy",
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

/**
 * (d) overflow 兜底的用户文案。
 *
 * 必须按压缩结果分支。无条件说「已压缩，请重发」会在几种情况下形成死循环：
 * 用户重发 → 又爆窗 → 又被告知已压缩。
 *
 * 真实的死循环条件不是「压缩没成功」，而是**压缩成功了、但上下文仍然超窗口**——
 * 典型场景是单条消息本身就大到超过模型窗口：retainedTail 必然保留「即将 prompt
 * 的这条消息」（compact() 不会砍掉最新的一轮），压完 tokensAfter 依然 > contextWindow，
 * 提示「已压缩请重发」只会让用户对着同一条巨型消息再爆一次窗。所以 compacted 分支
 * 要用 outcome.contextWindow 再判一次「压完还超不超窗口」，不能看到 kind:"compacted"
 * 就直接报「已压缩」。这一判断依赖 tokensAfter 是**纯字符估算**（见
 * CompactionOutcome 上的注释）：换成 usage-based 的数就会因为 retainedTail 里那条
 * 压缩前的旧 usage 而恒真，两条文案正好互换。
 *
 * nothing-to-compact 分支在这条 (d) 路径上并入下面的通用 skip 文案（不单独分支）：
 * pi 的 `Nothing to compact` 只在 `prepareCompaction` 发现分支最后一条已经是
 * compaction 条目时抛出（`agent-harness.js:653`、`compaction.js:430`），意思是
 * 「上次压缩后再没写过任何东西」；而 (d) 的补救压缩必然发生在 `harness.prompt()`
 * 已经把这一轮的 user/assistant 消息追加进会话树之后，两个条件互斥——补救压缩
 * 永远看不到「最后一条是 compaction」这个前提，所以这个 skip 原因经由这条路径
 * 不可达。保留判断分支只是徒增一个测不到的分叉，故与 ineffective/cooldown 等
 * 一起归到通用 skip 文案；不是漏写，是这条路径下不可能发生。
 */
function overflowMessage(outcome: CompactionOutcome): string {
  if (outcome.kind === "compacted") {
    if (outcome.tokensAfter > outcome.contextWindow) {
      return "单条消息或单轮内容超出模型窗口，压缩无法解决。请缩短输入或换用更大窗口的模型";
    }
    return "上下文超出模型窗口，已自动压缩历史，请重新发送刚才那条消息";
  }
  if (outcome.kind === "failed") {
    // 原始 error 不进这条文案：provider SDK 的报错可能带限流阈值、区域信息，
    // 个别 SDK 甚至会回显请求 id 或 key 片段——那不是用户该看到的东西。
    // 原始 error 只进日志，见调用点 logger.warn(...)。
    return "上下文超出模型窗口，且自动压缩失败。请新建会话继续";
  }
  if (outcome.reason === "disabled") {
    // COMPACTION_ENABLED=false 时 force 也不再穿透（总开关优先于守卫），
    // 所以这条路径是可达的：得说清是被关掉了，而不是「压不动了」
    return "上下文超出模型窗口，而自动压缩已关闭。请新建会话继续";
  }
  return "上下文超出模型窗口，压缩已无法再回收空间。请新建会话继续";
}

/**
 * maybeCompact() 自己已经把摘要失败收敛成 `kind: "failed"`，但它之前还有
 * buildContext() 等几个 await 点，那里抛出来的仍是裸异常。手动压缩要把结果
 * 作为 HTTP 响应体回给用户，不能让这类异常变成 500。
 */
function toFailedOutcome(error: unknown): CompactionOutcome {
  return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
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
  /**
   * 持久化状态。HEU-40 配额 fail-closed：memory 降级时（会话表故障），
   * usage 双写不会落库，chat 路由据此拒绝调用模型，而不是「能聊但不计量」。
   */
  persistence: "postgres" | "memory";
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
  /**
   * 压缩策略，默认取 `env.compaction`。
   *
   * 存在的理由是可测性：直读全局 env 的话，「总开关关掉后端到端会怎样」这条
   * 路径在测试里根本构造不出来（改进程 env 会影响同一进程里的其他用例）。
   */
  compaction?: Omit<CompactionPolicy, "summaryInstructions">;
}

export function createHarnessRegistry(options: HarnessRegistryOptions) {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const compactionPolicy: CompactionPolicy = {
    ...(options.compaction ?? env.compaction),
    summaryInstructions: SUMMARY_INSTRUCTIONS,
  };
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
    userId: string,
    createdAt: Date,
    assembly: HarnessAssemblyOptions = {},
  ): Promise<Entry> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : (() => {
          const session = createPgSession(db, sessionId, createdAt, userId);
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
      const entry = await build(sessionId, userId, row?.createdAt ?? new Date(), assembly);
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
      // 降级实例是内存会话，usage 不落库——chat 路由据此 fail-closed 拒绝
      persistence: "memory",
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

      async function applyAssembly(): Promise<void> {
        held.systemPrompt = assembly.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
        if (held.modelId === assembly.modelId) return;
        const desired = resolveModel({ modelId: assembly.modelId });
        await held.harness.setModel(desired);
        held.modelId = assembly.modelId;
      }

      // 保留 acquire() 原有的「空闲实例立即反映模型偏好」契约，但也纳入 chain：
      // 不串行的话，setModel() 内部写 session 的 await 会与刚发起的 send() 交错。
      // 已在运行/压缩时不碰共享配置，交给这个 handle 自己的 send() 在空闲后应用。
      const configured = held.chain.then(async () => {
        if (!held.running && !held.compaction) await applyAssembly();
      });
      held.chain = configured.catch(() => undefined);
      await configured;

      let released = false;
      return {
        harness: held.harness,
        session: held.session,
        persistence: "postgres",
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
          let waitingNoticeStarted = false;
          // 同步读：我如果是「等待者」，先给个解释，别让前端看起来卡死
          if (held.compaction) {
            notify({ phase: "start" });
            waitingNoticeStarted = true;
          }

          const started = held.chain.then(async () => {
            // 压缩的互斥不靠 chain：chain 在发起 prompt 之后就放行了，
            // 而 (d) 兜底的补救压缩发生在 prompt 之后、running 已复位为 false，
            // 那时第二个请求会径直走到下面自己再压一次，两个 compact() 撞在一起
            // 后者必抛 busy
            if (held.compaction) {
              if (!waitingNoticeStarted) {
                notify({ phase: "start" }); // 上面那次同步读可能早于第一个请求设值
                waitingNoticeStarted = true;
              }
              const activeCompaction = held.compaction;
              const waitedOutcome = await activeCompaction.catch(
                (error: unknown): CompactionOutcome => ({
                  kind: "failed",
                  error: error instanceof Error ? error : new Error(String(error)),
                }),
              );
              // 等待者自己不会收到发起者 onNotice 的 end；既然上面给它发过 start，
              // 这里必须配对收尾，否则前端会把「正在压缩」保持到整轮回答结束。
              notify({ phase: "end", outcome: waitedOutcome });
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

            // 请求配置必须在它自己的临界区里应用。若在 acquire() 时直接改共享
            // Entry，预压缩期间到达的第二个 acquire 会在第一轮真正 prompt 之前
            // 覆盖 systemPrompt / model，导致先到请求使用后到请求的配置。
            await applyAssembly();

            // 超阈值就先压。与 running+outcome 同一个模式：把 held.compaction
            // 赋值成「正在进行」的 promise 后立刻从 chain 里放行，绝不在这里
            // await 它——否则 chain 要等整个压缩跑完才放行，第三个几乎同时到达
            // 的请求就看不到「压缩正在进行」这个事实（等它排进 chain 时压缩
            // 早已经结束、held.compaction 已被清空），补发通知与排队等待都落空
            const compactionPromise = maybeCompact(
              held.harness,
              held.session,
              held.compactionState,
              compactionPolicy,
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
                    .then(async (result) => {
                      // pi 模型调用失败不抛异常也不发 error 事件，原因写在 assistant
                      // 消息的 errorMessage 里（CLAUDE.md 硬约束第 3 条），所以检测点在这
                      if (!isContextOverflow(held.harness, result)) return;
                      // evict() 可能正好落在 prompt() resolve 与下面那行赋值之间：
                      // 那一瞬 entry.compaction 是 undefined，evict() 不等待就返回，
                      // 而这里再发起压缩就会往已删会话的树上写，撞 session_entries
                      // 的 cascade 外键——正是 Task 8 要消灭的那批不指向根因的报错。
                      // 顺带省掉一次注定要白扔的摘要调用
                      if (held.retired) return;
                      const recoveryPromise = maybeCompact(
                        held.harness,
                        held.session,
                        held.compactionState,
                        compactionPolicy,
                        { force: true },
                      );
                      held.compaction = recoveryPromise;
                      const recovery = await recoveryPromise.catch(
                        (error: unknown): CompactionOutcome => ({
                          kind: "failed",
                          error: error instanceof Error ? error : new Error(String(error)),
                        }),
                      );
                      held.compaction = undefined;
                      // abort() 只要看到 compaction 非空就置位，而唯一的消费点在
                      // 上面 pre-prompt 那个分支。落在这段补救压缩期间的置位没人兑现，
                      // 会一直挂在实例上，等到用户下一次 send() 时命中——那一轮
                      // 不 prompt、不报错、SSE 空流关闭，用户这条消息静默消失
                      // （CLAUDE.md 硬约束 8 点名的那类故障）。本轮已经在结束的路上，
                      // 这个请求不需要它，直接清掉
                      held.abortRequested = false;
                      notify({ phase: "end", outcome: recovery });
                      if (recovery.kind === "failed") {
                        // 原始 error 只进日志：overflowMessage() 给用户的文案里不带
                        // error.message，provider SDK 的报错可能含限流阈值/区域信息
                        // 等内部细节
                        logger.warn({ err: recovery.error, sessionId }, "overflow 兜底压缩失败");
                      }
                      // 不自动重发：pi 在 prompt() 时已把 user message 落进会话树，
                      // 重发会在树里留下两条一样的 user 消息，前端出现重复气泡
                      throw new Error(overflowMessage(recovery));
                    })
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
     * 手动压缩（前端 `/compact` 命令）。
     *
     * 与自动压缩共用 `held.compaction` 这条互斥 promise——两者都调 pi 的
     * `compact()`，撞在一起后者必抛 busy。已经有压缩在跑时不再发起第二次，
     * 而是 await 同一条 promise 并返回它的结果：用户敲命令的那一刻正好有一次
     * 自动压缩在跑，他要的「压一下」已经在发生了。
     *
     * force: true——手动命令的语义就是「我说压就压」，不再看阈值与抗抖动守卫。
     * 但总开关（COMPACTION_ENABLED）依然优先，此时返回 skipped/disabled。
     *
     * 归属校验用 findById 而不是 upsert（同 abort()）：手动命令面对的一定是
     * 已经存在的会话，不该顺手把一个空会话建出来。
     */
    async compact(sessionId: string, userId: string): Promise<CompactionOutcome> {
      if (!(await sessionRepo.findById(sessionId, userId))) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }
      sweep();
      const held = await acquireEntry(sessionId, userId);
      held.lastUsedAt = now();

      // 临界区只包「判断状态 + 发起压缩」，随后立刻放行 chain：真正的等待在
      // 它外面。串进 chain 的话，压缩期间到达的对话请求要等这次压缩彻底跑完
      // 才能进临界区，也就看不到 held.compaction 非空这个事实（同 send() 的注释）
      //
      // 结果用 { outcome } 包一层再返回：直接返回裸 promise 的话 started 会
      // 采纳（adopt）它，要等压缩跑完才 settle，chain 也就跟着卡到那时候，
      // 恰好毁掉上面说的那条性质
      const started = held.chain.then(async (): Promise<{ outcome: Promise<CompactionOutcome> }> => {
        if (held.compaction) return { outcome: held.compaction.catch(toFailedOutcome) };
        if (held.retired) {
          throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
        }
        if (held.running) {
          throw new HarnessRegistryError("正在生成回答，请先停止本轮或稍后再试", "busy");
        }
        const promise = maybeCompact(held.harness, held.session, held.compactionState, compactionPolicy, {
          force: true,
        });
        held.compaction = promise;
        return {
          outcome: promise.catch(toFailedOutcome).then((outcome) => {
            held.compaction = undefined;
            held.lastUsedAt = now();
            return outcome;
          }),
        };
      });
      held.chain = started.catch(() => undefined);
      return (await started).outcome;
    },

    /** 当前上下文占用（前端 `/context` 命令）。只读，不进 chain。 */
    async inspect(sessionId: string, userId: string): Promise<ContextUsage> {
      if (!(await sessionRepo.findById(sessionId, userId))) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }
      sweep();
      // 没有常驻实例时会装配一个，用的是系统默认模型——contextWindow 可能与用户
      // 偏好的模型不同。命令是个粗略的量度，不值得为它把偏好读进 registry
      const entry = await acquireEntry(sessionId, userId);
      entry.lastUsedAt = now();
      return inspectContext(entry.harness, entry.session, compactionPolicy);
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

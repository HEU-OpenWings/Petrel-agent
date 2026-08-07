import {
  type AgentHarness,
  AgentHarnessError,
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  type Session,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isContextOverflow as piIsContextOverflow } from "@earendil-works/pi-ai";

/**
 * 阈值策略。
 *
 * 刻意不复用 pi 的 shouldCompact()：它是 `tokens > window - settings.reserveTokens`，
 * 要用就得伪造一个 { enabled, reserveTokens: 0, keepRecentTokens: 0 } 的假 settings，
 * 比自己写一行比较更难读。
 */
export interface CompactionPolicy {
  enabled: boolean;
  /** 占模型 contextWindow 的比例，0 < ratio < 1 */
  thresholdRatio: number;
  /** 绝对上限，控成本与延迟 */
  absoluteCap: number;
  /** 追加给 pi 摘要提示词的 customInstructions（拼成 `Additional focus: ...`） */
  summaryInstructions?: string;
}

export type CompactionSkipReason =
  | "disabled"
  | "below-threshold"
  | "nothing-to-compact"
  | "cooldown"
  | "ineffective";

export type CompactionOutcome =
  | { kind: "skipped"; reason: CompactionSkipReason; overThreshold: boolean }
  | {
      kind: "compacted";
      /** usage-based 估算，pi 自己报的压缩前 token 数，给埋点与前端展示 */
      tokensBefore: number;
      /**
       * 压缩后的 token 数，**只能是纯字符估算**。
       *
       * 不能用 estimateContextTokens：它取「最后一条非 error assistant 的真实
       * usage + 其后消息的字符估算」，而压缩后 retainedTail 里留着的正是压缩前
       * 那条 assistant，它的 usage 反映的是压缩前的完整上下文。采信它算出的
       * 「压缩后」几乎等于压缩前——调用方拿它判「压完还超不超窗口」会得到恒真的
       * 结论（(d) 兜底的两条文案因此互换），前端也会显示「90000 → 90000」。
       * 这与 estimateForDecision() 防的是同一个 stale-usage 陷阱。
       */
      tokensAfter: number;
      /**
       * 与 `tokensAfter` 同口径的压缩前估算，只给 ineffective 守卫用（Task 4）。
       *
       * `tokensBefore` 是 usage-based 的（含 provider 计入的 system prompt 等固定
       * 开销），拿它跟纯字符估算的 `tokensAfter` 相减会系统性高估回收比例，让守卫
       * 永远不触发。详见
       * docs/superpowers/specs/2026-08-05-auto-compaction-design.md §8.1.3。
       */
      pureBefore: number;
      /**
       * 压缩发生时的模型窗口。调用方要判断「压完还超不超窗口」（单条消息本身就
       * 超窗口，压缩救不了）就需要这个数，而 apps/server 不许碰 pi 的 Model 类型——
       * 策略层本来就读了 harness.getModel().contextWindow 来算阈值，顺手带出去
       * 是最诚实的做法，不用再让调用方另外传一遍。
       */
      contextWindow: number;
    }
  | { kind: "failed"; error: Error };

/**
 * 抗抖动状态。由调用方持有（registry 的 Entry），生命周期必须与 harness 实例严格一致：
 * 放在本模块的全局 Map 里会泄漏到已被淘汰的会话。
 */
export interface CompactionState {
  /** 冷却截止时间戳（毫秒）；0 表示不在冷却中 */
  cooldownUntil: number;
  /** 连续「回收不足 10%」的次数 */
  ineffectiveStreak: number;
}

export function createCompactionState(): CompactionState {
  return { cooldownUntil: 0, ineffectiveStreak: 0 };
}

/**
 * 摘要失败后的冷却时长。
 *
 * Hermes 用 600s，我们取 60s：harness 实例本身 5 分钟就被 idle TTL 回收、
 * 状态跟着消失，太长的冷却在这里没有意义，60s 足够躲过一波限流。
 */
const COOLDOWN_MS = 60_000;

/** 连续多少次「回收不足 REQUIRED_RECLAIM_RATIO」后停止自动压缩 */
const INEFFECTIVE_LIMIT = 2;

/** 一次压缩至少要回收掉这么大比例才算有效 */
const REQUIRED_RECLAIM_RATIO = 0.1;

/**
 * 判定用的 token 数。
 *
 * estimateContextTokens 取「最后一条 assistant 的真实 usage + 之后消息的字符估算」，
 * 但压缩后 retainedTail 里的旧 assistant 消息带的是压缩前的 usage，采信它就会
 * 刚压完又判超阈值。所以：提供 usage 的那条消息若早于最近一条 compaction 条目，
 * 整个 usage 分量作废，退回纯字符估算。
 *
 * 比 pi CLI 的「直接不压」更准——纯估算下 retainedTail 本身就超阈值的情况真实存在，
 * 那种时候应该压。
 */
async function estimateForDecision(session: Session, messages: AgentMessage[]): Promise<number> {
  const estimate = estimateContextTokens(messages);
  if (estimate.lastUsageIndex === null) return estimate.tokens;

  const compactions = await session.getStorage().findEntries("compaction");
  const latest = compactions.at(-1);
  if (!latest) return estimate.tokens;

  // noUncheckedIndexedAccess 要求的边界检查，不是给 union 类型做防御：
  // lastUsageIndex 来自 estimateContextTokens 自己的返回值，必然落在 messages 范围内。
  const usageMessage = messages[estimate.lastUsageIndex];
  if (!usageMessage) return estimate.tokens;
  if (usageMessage.timestamp > Date.parse(latest.timestamp)) return estimate.tokens;

  return pureEstimate(messages);
}

export interface MaybeCompactOptions {
  /**
   * 本轮即将 prompt 的用户消息。
   *
   * 必须算进阈值：判定发生在 harness.prompt() 之前，这条消息还没进会话树，
   * buildContext() 里看不到它。漏算会把一整类可以在请求前避免的爆窗推到 (d)。
   */
  pendingMessage?: string;
  /** (d) overflow 兜底：无视阈值与 cooldown */
  force?: boolean;
  /**
   * 同步生命周期回调。只在阈值判定通过、即将调 harness.compact() 时发 "start"——
   * 提前发的话每个低于阈值的普通请求都会在前端闪一次「正在压缩」。
   */
  onPhase?: (phase: "start") => void;
}

/**
 * 「没东西可压」的识别。
 *
 * 只能靠 message 文本匹配：pi 抛的是 AgentHarnessError("compaction", "Nothing to compact")，
 * 而 code "compaction" 同时覆盖真正的摘要失败，光看 code 分不开两者
 * （`agent-harness.js:654`）。pi 升级时这条要重新核对。
 */
function isNothingToCompact(error: unknown): boolean {
  return error instanceof AgentHarnessError && error.message === "Nothing to compact";
}

/** 纯字符估算，绕开 provider usage。压缩前后要用同一种口径比较，见 Task 4 */
function pureEstimate(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** 待发消息折成一条 user 消息来估算，口径与历史消息一致 */
function pendingTokens(pendingMessage: string | undefined): number {
  if (!pendingMessage) return 0;
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text: pendingMessage }],
    timestamp: Date.now(),
  });
}

export function effectiveWindow(contextWindow: number, policy: CompactionPolicy): number {
  return Math.min(contextWindow * policy.thresholdRatio, policy.absoluteCap);
}

/** `/context` 命令要展示的三个数，口径与 maybeCompact 的阈值判定完全一致 */
export interface ContextUsage {
  /** 当前上下文的 token 估算，与阈值判定同口径（见 estimateForDecision） */
  tokens: number;
  /** 超过它就会触发自动压缩 */
  threshold: number;
  contextWindow: number;
}

/**
 * 只读地报告当前上下文占用。不改任何状态，因此不需要 harness 处于 idle。
 *
 * 必须走 estimateForDecision 而不是 pi 的 estimateContextTokens：后者在压缩后会
 * 采信 retainedTail 里那条压缩前 assistant 的 usage，用户压完再看 `/context`
 * 会发现数字纹丝不动（CLAUDE.md 坑 19）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function inspectContext(
  harness: AgentHarness<any>,
  session: Session,
  policy: CompactionPolicy,
): Promise<ContextUsage> {
  const context = await session.buildContext();
  const contextWindow = harness.getModel().contextWindow;
  return {
    tokens: await estimateForDecision(session, context.messages),
    threshold: effectiveWindow(contextWindow, policy),
    contextWindow,
  };
}

/**
 * 超阈值就压缩，否则原样返回。**要求 harness 处于 idle**——pi 的 compact() 会检查
 * phase，并发保护由调用方负责（见 harness-registry 的 Entry.compaction）。
 */
export async function maybeCompact(
  harness: AgentHarness<any>,
  session: Session,
  state: CompactionState,
  policy: CompactionPolicy,
  options: MaybeCompactOptions,
): Promise<CompactionOutcome> {
  // 总开关关掉就是彻底关掉，(d) 兜底的 force 也不例外：它同样要发一次摘要请求、
  // 往会话树写一条 compaction 条目，而那正是运维关掉这个键时想停掉的东西。
  // 代价是关掉之后撞窗口的会话只能收到「压缩已关闭」的提示、自己新建会话。
  if (!policy.enabled) {
    return { kind: "skipped", reason: "disabled", overThreshold: false };
  }

  const context = await session.buildContext();
  const messages = context.messages;
  const tokens = (await estimateForDecision(session, messages)) + pendingTokens(options.pendingMessage);
  const limit = effectiveWindow(harness.getModel().contextWindow, policy);
  const overThreshold = tokens > limit;

  if (!overThreshold && !options.force) {
    return { kind: "skipped", reason: "below-threshold", overThreshold: false };
  }

  // 下面两道守卫只挡主动压缩。(d) 兜底（force）时上下文已经真的爆了，
  // 挡住它只会让用户彻底没救
  if (!options.force) {
    if (Date.now() < state.cooldownUntil) {
      return { kind: "skipped", reason: "cooldown", overThreshold };
    }
    if (state.ineffectiveStreak >= INEFFECTIVE_LIMIT) {
      return { kind: "skipped", reason: "ineffective", overThreshold };
    }
  }

  options.onPhase?.("start");
  const pureBefore = pureEstimate(messages);
  try {
    const result = await harness.compact(policy.summaryInstructions);
    const after = await session.buildContext();
    const tokensAfter = pureEstimate(after.messages);
    // 同口径比较。混用 usage-based 的 tokensBefore 与纯估算的 tokensAfter
    // 会系统性高估回收比例，这道守卫就永远不触发
    const reclaimed = pureBefore > 0 ? (pureBefore - tokensAfter) / pureBefore : 0;
    state.ineffectiveStreak = reclaimed < REQUIRED_RECLAIM_RATIO ? state.ineffectiveStreak + 1 : 0;
    return {
      kind: "compacted",
      tokensBefore: result.tokensBefore,
      tokensAfter,
      pureBefore,
      contextWindow: harness.getModel().contextWindow,
    };
  } catch (error) {
    if (isNothingToCompact(error)) {
      // 正常结果，不设冷却
      return { kind: "skipped", reason: "nothing-to-compact", overThreshold };
    }
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * 这条 assistant 消息是不是撞了模型的上下文窗口？
 *
 * 判定全部委托给 pi-ai 的同名函数：它维护着 25 条正则（22 条 provider 专用 + 3 条通用兜底）、一张
 * 「非溢出」排除表（限流/429 会命中 /too many tokens/ 这类溢出模式，必须排除），
 * 还覆盖静默溢出（provider 照常返回 stop，但 input+cacheRead 超窗口）与
 * length-stop 溢出（input 填满窗口导致 output 为 0）两种我们自己判不出来的情况。
 * 自己手搓关键词表的话，最先踩的就是「把限流当成溢出、白压一次还给用户错误提示」。
 *
 * 本函数存在的唯一理由是签名适配：吃 harness 而不是 contextWindow，
 * 让 apps/server 不必碰 pi 的 Model 类型（依赖方向 server → agent，
 * pi 接线只在 agent 与 ai）。
 */
export function isContextOverflow(harness: AgentHarness<any>, message: AssistantMessage): boolean {
  return piIsContextOverflow(message, harness.getModel().contextWindow);
}

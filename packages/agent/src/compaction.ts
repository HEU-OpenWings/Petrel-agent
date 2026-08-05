import {
  type AgentHarness,
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  type Session,
} from "@earendil-works/pi-agent-core";

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
      /** usage-based 估算，给埋点与前端展示 */
      tokensBefore: number;
      tokensAfter: number;
      /** 纯字符估算，只给 ineffective 守卫用，见 Task 4 的注释 */
      pureBefore: number;
      pureAfter: number;
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
  } as AgentMessage);
}

export function effectiveWindow(contextWindow: number, policy: CompactionPolicy): number {
  return Math.min(contextWindow * policy.thresholdRatio, policy.absoluteCap);
}

/**
 * 超阈值就压缩，否则原样返回。**要求 harness 处于 idle**——pi 的 compact() 会检查
 * phase，并发保护由调用方负责（见 harness-registry 的 Entry.compaction）。
 */
export async function maybeCompact(
  harness: AgentHarness,
  session: Session,
  _state: CompactionState,
  policy: CompactionPolicy,
  options: MaybeCompactOptions,
): Promise<CompactionOutcome> {
  if (!policy.enabled && !options.force) {
    return { kind: "skipped", reason: "disabled", overThreshold: false };
  }

  const context = await session.buildContext();
  const messages = context.messages;
  const tokens = estimateContextTokens(messages).tokens + pendingTokens(options.pendingMessage);
  const limit = effectiveWindow(harness.getModel().contextWindow, policy);
  const overThreshold = tokens > limit;

  if (!overThreshold && !options.force) {
    return { kind: "skipped", reason: "below-threshold", overThreshold: false };
  }

  options.onPhase?.("start");
  const pureBefore = pureEstimate(messages);
  const result = await harness.compact(policy.summaryInstructions);
  const after = await session.buildContext();
  return {
    kind: "compacted",
    tokensBefore: result.tokensBefore,
    tokensAfter: estimateContextTokens(after.messages).tokens,
    pureBefore,
    pureAfter: pureEstimate(after.messages),
  };
}

import { currentTime } from "./tools/current-time.ts";

// 供上层（apps/server 等）引用这些 pi 类型而不直接依赖 @earendil-works/*：
// pnpm 严格 node_modules 下 apps/server 解析不到 pi 包，也守住「pi 接线只在 agent/ai」的约束。
export type {
  Agent,
  AgentHarness,
  AgentHarnessEvent,
  AgentMessage,
  Session,
} from "@earendil-works/pi-agent-core";
// 转出给 apps/server：让它拿到模型清单又不必依赖 @petrel/ai，
// 守住「pi 的接线只在 agent 与 ai」这条约束
export { listModels, type ModelSummary } from "@petrel/ai";
// 只转出 apps/server 真正消费的那几个。effectiveWindow / CompactionSkipReason /
// MaybeCompactOptions 目前只在 packages/agent 内部用到，需要时再加
export {
  type CompactionOutcome,
  type CompactionPolicy,
  type CompactionState,
  createCompactionState,
  isContextOverflow,
  maybeCompact,
} from "./compaction.ts";
export {
  type CreateHarnessOptions,
  createHarness,
  createMemorySession,
  createPgSession,
  DEFAULT_SYSTEM_PROMPT,
  resolveModel,
} from "./harness.ts";
export { PgSessionStorage } from "./session/pg-storage.ts";
export { currentTime };

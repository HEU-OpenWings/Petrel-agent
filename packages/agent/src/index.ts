import { currentTime } from "./tools/current-time.ts";

// 供上层（apps/server 等）引用这些 pi 类型而不直接依赖 @earendil-works/*：
// pnpm 严格 node_modules 下 apps/server 解析不到 pi 包，也守住「pi 接线只在 agent」的约束。
export type {
  Agent,
  AgentHarness,
  AgentHarnessEvent,
  AgentMessage,
  Session,
} from "@earendil-works/pi-agent-core";
// 只转出 apps/server 真正消费的那几个。effectiveWindow / CompactionSkipReason /
// MaybeCompactOptions 目前只在 packages/agent 内部用到，需要时再加
export {
  type CompactionOutcome,
  type CompactionPolicy,
  type CompactionState,
  type ContextUsage,
  createCompactionState,
  inspectContext,
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
// HEU-53 provider 配置状态查询（只读，给 Settings「模型服务」面板）
export {
  listConfiguredModels,
  listModels,
  listProviderModels,
  listProviderStatuses,
  type ModelSummary,
  type ProviderListResponse,
  type ProviderModelStatus,
  type ProviderModelsResponse,
  type ProviderStatus,
} from "./models/index.ts";
export { PgSessionStorage } from "./session/pg-storage.ts";
export { currentTime };

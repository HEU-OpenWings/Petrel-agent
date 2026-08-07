import type { AgentHarness as PiAgentHarness } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./harness.ts";
import { currentTime } from "./tools/current-time.ts";

// 供上层（apps/server 等）引用这些 pi 类型而不直接依赖 @earendil-works/*：
// pnpm 严格 node_modules 下 apps/server 解析不到 pi 包，也守住「pi 接线只在 agent」的约束。
export type {
  Agent,
  AgentHarnessEvent,
  AgentMessage,
  Session,
} from "@earendil-works/pi-agent-core";

/**
 * AgentHarness 已带上 ToolContext 泛型，所有消费者拿到的都是 `AgentHarness<ToolContext>`。
 * 改名重新导出：解决 `AgentHarness<undefined>` 不兼容的 typecheck 错误。
 */
export type AgentHarness = PiAgentHarness<ToolContext>;
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
  resolveTools,
  type ToolContext,
} from "./harness.ts";
export { listConfiguredModels, listModels, type ModelSummary } from "./models/index.ts";
export { PgSessionStorage } from "./session/pg-storage.ts";
export { initMcpTools, listToolNames, selectTools, shutdownMcpTools } from "./tools/registry.ts";
export { currentTime };

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../harness.ts";
import { currentTime } from "./current-time.ts";
import { connectAllMcpServers } from "./mcp.ts";
import { createWebSearchFromConfig } from "./web-search.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ToolEntry {
  tool: AgentHarnessTool<ToolContext>;
  /**
   * 不满足条件时不出现在注册表里。
   * 典型场景：web_search 未配 API key → enabled: false，模型看不到它。
   */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolEntry>();

/**
 * 注册一个工具。
 *
 * - 名冲突时立刻抛错——两个工具同名时模型调到哪个是不确定的，必须启动即失败。
 * - `enabled` 默认 true；false 表示该工具此刻不应出现在可选列表里
 *   （如凭据缺失），等条件满足时再改回 true。
 */
export function registerTool(name: string, tool: AgentHarnessTool<ToolContext>, enabled = true): void {
  if (registry.has(name)) {
    throw new Error(`工具名重复：${name}（已注册的同名工具会与本次注册冲突，模型无法确定该调哪一个）`);
  }
  registry.set(name, { tool, enabled });
}

/**
 * 从注册表按名选取工具。
 *
 * - 不传 names 时返回所有 enabled 的工具
 * - 传了 names 但名字不在注册表里 → 跳过（不抛错：注册表是唯一的真实清单，名字
 *   可能来自旧的会话历史或已下线的工具）
 * - 名字在注册表里但 enabled: false → 跳过
 */
export function selectTools(names?: string[]): AgentHarnessTool<ToolContext>[] {
  if (names === undefined) {
    return [...registry.values()].filter((entry) => entry.enabled).map((entry) => entry.tool);
  }
  const result: AgentHarnessTool<ToolContext>[] = [];
  for (const name of names) {
    const entry = registry.get(name);
    if (entry?.enabled) result.push(entry.tool);
  }
  return result;
}

/** 列出所有 enabled 的工具名。 */
export function listToolNames(): string[] {
  return [...registry.entries()].filter(([, entry]) => entry.enabled).map(([name]) => name);
}

/** 仅供测试：清空注册表并重新注册内置工具。 */
export function resetRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// 内置工具默认注册
// ---------------------------------------------------------------------------

registerTool("get_current_time", currentTime);

const webSearch = createWebSearchFromConfig();
if (webSearch) {
  registerTool("web_search", webSearch);
}

// ---------------------------------------------------------------------------
// MCP 工具异步注册
// ---------------------------------------------------------------------------

let mcpCleanup: (() => Promise<void>) | undefined;

/**
 * 连接所有 MCP server 并将其工具注册进注册表。
 *
 * 在 apps/server 启动时调用一次。MCP 连接是异步的（HTTP 握手），
 * 所以不能在模块顶层同步完成。
 *
 * @returns cleanup 函数，进程退出前调用以关闭 MCP 连接。
 */
export async function initMcpTools(): Promise<() => Promise<void>> {
  const { tools, cleanup } = await connectAllMcpServers();
  for (const tool of tools) {
    // MCP 工具名已经带了 server 前缀（由 mcp.ts 保证），不会与内置工具冲突。
    // 如果有冲突（极端情况），抛错让运维知道。
    registerTool(tool.name, tool);
  }
  mcpCleanup = cleanup;
  return cleanup;
}

/** 进程退出时清理 MCP 连接。 */
export async function shutdownMcpTools(): Promise<void> {
  if (mcpCleanup) {
    await mcpCleanup();
    mcpCleanup = undefined;
  }
}

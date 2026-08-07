import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolContext } from "../harness.ts";

/** 极简工具，用于验证「LLM → 工具 → LLM」的完整循环：无外部依赖、无副作用。 */
export const currentTime: AgentHarnessTool<ToolContext> = {
  name: "get_current_time",
  label: "当前时间",
  description: "获取当前时间，返回 ISO 8601 格式的 UTC 时间字符串",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params, _signal, _onUpdate, _context) => {
    const now = new Date().toISOString();
    return { content: [{ type: "text", text: now }], details: { now } };
  },
};

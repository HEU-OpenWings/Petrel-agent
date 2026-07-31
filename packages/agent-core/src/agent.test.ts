import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.ts";

/** 用 pi 自带的 faux provider 跑真实 agent loop，无需模型凭据。 */
function fauxAgent() {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const events: AgentEvent[] = [];
  const agent = createAgent({ models, model: faux.getModel() });
  agent.subscribe((event) => {
    events.push(event);
  });
  return { faux, agent, events };
}

describe("agent loop", () => {
  it("streams a single-turn answer", async () => {
    const { faux, agent, events } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel。")])]);

    await agent.prompt("你好");

    // 期望序列来自 pi 文档的 prompt() 事件规范：用户消息 → 助手消息 → 收尾
    const withoutDeltas = events.map((e) => e.type).filter((type) => type !== "message_update");
    expect(withoutDeltas).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(events.some((e) => e.type === "message_update")).toBe(true);
    const last = agent.state.messages.at(-1);
    expect(JSON.stringify(last)).toContain("你好，我是 Petrel。");
  });

  it("runs the tool loop: LLM asks for a tool, tool result feeds the next turn", async () => {
    const { faux, agent, events } = fauxAgent();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_current_time", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("现在已经查到时间了。")]),
    ]);

    await agent.prompt("现在几点");

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    // 工具结果触发了第二轮 LLM 调用
    expect(types.filter((t) => t === "turn_start")).toHaveLength(2);

    const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ toolName: "get_current_time", isError: false });
    // 工具返回的是 ISO 8601 时间字符串
    expect(JSON.stringify(toolResult)).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

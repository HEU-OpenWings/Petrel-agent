import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_ID } from "@petrel/ai";
import { describe, expect, it } from "vitest";
import { type CreateAgentOptions, createAgent } from "./index.ts";

/** 用 pi 自带的 faux provider 跑真实 agent loop，无需模型凭据。 */
function fauxAgent(options: Omit<CreateAgentOptions, "models" | "model"> = {}) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const events: AgentEvent[] = [];
  const agent = createAgent({ ...options, models, model: faux.getModel() });
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

  it("回灌的历史进入 transcript，并随请求发给 provider", async () => {
    // 助手消息用 fauxAssistantMessage 造：AgentMessage 的 assistant 分支还带
    // api / provider / model / usage 等字段，手写一个字面量凑不齐
    const history: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "上一轮提问" }], timestamp: Date.now() },
      fauxAssistantMessage([fauxText("上一轮回答")]),
    ];
    const { faux, agent } = fauxAgent({ messages: history, sessionId: "session-1" });

    let seen: { messages: unknown[]; sessionId?: string } | undefined;
    faux.setResponses([
      (context, options) => {
        seen = { messages: context.messages, sessionId: options?.sessionId };
        return fauxAssistantMessage([fauxText("这一轮回答")]);
      },
    ]);

    // 回灌之后 transcript 就已经不是空的了
    expect(agent.state.messages).toHaveLength(2);

    await agent.prompt("这一轮提问");

    expect(seen?.messages).toHaveLength(3);
    expect(JSON.stringify(seen?.messages)).toContain("上一轮回答");
    // sessionId 是 pi Agent 的顶层选项，会随每次请求下发给 provider
    expect(seen?.sessionId).toBe("session-1");
  });
});

describe("模型选择", () => {
  it("未注册的 modelId 抛错，而不是静默用默认模型", () => {
    // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
    expect(() => createAgent({ modelId: "gpt-does-not-exist" })).toThrow("模型未注册");
  });

  it("modelId 传 undefined 时用系统默认模型", () => {
    const agent = createAgent();

    expect(agent.state.model.id).toBe(DEFAULT_MODEL_ID);
  });

  it("modelId 命中注册表时用该模型", () => {
    const agent = createAgent({ modelId: "deepseek-ai/DeepSeek-V3" });

    expect(agent.state.model.id).toBe("deepseek-ai/DeepSeek-V3");
  });

  // chat.test.ts / isolation.test.ts 的 faux provider 注入靠这条优先级：
  // 它们把 model 铺在 options 之上，此时 modelId 必须让位
  it("显式的 model 优先于 modelId", () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);

    const agent = createAgent({ modelId: DEFAULT_MODEL_ID, models, model: faux.getModel() });

    expect(agent.state.model.id).toBe(faux.getModel().id);
  });
});

import type { AgentEvent, AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectAgentEvent, projectAssistantMessage } from "./project-agent-event.ts";

const SECRET_SENTINEL = "provider-secret-internal-9f3a";
const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  cacheWrite1h: 1,
  reasoning: 1,
  totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

function unsafeAssistant(stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "安全正文", textSignature: SECRET_SENTINEL },
      {
        type: "thinking",
        thinking: "安全思考",
        thinkingSignature: SECRET_SENTINEL,
        redacted: false,
      },
      {
        type: "toolCall",
        id: "tool-1",
        name: "lookup",
        arguments: { query: "safe" },
        thoughtSignature: SECRET_SENTINEL,
      },
    ],
    api: "openai-responses",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    responseModel: SECRET_SENTINEL,
    responseId: SECRET_SENTINEL,
    diagnostics: [{ message: SECRET_SENTINEL } as never],
    usage,
    stopReason,
    errorMessage: SECRET_SENTINEL,
    rawStopReason: SECRET_SENTINEL,
    timestamp: 123,
  };
}

function requireProjected(event: AgentHarnessEvent): AgentEvent {
  const projected = projectAgentEvent(event);
  if (!projected) throw new Error(`测试预期 ${event.type} 被保留`);
  return projected;
}

function expectSanitized(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain(SECRET_SENTINEL);
  expect(json).not.toContain("responseId");
  expect(json).not.toContain("responseModel");
  expect(json).not.toContain("diagnostics");
  expect(json).not.toContain("rawStopReason");
  expect(json).not.toContain("textSignature");
  expect(json).not.toContain("thinkingSignature");
  expect(json).not.toContain("thoughtSignature");
}

describe("projectAssistantMessage", () => {
  it("只保留浏览器需要的白名单字段，并把原始错误替换为固定文案", () => {
    const original = unsafeAssistant();
    const before = structuredClone(original);

    const projected = projectAssistantMessage(original);

    expect(projected).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "安全正文" },
        { type: "thinking", thinking: "安全思考", redacted: false },
        { type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "safe" } },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage,
      stopReason: "error",
      errorMessage: "模型调用失败，请稍后重试",
      timestamp: 123,
    });
    expectSanitized(projected);
    expect(original).toEqual(before);
    expect(projected).not.toBe(original);
    expect(projected.content).not.toBe(original.content);
    expect(projected.usage).not.toBe(original.usage);
  });

  it.each([
    ["pending", "模型响应尚未完成"],
    ["stop", "模型服务返回异常信息"],
    ["length", "模型输出达到长度上限"],
    ["toolUse", "模型工具调用未能完成"],
    ["error", "模型调用失败，请稍后重试"],
    ["aborted", "生成已停止"],
  ] as const)("stopReason=%s 使用对应固定错误文案", (stopReason, message) => {
    expect(projectAssistantMessage(unsafeAssistant(stopReason)).errorMessage).toBe(message);
  });

  it("原消息没有 errorMessage 时不凭空增加错误", () => {
    const message = unsafeAssistant("stop");
    delete message.errorMessage;

    expect(projectAssistantMessage(message)).not.toHaveProperty("errorMessage");
  });
});

describe("projectAgentEvent 的 AssistantMessage 路径", () => {
  it("覆盖 agent_end.messages 中的每个 assistant message", () => {
    const event: AgentEvent = {
      type: "agent_end",
      messages: [
        { role: "user", content: "你好", timestamp: 1 },
        unsafeAssistant(),
        unsafeAssistant("aborted"),
      ],
    };
    const before = structuredClone(event);

    const projected = requireProjected(event);

    expectSanitized(projected);
    expect(event).toEqual(before);
  });

  it("覆盖 turn_end.message", () => {
    const event: AgentEvent = {
      type: "turn_end",
      message: unsafeAssistant(),
      toolResults: [],
    };

    expectSanitized(requireProjected(event));
  });

  it.each(["message_start", "message_end"] as const)("覆盖 %s.message", (type) => {
    const event: AgentEvent = { type, message: unsafeAssistant() };

    expectSanitized(requireProjected(event));
  });

  const partial = unsafeAssistant();
  const nestedEvents: AssistantMessageEvent[] = [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: "x", partial },
    { type: "text_end", contentIndex: 0, content: "x", partial },
    { type: "thinking_start", contentIndex: 0, partial },
    { type: "thinking_delta", contentIndex: 0, delta: "x", partial },
    { type: "thinking_end", contentIndex: 0, content: "x", partial },
    { type: "toolcall_start", contentIndex: 0, partial },
    { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial },
    {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "t", name: "lookup", arguments: {} },
      partial,
    },
    { type: "done", reason: "stop", message: unsafeAssistant("stop") },
    { type: "error", reason: "error", error: unsafeAssistant("error") },
  ];

  it.each(nestedEvents)("覆盖 message_update.assistantMessageEvent.$type", (nested) => {
    const event: AgentEvent = {
      type: "message_update",
      message: unsafeAssistant(),
      assistantMessageEvent: nested,
    };
    const before = structuredClone(event);

    const projected = requireProjected(event);

    expectSanitized(projected);
    expect(event).toEqual(before);
  });
});

describe("projectAgentEvent 的 harness 边界", () => {
  const harnessOnlyTypes = [
    "queue_update",
    "save_point",
    "abort",
    "settled",
    "before_agent_start",
    "context",
    "before_provider_request",
    "before_provider_payload",
    "after_provider_response",
    "tool_call",
    "tool_result",
    "session_before_compact",
    "session_compact",
    "session_before_tree",
    "session_tree",
    "retry_scheduled",
    "retry_attempt_start",
    "retry_finished",
    "model_update",
    "thinking_level_update",
    "resources_update",
    "tools_update",
  ] as const;

  it.each(harnessOnlyTypes)("丢弃 harness 内部事件 %s", (type) => {
    const event = { type, secret: SECRET_SENTINEL } as unknown as AgentHarnessEvent;
    expect(projectAgentEvent(event)).toBeUndefined();
  });

  it("保留工具执行事件且不改原对象", () => {
    const event: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "lookup",
      result: { content: "结果" },
      isError: false,
    };
    const projected = requireProjected(event);

    expect(projected).toEqual(event);
    expect(projected).not.toBe(event);
  });
});

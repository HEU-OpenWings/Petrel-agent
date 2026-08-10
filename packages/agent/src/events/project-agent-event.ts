import type { AgentEvent, AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, StopReason, Usage } from "@earendil-works/pi-ai";

const AGENT_EVENT_TYPES = {
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
} satisfies Record<AgentEvent["type"], true>;

const SAFE_ERROR_MESSAGES: Record<StopReason, string> = {
  pending: "模型响应尚未完成",
  stop: "模型服务返回异常信息",
  length: "模型输出达到长度上限",
  toolUse: "模型工具调用未能完成",
  error: "模型调用失败，请稍后重试",
  aborted: "生成已停止",
};

function unreachable(value: never): never {
  throw new Error(`未处理的 AgentEvent 分支：${String(value)}`);
}

function projectUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

/**
 * 面向浏览器的 AssistantMessage 白名单投影。
 *
 * content 保留前端归约和渲染需要的正文、思考与工具调用，但去掉 provider 的不透明
 * signature；message 本身不暴露 responseId、responseModel、diagnostics、rawStopReason。
 * 任意上游 errorMessage 都只按 stopReason 映射成固定文案。
 */
export function projectAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "thinking") {
        return {
          type: "thinking",
          thinking: block.thinking,
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
      }
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: { ...block.arguments },
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: projectUsage(message.usage),
    stopReason: message.stopReason,
    ...(message.errorMessage !== undefined ? { errorMessage: SAFE_ERROR_MESSAGES[message.stopReason] } : {}),
    timestamp: message.timestamp,
  };
}

function projectAgentMessage(message: AgentMessage): AgentMessage {
  if (message.role === "assistant") return projectAssistantMessage(message);
  return { ...message };
}

function projectAssistantMessageEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  switch (event.type) {
    case "start":
      return { ...event, partial: projectAssistantMessage(event.partial) };
    case "text_start":
    case "text_delta":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return { ...event, partial: projectAssistantMessage(event.partial) };
    case "done":
      return { ...event, message: projectAssistantMessage(event.message) };
    case "error":
      return { ...event, error: projectAssistantMessage(event.error) };
    default:
      return unreachable(event);
  }
}

function projectCoreAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return { ...event };
    case "agent_end":
      return { ...event, messages: event.messages.map(projectAgentMessage) };
    case "turn_end":
      return {
        ...event,
        message: projectAgentMessage(event.message),
        toolResults: event.toolResults.map((result) => ({ ...result })),
      };
    case "message_start":
    case "message_end":
      return { ...event, message: projectAgentMessage(event.message) };
    case "message_update":
      return {
        ...event,
        message: projectAgentMessage(event.message),
        assistantMessageEvent: projectAssistantMessageEvent(event.assistantMessageEvent),
      };
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return { ...event };
    default:
      return unreachable(event);
  }
}

/**
 * 把 harness 事件收敛为浏览器需要的 core AgentEvent。
 *
 * Harness 自有事件可能携带 provider payload、HTTP headers、完整 context、Model/baseUrl
 * 或内部重试错误，前端也不消费，因此一律返回 undefined；调用方应直接跳过。
 */
export function projectAgentEvent(event: AgentHarnessEvent): AgentEvent | undefined {
  if (!Object.hasOwn(AGENT_EVENT_TYPES, event.type)) return undefined;
  return projectCoreAgentEvent(event as AgentEvent);
}

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defaultModel, models as defaultModels, findModel, listModels } from "@petrel/ai";
import { currentTime } from "./tools/current-time.ts";

// 供上层（apps/server 等）引用 Agent 类型而不直接依赖 @earendil-works/*：
// pnpm 严格 node_modules 下 apps/server 解析不到 pi 包，也守住「pi 接线只在 agent/ai」的约束。
export type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

export interface CreateAgentOptions {
  systemPrompt?: string;
  tools?: AgentTool[];
  /** 模型集合与模型，默认取 @petrel/ai 注册的 SiliconFlow；测试可注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 @petrel/ai 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent → ai，且 pi 的接线只允许出现在 agent 与 ai 两个 package。
   */
  modelId?: string;
  /** 恢复会话时回灌的历史消息，pi 会把它当作已有 transcript 继续。 */
  messages?: AgentMessage[];
  /** 透传给 pi，最终随每次请求下发给 provider，供缓存感知的后端做会话亲和。 */
  sessionId?: string;
}

/**
 * 优先级：显式 model > modelId > 系统默认。
 *
 * 保留 model 这个口子是给测试的：chat.test.ts 与 isolation.test.ts 在模块边界
 * 包一层 createAgent，把 faux provider 的 models/model 铺在调用方 options 之上，
 * 所以它必须能盖掉 modelId。
 */
function resolveModel(options: CreateAgentOptions): Model<Api> {
  if (options.model) return options.model;
  if (options.modelId === undefined) return defaultModel();

  const model = findModel(options.modelId);
  if (!model) {
    // 列出可选值：这个错误会经 routes/chat.ts 变成 400 给到客户端，
    // 只说「未注册」的话对方不知道该改成什么
    throw new Error(
      `模型未注册：${options.modelId}，可选值为 ${listModels()
        .map((item) => item.id)
        .join(" | ")}`,
    );
  }
  return model;
}

/**
 * 装配一个 pi Agent。所有 pi 的接线都收在这里，上层只依赖本函数与 Agent 的事件流，
 * 便于将来替换 agent 内核。
 */
export function createAgent(options: CreateAgentOptions = {}): Agent {
  const models = options.models ?? defaultModels;
  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: resolveModel(options),
      tools: options.tools ?? [currentTime],
      // 不传时给 undefined 就行：pi 内部是 initialState?.messages?.slice() ?? []
      messages: options.messages,
    },
    sessionId: options.sessionId,
    streamFn: models.streamSimple.bind(models),
  });
}

// 转出给 apps/server：让它拿到模型清单又不必依赖 @petrel/ai，
// 守住「pi 的接线只在 agent 与 ai」这条约束
export { listModels, type ModelSummary } from "@petrel/ai";
export { currentTime };

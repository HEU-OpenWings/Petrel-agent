import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defaultModel, models as defaultModels } from "@petrel/ai";
import { currentTime } from "./tools/current-time.ts";

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

export interface CreateAgentOptions {
  systemPrompt?: string;
  tools?: AgentTool[];
  /** 模型集合与模型，默认取 @petrel/ai 注册的 SiliconFlow；测试可注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
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
      model: options.model ?? defaultModel(),
      tools: options.tools ?? [currentTime],
    },
    streamFn: models.streamSimple.bind(models),
  });
}

export { currentTime };

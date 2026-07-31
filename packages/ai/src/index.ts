import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";

export const DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V3";

const deepseekV3: Model<"openai-completions"> = {
  id: DEFAULT_MODEL_ID,
  name: "DeepSeek-V3 (SiliconFlow)",
  api: "openai-completions",
  provider: "siliconflow",
  baseUrl: SILICONFLOW_BASE_URL,
  reasoning: false,
  input: ["text"],
  // 单位：美元 / 百万 token，按硅基流动定价折算，仅用于用量统计
  cost: { input: 0.27, output: 1.1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 8192,
};

/**
 * SiliconFlow 是 OpenAI 兼容端点，pi-ai 未内置，用 createProvider 自行注册。
 *
 * API key 走 pi-ai 的标准 auth 机制从 SILICONFLOW_API_KEY 解析，这是
 * 「@petrel/config 是唯一读取 process.env 的位置」这条约定的例外：凭据解析
 * 属于 pi-ai 的职责，它还要兼顾凭据存储与 OAuth，绕过它反而更容易出错。
 */
const siliconflow = createProvider({
  id: "siliconflow",
  name: "SiliconFlow",
  baseUrl: SILICONFLOW_BASE_URL,
  auth: { apiKey: envApiKeyAuth("SiliconFlow API key", ["SILICONFLOW_API_KEY"]) },
  models: [deepseekV3],
  api: openAICompletionsApi(),
});

export const models = createModels();
models.setProvider(siliconflow);

export function defaultModel(): Model<"openai-completions"> {
  const model = models.getModel("siliconflow", DEFAULT_MODEL_ID);
  if (!model) throw new Error(`模型未注册：${DEFAULT_MODEL_ID}`);
  return model as Model<"openai-completions">;
}

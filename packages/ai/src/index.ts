import { type Api, createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";

export const DEFAULT_PROVIDER_ID = "deepseek";
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/**
 * DeepSeek 官方只提供 Responses API（`POST {baseUrl}/responses`），没有 chat/completions，
 * 所以这里用 openai-responses 适配器，与下面 SiliconFlow 的 openai-completions 不是一套。
 *
 * 价格按官方定价（人民币）折成美元 / 百万 token，汇率取 7.2，与 SiliconFlow 那条口径一致，
 * 仅用于用量统计。官方定价：命中缓存 ¥0.02 / 未命中 ¥1 输入，¥2 输出；写缓存不计费。
 */
const deepseekV4Flash: Model<"openai-responses"> = {
  id: DEFAULT_MODEL_ID,
  name: "DeepSeek V4 Flash",
  api: "openai-responses",
  provider: DEFAULT_PROVIDER_ID,
  baseUrl: DEEPSEEK_BASE_URL,
  reasoning: true,
  /**
   * v4-flash 是推理模型，默认就会吐 thinking 块（前端 MessageItem.vue 已能渲染）。
   * 但 pi 在 `reasoning: true` 且调用方没指定 effort 时，会主动发
   * `reasoning: { effort: "none" }` 把思考关掉（openai-responses.js 的 else 分支）；
   * 把 off 映射成 null 正好命中它的 `thinkingLevelMap?.off !== null` 判断，
   * 让 pi 什么都不发，采用 DeepSeek 自己的默认值。
   */
  thinkingLevelMap: { off: null },
  input: ["text"],
  cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
};

const deepseek = createProvider({
  id: DEFAULT_PROVIDER_ID,
  name: "DeepSeek",
  baseUrl: DEEPSEEK_BASE_URL,
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: [deepseekV4Flash],
  api: openAIResponsesApi(),
});

const deepseekV3: Model<"openai-completions"> = {
  id: "deepseek-ai/DeepSeek-V3",
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
 * SiliconFlow 与 DeepSeek 都是 OpenAI 兼容端点，pi-ai 未内置，用 createProvider 自行注册。
 * SiliconFlow 保留着做备选：DeepSeek 官方限流时可以把 defaultModel 指回来。
 *
 * API key 走 pi-ai 的标准 auth 机制从环境变量解析，这是
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
models.setProvider(deepseek);
models.setProvider(siliconflow);

export function defaultModel(): Model<"openai-responses"> {
  const model = models.getModel(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID);
  if (!model) throw new Error(`模型未注册：${DEFAULT_MODEL_ID}`);
  return model as Model<"openai-responses">;
}

/** 给 HTTP 响应用的模型摘要。不含 baseUrl / cost / 内部开关 */
export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  /** 偏好为 null（跟随系统默认）时，前端靠这个知道实际用的是哪个 */
  isDefault: boolean;
}

/**
 * 从 models 注册表派生，不另存一份清单。
 *
 * 早先的写法是手抄一个 { model, providerName } 数组，但那样往 provider 的
 * models: [...] 里加模型时必须记得同步两处，漏了就是「模型能跑但前端选不到」，
 * 且类型检查与测试都拦不住。providerName 也不必再抄一遍字面量——
 * Provider 自己就带 name。
 */
export function listModels(): ModelSummary[] {
  return models.getProviders().flatMap((provider) =>
    provider.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      provider: provider.id,
      providerName: provider.name,
      isDefault: model.id === DEFAULT_MODEL_ID,
    })),
  );
}

/**
 * 按 model id 查。两个 provider 的 id 不重名，所以不需要同时传 provider——
 * 偏好里只存一个字符串，多带一个 provider 只是让前端多存一份能推出来的信息。
 */
export function findModel(id: string): Model<Api> | undefined {
  return models.getModels().find((model) => model.id === id);
}

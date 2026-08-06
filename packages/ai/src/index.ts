import { type Api, createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { qwenTokenPlanProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { env } from "@petrel/config";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const OLLAMA_BASE_URL = "http://localhost:11434/v1";

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

/**
 * 本地推理服务（Ollama / vLLM）都不在 pi 内置 catalog 里，用 createProvider 按
 * OpenAI 兼容端点自行注册——与上面 SiliconFlow 同一套（openai-completions.lazy）。
 *
 * 两者的共同点：通常**无 API key**、**baseUrl 可变**（取决于本机怎么起服务）。
 * - baseUrl：Ollama 用官方默认端口（11434）；vLLM 无约定俗成的端口，从
 *   `@petrel/config` 的 `env.vllmBaseUrl`（即 `VLLM_BASE_URL`）读，留空回落 `:8000/v1`。
 *   baseUrl 不走 pi-ai 的 auth 机制——pi-ai 只识别凭据类 env，不解析 baseUrl。
 * - auth：仍走 envApiKeyAuth。key 缺失时 pi 的 resolve() 返回 undefined，该 provider
 *   被判「未配置」，listConfiguredModels() 自然不列它——除非显式配了 OLLAMA_API_KEY。
 *   这正是想要的：没起本地服务时，前端选择器不会出现一堆选了就报错的模型。
 *
 * 这里只放一个最小占位模型（id 与本地实际拉取的模型 tag 对齐），真实可用模型列表
 * 取决于用户本地 `ollama pull` / vLLM 启动参数，无法在注册表里穷举。
 */
const ollamaDefaultModel: Model<"openai-completions"> = {
  id: "qwen2.5:0.5b",
  name: "Qwen2.5 0.5B (Ollama 本地)",
  api: "openai-completions",
  provider: "ollama",
  baseUrl: OLLAMA_BASE_URL,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4096,
};

const ollama = createProvider({
  id: "ollama",
  name: "Ollama (本地)",
  baseUrl: OLLAMA_BASE_URL,
  auth: { apiKey: envApiKeyAuth("Ollama API key（本地通常留空）", ["OLLAMA_API_KEY"]) },
  models: [ollamaDefaultModel],
  api: openAICompletionsApi(),
});

const vllmDefaultModel: Model<"openai-completions"> = {
  id: "default",
  name: "vLLM 默认模型 (本地)",
  api: "openai-completions",
  provider: "vllm",
  baseUrl: env.vllmBaseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4096,
};

const vllm = createProvider({
  id: "vllm",
  name: "vLLM (本地)",
  baseUrl: env.vllmBaseUrl,
  auth: { apiKey: envApiKeyAuth("vLLM API key（本地通常留空）", ["VLLM_API_KEY"]) },
  models: [vllmDefaultModel],
  api: openAICompletionsApi(),
});

/**
 * 内置 provider：OpenAI / Anthropic / Google / Moonshot / MiniMax / ZAI / 阿里(Qwen)。
 * pi-ai 0.83 已为它们内置了工厂函数，baseUrl / 官方定价 / API 适配器 / 环境变量名
 * 全部正确（已核 dist/providers/<name>.js），直接 setProvider 注册即可。
 *
 * 注意：pi 内置也有一个 deepseekProvider()，但它的 provider id 同为 "deepseek"、
 * 且走 openai-completions，而本文件顶部手写的 deepseek 走 openai-responses 并带
 * 自定义 thinkingLevelMap（已实测 reasoning 行为，见 docs/backend-plan.md）。
 * setProvider 是按 id upsert，若同时注册会以后者覆盖前者——所以这里**不**引入
 * 内置 deepseek，保留手写版。
 */
const BUILTIN_PROVIDERS = [
  openaiProvider(),
  anthropicProvider(),
  googleProvider(),
  moonshotaiProvider(),
  minimaxProvider(),
  zaiProvider(),
  qwenTokenPlanProvider(),
];

export const models = createModels();
models.setProvider(deepseek);
models.setProvider(siliconflow);
for (const provider of BUILTIN_PROVIDERS) {
  models.setProvider(provider);
}
models.setProvider(ollama);
models.setProvider(vllm);

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
      // 必须同时判 provider：聚合型平台（如 qwen-token-plan / openrouter）会代售
      // DeepSeek、Kimi 等他厂模型，model id 与原厂重名。只判 id 会把多个 provider
      // 的同名模型都标成默认，破坏「恰好一个 isDefault」的不变式
      isDefault: provider.id === DEFAULT_PROVIDER_ID && model.id === DEFAULT_MODEL_ID,
    })),
  );
}

/**
 * 按 model id 查。偏好里只存一个字符串，不区分 provider——因此遇到聚合平台
 * 代售的同名模型时，**默认 provider 优先**：例如 "deepseek-v4-flash" 同时存在于
 * deepseek 官方与 qwen-token-plan，查出来的是官方那条。
 *
 * 这是既有契约（偏好只存 id）下的取舍：用户若想用 qwen 平台的 deepseek-v4-flash，
 * 在 model id 唯一性假设下无法表达——那需要把偏好改成 (provider, id) 二元键，
 * 超出 HEU-9 范围。本函数至少保证默认场景无歧义。
 */
export function findModel(id: string): Model<Api> | undefined {
  const all = models.getModels();
  // 默认 provider 的同名模型优先；没有再回退到第一个匹配
  return (
    all.find((model) => model.id === id && model.provider === DEFAULT_PROVIDER_ID) ??
    all.find((model) => model.id === id)
  );
}

/**
 * 只列**已配置**（API key 可解析）的 provider 的模型，供前端模型选择器。
 *
 * 与 listModels() 的区别：listModels 列全部注册模型（用于「model id 是否合法」的
 * 白名单校验——语义是「是否注册」，而不是「是否配了 key」）；本函数只返回
 * getAuth() 能解析出凭据的 provider，没配 key 的厂商不会出现在下拉里，避免
 * 「选了 OpenAI 但没配 key，一发消息就报错」。
 *
 * 注册了多家本地/云 provider 但只配了 DeepSeek 时，前端只看到 DeepSeek 一项。
 * pi 的 getAuth 是 async（要读 env / 凭据存储 / 可能刷新 OAuth），所以这里也是 async。
 *
 * **重名去重**：聚合平台（qwen-token-plan / openrouter 等）会代售他厂同名模型
 * （如 kimi-k2.6 同时挂在 moonshotai 与 qwen-token-plan 下），而偏好里只存 model id、
 * 运行时由 `findModel(id)` 解析——后者按「默认 provider 优先」挑一条，挑中的未必是
 * 选择器里展示的那条。若不去重，用户在只有 QWEN key 时选中 `kimi-k2.6`，
 * `findModel` 却解析到没配 key 的 moonshotai 那条，运行即报错。
 *
 * 因此这里对每个 model id 只保留 `findModel` 真正会解析到的那一条 provider，
 * 保证不变式：**选择器里的每个 id，findModel 解析出的 provider 等于摘要里的 provider**。
 * 非默认 provider 上的重名条目被跳过——想用它们需要先把偏好键改成 (provider, id) 二元，
 * 超出 HEU-9 范围。
 */
export async function listConfiguredModels(): Promise<ModelSummary[]> {
  const summaries: ModelSummary[] = [];
  for (const provider of models.getProviders()) {
    const auth = await models.getAuth(provider.id);
    if (!auth) continue;
    for (const model of provider.getModels()) {
      // 重名去重：只暴露 findModel 会解析到的那一条，保证选择器与运行时解析一致
      const resolved = findModel(model.id);
      if (resolved && resolved.provider !== provider.id) continue;
      summaries.push({
        id: model.id,
        name: model.name,
        provider: provider.id,
        providerName: provider.name,
        // 与 listModels() 同口径：聚合平台代售同名模型时，只有默认 provider 那条算默认
        isDefault: provider.id === DEFAULT_PROVIDER_ID && model.id === DEFAULT_MODEL_ID,
      });
    }
  }
  return summaries;
}

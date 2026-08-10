import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
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

/** 注册顺序即 listModels() 的输出顺序（自建云端 → pi 内置 → 本地推理） */
export const PROVIDERS = [deepseek, siliconflow, ...BUILTIN_PROVIDERS, ollama, vllm];

/**
 * 面向展示的 provider 凭据元数据：每个 provider「认哪些环境变量」+「用户该怎么填」。
 *
 * 为什么需要这份 side table：envApiKeyAuth(...) 把 env var 名以**闭包**形式塞进了
 * pi-ai 的 resolve() 内部（auth/helpers.js），Provider / ApiKeyAuth 的公开类型都不暴露
 * envVars 字段——也就是说**无法从运行时 Provider 对象反射出「它认哪个 env 变量」**。
 * checkAuth().source 只在「已配置」时给到当前命中的那一个变量名，未配置时是 undefined，
 * 既列不全、也覆盖不了「未配置 provider 该填哪个变量」这个 HEU-53 的核心需求。
 *
 * 所以这份清单是当前代码事实的同源副本：手写 provider（deepseek/siliconflow/ollama/vllm）
 * 与上面 envApiKeyAuth([...]) 的实参对齐；内置 provider 与 pi-ai 0.83 的
 * dist/providers/<name>.js 核对过。新增 provider 或改 env var 时**必须同步改这里**，
 * provider-status.test.ts 的 hint parity 用例会守着「side table 的 key 集合 == 运行时
 * getProviders() 的 id 集合」与「每个声明的 env var 真能让 checkAuth 判为已配置」。
 */
export interface ProviderCredentialHint {
  /** 该 provider 接受的环境变量名。本地推理服务也可能非空（见 ollama/vllm）。 */
  readonly envVars: readonly string[];
  /** 连接测试使用的固定最小模型，必须属于该 provider 的静态 catalog。 */
  readonly probeModelId: string;
  /** 面向用户的填写指引，纯文本，不含运行时 baseUrl / key / 异常细节。 */
  readonly note: string;
}

export const PROVIDER_CREDENTIAL_HINTS: ReadonlyMap<string, ProviderCredentialHint> = new Map([
  [
    "deepseek",
    {
      envVars: ["DEEPSEEK_API_KEY"],
      probeModelId: DEFAULT_MODEL_ID,
      note: "DeepSeek 官方 API key，在 https://platform.deepseek.com 获取",
    },
  ],
  [
    "siliconflow",
    {
      envVars: ["SILICONFLOW_API_KEY"],
      probeModelId: "deepseek-ai/DeepSeek-V3",
      note: "硅基流动 API key，在 https://siliconflow.cn 获取",
    },
  ],
  [
    "openai",
    {
      envVars: ["OPENAI_API_KEY"],
      probeModelId: "gpt-5-nano",
      note: "OpenAI API key，在 https://platform.openai.com/api-keys 获取",
    },
  ],
  // anthropic 走 pi-ai 自定义的 anthropicApiKeyAuth，依次尝试三个变量，填任意一个均可
  [
    "anthropic",
    {
      envVars: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      probeModelId: "claude-haiku-4-5",
      note: "Anthropic key（依次尝试 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_OAUTH_TOKEN、ANTHROPIC_API_KEY，填任意一个均可）",
    },
  ],
  [
    "google",
    {
      envVars: ["GEMINI_API_KEY"],
      probeModelId: "gemini-2.0-flash-lite",
      note: "Google AI / Gemini API key，在 https://aistudio.google.com/apikey 获取",
    },
  ],
  [
    "moonshotai",
    {
      envVars: ["MOONSHOT_API_KEY"],
      probeModelId: "kimi-k2.5",
      note: "Moonshot / Kimi API key，在 https://platform.moonshot.cn 获取",
    },
  ],
  [
    "minimax",
    {
      envVars: ["MINIMAX_API_KEY"],
      probeModelId: "MiniMax-M2.7",
      note: "MiniMax API key，在 https://platform.minimaxi.com 获取",
    },
  ],
  [
    "zai",
    {
      envVars: ["ZAI_API_KEY"],
      probeModelId: "glm-5-turbo",
      note: "智谱 Z.AI API key，在 https://z.ai/manage-apikey 获取",
    },
  ],
  [
    "qwen-token-plan",
    {
      envVars: ["QWEN_TOKEN_PLAN_API_KEY"],
      probeModelId: "qwen3.6-flash",
      note: "阿里 Qwen Token Plan API key，在 https://bailian.console.aliyun.com 获取",
    },
  ],
  // ollama/vllm：本地推理服务。注意当前注册走 envApiKeyAuth(["OLLAMA_API_KEY"])，
  // 空 key 时 checkAuth() 判「未配置」——所以「通常无需 key」与「填任意非空占位值即可
  // 让面板识别为已配置」要如实说明，不能简单写「留空」。真正的 keyless auth 行为
  // （空值也判已配置）是另一回事，需要改 auth 解析，超出 HEU-53 范围。
  [
    "ollama",
    {
      envVars: ["OLLAMA_API_KEY"],
      probeModelId: "qwen2.5:0.5b",
      note: "本地推理服务。请确认已启动 Ollama（默认 http://localhost:11434）并 ollama pull 模型。当前运行时需设置非空的 OLLAMA_API_KEY 才会识别为已配置（可填任意占位值）",
    },
  ],
  [
    "vllm",
    {
      envVars: ["VLLM_API_KEY"],
      probeModelId: "default",
      note: "本地推理服务。通过 VLLM_BASE_URL 指定服务地址（默认 http://localhost:8000/v1）。当前运行时需设置非空的 VLLM_API_KEY 才会识别为已配置（可填任意占位值）",
    },
  ],
]);

import { type Api, createModels, type Model } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, PROVIDERS } from "./providers.ts";

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./providers.ts";

export const models = createModels();
for (const provider of PROVIDERS) {
  models.setProvider(provider);
}

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
  // 用 pi-ai 的 getAvailable()：它并行解析所有 provider 的 auth、尊重 provider.filterModels
  // 钩子（按实际凭据收窄目录，如 github-copilot），比手写串行 for-await 11 个 provider 更快、
  // 更不易漏。getAvailable 只返回 auth 配置完整的 provider 的 Model[]（不含 providerName，
  // 这里从 models.getProvider 反查补上）。
  const available = await models.getAvailable();
  const summaries: ModelSummary[] = [];
  for (const model of available) {
    // 重名去重：只暴露 findModel 会解析到的那一条，保证选择器与运行时解析一致
    const resolved = findModel(model.id);
    if (resolved && resolved.provider !== model.provider) continue;
    const provider = models.getProvider(model.provider);
    summaries.push({
      id: model.id,
      name: model.name,
      provider: model.provider,
      providerName: provider?.name ?? model.provider,
      // 与 listModels() 同口径：聚合平台代售同名模型时，只有默认 provider 那条算默认
      isDefault: model.provider === DEFAULT_PROVIDER_ID && model.id === DEFAULT_MODEL_ID,
    });
  }
  return summaries;
}

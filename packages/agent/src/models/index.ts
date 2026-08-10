import { type Api, createModels, type Model, type Models } from "@earendil-works/pi-ai";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  PROVIDER_CREDENTIAL_HINTS,
  PROVIDERS,
  type ProviderCredentialHint,
} from "./providers.ts";

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
export function listModelsFor(registry: Models): ModelSummary[] {
  return registry.getProviders().flatMap((provider) =>
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

export function listModels(): ModelSummary[] {
  return listModelsFor(models);
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
export function findModelFor(registry: Models, id: string): Model<Api> | undefined {
  const all = registry.getModels();
  // 默认 provider 的同名模型优先；没有再回退到第一个匹配
  return (
    all.find((model) => model.id === id && model.provider === DEFAULT_PROVIDER_ID) ??
    all.find((model) => model.id === id)
  );
}

export function findModel(id: string): Model<Api> | undefined {
  return findModelFor(models, id);
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
export async function listConfiguredModelsFor(registry: Models): Promise<ModelSummary[]> {
  // 用 pi-ai 的 getAvailable()：它并行解析所有 provider 的 auth、尊重 provider.filterModels
  // 钩子（按实际凭据收窄目录，如 github-copilot），比手写串行 for-await 11 个 provider 更快、
  // 更不易漏。getAvailable 只返回 auth 配置完整的 provider 的 Model[]（不含 providerName，
  // 这里从 models.getProvider 反查补上）。
  const available = await registry.getAvailable();
  const summaries: ModelSummary[] = [];
  for (const model of available) {
    // 重名去重：只暴露 findModel 会解析到的那一条，保证选择器与运行时解析一致
    const resolved = findModelFor(registry, model.id);
    if (resolved && resolved.provider !== model.provider) continue;
    const provider = registry.getProvider(model.provider);
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

export async function listConfiguredModels(): Promise<ModelSummary[]> {
  return listConfiguredModelsFor(models);
}

// ---------------------------------------------------------------------------
// HEU-53 provider 配置状态查询（只读，给 Settings「模型服务」面板）
//
// 与 listConfiguredModels 的区别：后者只列**已配置** provider 的模型（供默认模型下拉），
// 这里要列**全部** provider 并标注每个的配置状态 + env var 填写指引——issue 的核心痛点是
// 「用户不知道为什么选择器里只有 DeepSeek」，只有把未配置 provider 也列出来才能解答。
//
// 两个硬约束（见 providers.ts 的 PROVIDER_CREDENTIAL_HINTS 注释 + pi-ai 类型定义）：
// 1. env var 名无法从 Provider 反射（闭包私有），只能从 side table 读。
// 2. pi 的 getAvailable() 无参调用是 Promise.all，**单个 provider 的 checkAuth 抛错会让整
//    个调用 reject**（auth/resolve.js 把 resolve() 的错包成 ModelsError("auth")）。
//    所以这里绝不能用一次 models.getAvailable()，必须按 providerId 分别 checkAuth 各自
//    try/catch，保证一个 provider 的故障不会拖垮整个列表——这也是「configured 必须三态」
//    的根因：解析失败（null）要区别于「确实未配置」（false），否则故障被伪装成未配置。
// ---------------------------------------------------------------------------

/** R0 只读响应里单个 provider 的状态。字段逐个构造，绝不展开 pi 的 Provider/Model。 */
export interface ProviderStatus {
  id: string;
  name: string;
  /** 是否系统默认 provider（provider.id === DEFAULT_PROVIDER_ID） */
  isDefault: boolean;
  /** true=凭据可解析 / false=确实未配置 / null=状态检查失败（区别于 false！） */
  configured: boolean | null;
  /** 该 provider 接受的环境变量名（来自 side table，未配置时也有值） */
  envVars: readonly string[];
  /** 面向用户的填写指引 */
  note: string;
  /** 注册模型总数（getModels(id).length，不含配置状态） */
  modelCount: number;
  /** 已配置且通过 filterModels 的模型数；configured=null 时为 null */
  availableModelCount: number | null;
  /** ready 只表示状态检查流程成功，不代表远端服务在线 */
  runtimeStatus: "ready" | "degraded";
  /** degraded 时的固定泛化文案；绝不放原始异常 message（可能含路径/阈值/key 片段） */
  statusMessage: string | null;
}

export interface ProviderListResponse {
  defaultProviderId: string;
  defaultModelId: string;
  providers: ProviderStatus[];
}

/** GET /api/providers/:id/models 响应里单个模型的状态 */
export interface ProviderModelStatus {
  id: string;
  name: string;
  /** 必须同时判 provider 和 model：聚合平台代售同名模型，只判 id 会标错多个默认 */
  isDefault: boolean;
  /**
   * true=凭据完整且通过 filterModels（当前凭据下可选，不代表远端刚验证过）；
   * false=当前不可选（provider 未配置，或被 filterModels 排除）；
   * null=检查失败，可用性未知（区别于 false）。
   */
  available: boolean | null;
}

export interface ProviderModelsResponse {
  provider: { id: string; name: string; isDefault: boolean };
  configured: boolean | null;
  runtimeStatus: "ready" | "degraded";
  statusMessage: string | null;
  models: ProviderModelStatus[];
}

/** side table 缺项时的兜底文案（CI 的 hint parity 测试会让这种代码进不了 main） */
const MISSING_HINT: ProviderCredentialHint = Object.freeze({
  envVars: [] as readonly string[],
  probeModelId: "",
  note: "该 provider 的配置指引尚未维护",
});

/** 固定泛化文案，避免把原始异常 message 透传到响应（可能含路径/阈值/key 片段） */
const STATUS_AUTH_UNAVAILABLE = "凭据状态暂时无法读取";
const STATUS_AVAILABILITY_UNAVAILABLE = "模型可用性暂时无法读取";

/**
 * 把单个 provider 投射成 ProviderStatus。两段 try/catch 区分两种故障：
 * - checkAuth 抛错 → 连 configured 都不知道（null + degraded）
 * - checkAuth 成功但 getAvailable(id) 抛错 → 已知 configured，但不知道可用模型数
 *   （configured 保留真实值，availableModelCount=null + degraded）
 *
 * 注意 getAvailable 必须传 providerId：无参的 getAvailable() 是跨 provider 的 Promise.all，
 * 任意一个 provider 抛错会整体 reject，无法隔离。传了 id 也仍可能抛错（该 provider 自己的
 * filterModels 钩子等），所以照样 try/catch。
 */
async function toProviderStatus(registry: Models, providerId: string, name: string): Promise<ProviderStatus> {
  const hint = PROVIDER_CREDENTIAL_HINTS.get(providerId) ?? MISSING_HINT;
  const isDefault = providerId === DEFAULT_PROVIDER_ID;
  const modelCount = registry.getModels(providerId).length;

  let configured: boolean | null;
  let availableModelCount: number | null;
  let runtimeStatus: "ready" | "degraded";
  let statusMessage: string | null;

  try {
    const auth = await registry.checkAuth(providerId);
    if (auth === undefined) {
      // 未配置：不调 getAvailable（它对未配置 provider 也返回空数组，但多一次解析无意义）
      configured = false;
      availableModelCount = 0;
      runtimeStatus = "ready";
      statusMessage = null;
    } else {
      configured = true;
      // 已配置才查可用模型数；getAvailable(id) 失败时 configured 仍保留 true
      try {
        availableModelCount = (await registry.getAvailable(providerId)).length;
        runtimeStatus = "ready";
        statusMessage = null;
      } catch {
        availableModelCount = null;
        runtimeStatus = "degraded";
        statusMessage = STATUS_AVAILABILITY_UNAVAILABLE;
      }
    }
  } catch {
    // checkAuth 本身抛错：完全不知道配置状态
    configured = null;
    availableModelCount = null;
    runtimeStatus = "degraded";
    statusMessage = STATUS_AUTH_UNAVAILABLE;
  }

  return {
    id: providerId,
    name,
    isDefault,
    configured,
    envVars: hint.envVars,
    note: hint.note,
    modelCount,
    availableModelCount,
    runtimeStatus,
    statusMessage,
  };
}

/**
 * 列出全部运行时 provider 的配置状态。运行时注册顺序即输出顺序（自建云端 → 内置 → 本地）。
 * 并行解析但每个 provider 内部独立 try/catch，单个故障不影响其他项。
 */
export async function listProviderStatusesFor(registry: Models): Promise<ProviderListResponse> {
  const providers = registry.getProviders();
  const statuses = await Promise.all(
    providers.map((provider) => toProviderStatus(registry, provider.id, provider.name)),
  );
  return {
    defaultProviderId: DEFAULT_PROVIDER_ID,
    defaultModelId: DEFAULT_MODEL_ID,
    providers: statuses,
  };
}

export async function listProviderStatuses(): Promise<ProviderListResponse> {
  return listProviderStatusesFor(models);
}

/**
 * 某 provider 的模型目录（懒加载）。provider 不在运行时注册表时返回 undefined，
 * 由路由层翻成 404——这里不抛异常，让调用方区分「不存在」与「存在但查询失败」。
 *
 * 模型目录来自 getModels(id)（静态注册全集，不走 auth）；可用性来自 getAvailable(id)
 *（已配置才查）。未配置 provider 仍返回目录，每个模型 available=false——让前端能展示
 * 「支持这些模型，但当前未配置」。
 */
export async function listProviderModelsFor(
  registry: Models,
  providerId: string,
): Promise<ProviderModelsResponse | undefined> {
  const provider = registry.getProvider(providerId);
  if (!provider) return undefined;

  const isDefault = provider.id === DEFAULT_PROVIDER_ID;
  // 静态目录全集（不走 auth 解析）
  const catalog = provider.getModels();

  // 解析配置状态与可用模型集合，沿用 toProviderStatus 的两段 catch 策略
  let configured: boolean | null;
  let runtimeStatus: "ready" | "degraded";
  let statusMessage: string | null;
  let availableIds: Set<string> | null; // null 表示可用性查询失败，所有模型 available=null

  try {
    const auth = await registry.checkAuth(providerId);
    if (auth === undefined) {
      configured = false;
      runtimeStatus = "ready";
      statusMessage = null;
      availableIds = new Set(); // 空集 → 所有模型 available=false
    } else {
      configured = true;
      try {
        const available = await registry.getAvailable(providerId);
        availableIds = new Set(available.map((m) => m.id));
        runtimeStatus = "ready";
        statusMessage = null;
      } catch {
        availableIds = null;
        runtimeStatus = "degraded";
        statusMessage = STATUS_AVAILABILITY_UNAVAILABLE;
      }
    }
  } catch {
    configured = null;
    runtimeStatus = "degraded";
    statusMessage = STATUS_AUTH_UNAVAILABLE;
    availableIds = null;
  }

  const modelsView: ProviderModelStatus[] = catalog.map((model) => ({
    id: model.id,
    name: model.name,
    // 与 listModels() 同口径：聚合平台代售同名模型时，只有默认 provider 那条算默认
    isDefault: provider.id === DEFAULT_PROVIDER_ID && model.id === DEFAULT_MODEL_ID,
    available: availableIds === null ? null : availableIds.has(model.id),
  }));

  return {
    provider: { id: provider.id, name: provider.name, isDefault },
    configured,
    runtimeStatus,
    statusMessage,
    models: modelsView,
  };
}

export async function listProviderModels(providerId: string): Promise<ProviderModelsResponse | undefined> {
  return listProviderModelsFor(models, providerId);
}

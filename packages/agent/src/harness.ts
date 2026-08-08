import {
  AgentHarness,
  type AgentHarnessTool,
  InMemorySessionRepo,
  Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Database } from "@petrel/database";
import { defaultModel, models as defaultModels, findModel, listModels } from "./models/index.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./models/providers.ts";
import { createUserModels } from "./models/user-models.ts";
import { PgSessionStorage } from "./session/pg-storage.ts";
import { currentTime } from "./tools/current-time.ts";

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

/**
 * 打开一个落在 Postgres 上的会话。
 *
 * 与 createHarness 分开导出，是为了让 harness 的装配可以脱离数据库测试：
 * 测试注入 pi 自带的内存 session，生产注入这一个。
 *
 * userId 用于 HEU-40 的用量归属：每条 usage-bearing entry 双写 token_usage 时带上它。
 * 调用方（harness-registry）在通过归属校验、确认 currentUser 后传入。
 */
export function createPgSession(db: Database, sessionId: string, createdAt: Date, userId: string): Session {
  return new Session(new PgSessionStorage(db, sessionId, createdAt, userId));
}

export interface CreateHarnessOptions {
  /** 会话状态的载体。生产用 createPgSession()，测试用 InMemorySessionRepo。 */
  session: Session;
  /** 初始系统提示；常驻实例后续可通过 before_agent_start hook 按 run 覆盖。 */
  systemPrompt?: string;
  tools?: AgentHarnessTool<undefined>[];
  /** 模型集合，测试注入 faux provider。优先级最高。 */
  models?: Models;
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 models/ 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent，且 pi 的接线只允许出现在 agent 这个 package。
   */
  modelId?: string;
  /**
   * HEU-54 R1 per-user 凭据作用域。提供时构造一个 per-user Models（其 credential
   * store 闭包固化 userId，读用户 DB 凭据），优先级低于显式 models、高于全局 models。
   *
   * 不提供时（stored switch off）用全局 models——行为与 R0 完全一致。
   * 这是 kill switch 的装配侧：storedCredentialsEnabled=false 时 registry 不传它。
   */
  userCredentialScope?: {
    db: Database;
    userId: string;
  };
}

/**
 * 优先级：显式 model > modelId（从 models 查）> 系统默认。
 *
 * 保留 model 这个口子是给测试的：chat.test.ts 与 isolation.test.ts 在模块边界
 * 包一层 createHarness，把 faux provider 的 models/model 铺在调用方 options 之上，
 * 所以它必须能盖掉 modelId。
 *
 * 导出它是因为 harness 常驻：调用方可在复用实例时按新的 modelId 调 `setModel()`。
 *
 * models 参数：从指定 Models 实例解析 modelId。per-session Models 的 harness 必须
 * 从自己的 Models 查 model（否则会把 global Models 的 model 对象塞进另一个 user 的 registry，
 * catalog 漂移或状态错配）。默认用全局 models（向后兼容 R0 调用方）。
 */
export function resolveModel(options: { model?: Model<Api>; modelId?: string; models?: Models }): Model<Api> {
  // 显式 model 对象优先（测试注入用）：它是调用方已解析好的 Model，直接用。
  // 注意这只有在「调用方完全信任」时才该传——per-session Models 场景下，registry 走
  // 的是 modelId 分支（见下方 scoped 查找），不会传 options.model。
  if (options.model) return options.model;

  const scoped = options.models;

  // modelId 缺省 = 系统默认模型。传了 scoped Models 时，默认也必须从 scoped 取
  //（否则会把 global model 对象塞进 per-user harness，catalog 漂移/状态错配）。
  if (options.modelId === undefined) {
    if (scoped) {
      const scopedDefault = scoped.getModel(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID);
      if (scopedDefault) return scopedDefault;
      // scoped 里连默认都没有，说明 PROVIDERS 注册出了问题——fail，不静默回落 global
      throw new Error("per-session Models 中找不到默认模型，装配异常");
    }
    return defaultModel();
  }

  // per-session Models：modelId 只在 scoped 里查，**绝不回落 global**。
  // 回落 global 会绕过 per-session 隔离（B7）：scoped catalog 与 global 因动态 provider
  // 或测试注入产生差异时，会把 global model 对象塞进 user harness。
  if (scoped) {
    for (const provider of scoped.getProviders()) {
      const found = scoped.getModel(provider.id, options.modelId);
      if (found) return found;
    }
    // scoped 里查不到 = 该 model 不属于这个用户可见的 catalog。fail-closed，
    // 可选值只列 scoped catalog（不泄露 global-only 的 model）。
    const scopedIds = scoped
      .getProviders()
      .flatMap((p) => scoped.getModels(p.id).map((m) => m.id))
      .join(" | ");
    throw new Error(`模型未注册：${options.modelId}，可选值为 ${scopedIds}`);
  }

  // 未传 scoped Models（R0 调用方 / 测试用 global）：走全局 findModel
  const model = findModel(options.modelId);
  if (!model) {
    throw new Error(
      `模型未注册：${options.modelId}，可选值为 ${listModels()
        .map((item) => item.id)
        .join(" | ")}`,
    );
  }
  return model;
}

/**
 * 装配一个 pi AgentHarness。所有 pi 的接线都收在这个包里，
 * 上层只依赖本函数与 harness 的事件流，便于将来替换内核。
 *
 * 与被它取代的 createAgent 的关键区别：
 * 1. 吃 models 而不是 streamFn（AgentHarness 自己建 streamFn）；
 * 2. 不吃 messages——历史不再由调用方回灌，harness 自己从 session 读；
 * 3. 落库由 harness 通过 session 完成，不需要外部订阅事件写库。
 *
 * Models 优先级：显式 options.models（测试 faux）> userCredentialScope（per-user DB 凭据）
 * > 全局 defaultModels（R0 行为）。
 */
export function createHarness(options: CreateHarnessOptions): AgentHarness {
  const models = options.models ?? resolveModelsForScope(options.userCredentialScope);
  return new AgentHarness({
    session: options.session,
    models,
    model: resolveModel({ model: options.model, modelId: options.modelId, models }),
    tools: options.tools ?? [currentTime],
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  });
}

/** 有 user scope 就建 per-user Models，否则用全局。scope 为 undefined 时是 R0 行为 */
function resolveModelsForScope(scope: CreateHarnessOptions["userCredentialScope"]): Models {
  if (scope) return createUserModels(scope.db, scope.userId);
  return defaultModels;
}

/**
 * 一次性的内存会话，用于会话表不可用时的降级。
 * 进程重启即丢——这正是「本轮不落库」想要的效果。
 */
export function createMemorySession(sessionId: string): Promise<Session> {
  return new InMemorySessionRepo().create({ id: sessionId });
}

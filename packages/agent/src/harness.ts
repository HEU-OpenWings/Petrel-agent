import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentHarnessToolContextSource,
  InMemorySessionRepo,
  Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Database } from "@petrel/database";
import { defaultModel, models as defaultModels, findModel, listModels } from "./models/index.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "./models/providers.ts";
import { createUserModels } from "./models/user-models.ts";
import { PgSessionStorage } from "./session/pg-storage.ts";
import { getSkills } from "./skills/catalog.ts";
import { selectTools } from "./tools/registry.ts";

/**
 * 从注册表解析工具名到工具对象。供 harness-registry 在切换工具子集时使用：
 * setTools() 需要实际的工具数组，而 apps/server 只持有名字、不应碰 pi 类型。
 */
export function resolveTools(names?: string[]): AgentHarnessTool<ToolContext>[] {
  return selectTools(names);
}

/**
 * 记忆那一句只对使用默认提示词的用户生效：user_preferences.systemPrompt 是整体替换，
 * 自定义之后这句就没了。不为此在用户写的提示词上偷偷追加内容——
 * 工具的 description 才是主要引导手段，它不受这个影响。
 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。" +
  "你拥有跨会话的长期记忆：回答与用户本人相关的问题前先用 memory_search 回忆，" +
  "用户透露稳定的偏好、身份或长期目标时用 memory_write 记下来。";

/**
 * 工具执行时携带的调用者上下文。
 *
 * 仅含 userId 与 sessionId——不给工具整个 user 对象（email / role 等与工具无关）。
 * 用函数形式注入：常驻 harness 下静态值会冻住首次装配时的上下文，
 * 函数形式每次工具执行时重新求值，确保拿到的是当前请求的身份。
 */
export interface ToolContext {
  userId: string;
  sessionId: string;
}

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
  /**
   * 直接注入工具对象。测试用（faux harness 绕过注册表）。
   * 与 activeToolNames 互斥：传了 tools 就用它，忽略 activeToolNames。
   */
  tools?: AgentHarnessTool<ToolContext>[];
  /**
   * 从注册表按名选工具。生产路径用这个：apps/server 只传名字、不碰 pi 的工具类型，
   * 守住「pi 的接线只在 agent 与 ai」这条约束。
   *
   * undefined 表示取全部 enabled 的工具；[] 表示一个工具都不用。
   */
  activeToolNames?: string[];
  /**
   * 工具执行时注入的调用者上下文。
   *
   * 必填——TContext 不再是 undefined，pi 强制要求非 undefined 时提供 toolContext。
   * 用函数形式而不是静态值：harness 按 sessionId 常驻，静态值会冻住首次装配时的值。
   */
  toolContext: AgentHarnessToolContextSource<ToolContext>;
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
export function createHarness(options: CreateHarnessOptions): AgentHarness<ToolContext> {
  const models = options.models ?? resolveModelsForScope(options.userCredentialScope);
  const tools = options.tools ?? selectTools(options.activeToolNames);
  return new AgentHarness({
    session: options.session,
    models,
    model: resolveModel({ model: options.model, modelId: options.modelId, models }),
    tools,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    toolContext: options.toolContext,
    // 供 harness.skill()（阶段二的 /skill: 显式调用）解析 skill；模型自主路径走 read_skill
    // 工具，不经这里。skill 是全局静态资源，装配时读一次即可。
    resources: { skills: getSkills() },
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

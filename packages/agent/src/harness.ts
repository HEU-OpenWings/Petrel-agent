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
import { PgSessionStorage } from "./session/pg-storage.ts";
import { selectTools } from "./tools/registry.ts";

/**
 * 从注册表解析工具名到工具对象。供 harness-registry 在切换工具子集时使用：
 * setTools() 需要实际的工具数组，而 apps/server 只持有名字、不应碰 pi 类型。
 */
export function resolveTools(names?: string[]): AgentHarnessTool<ToolContext>[] {
  return selectTools(names);
}

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

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
  /** 模型集合，测试注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 models/ 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent，且 pi 的接线只允许出现在 agent 这个 package。
   */
  modelId?: string;
}

/**
 * 优先级：显式 model > modelId > 系统默认。
 *
 * 保留 model 这个口子是给测试的：chat.test.ts 与 isolation.test.ts 在模块边界
 * 包一层 createHarness，把 faux provider 的 models/model 铺在调用方 options 之上，
 * 所以它必须能盖掉 modelId。
 *
 * 导出它是因为 harness 常驻：调用方可在复用实例时按新的 modelId 调 `setModel()`。
 */
export function resolveModel(options: { model?: Model<Api>; modelId?: string }): Model<Api> {
  if (options.model) return options.model;
  if (options.modelId === undefined) return defaultModel();

  const model = findModel(options.modelId);
  if (!model) {
    // 列出可选值：只说「未注册」的话调用方不知道该改成什么。
    // 注意经 routes/chat.ts 的请求走不到这里——那边在进 streamSSE 之前
    // 已经用同一份白名单校验过并返回 400 了。这条兜的是其他调用方
    // （或将来忘了预校验的新调用方）
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
 */
export function createHarness(options: CreateHarnessOptions): AgentHarness<ToolContext> {
  const models = options.models ?? defaultModels;
  const tools = options.tools ?? selectTools(options.activeToolNames);
  return new AgentHarness({
    session: options.session,
    models,
    model: resolveModel(options),
    tools,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    toolContext: options.toolContext,
  });
}

/**
 * 一次性的内存会话，用于会话表不可用时的降级。
 * 进程重启即丢——这正是「本轮不落库」想要的效果。
 */
export function createMemorySession(sessionId: string): Promise<Session> {
  return new InMemorySessionRepo().create({ id: sessionId });
}

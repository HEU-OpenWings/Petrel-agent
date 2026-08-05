import {
  AgentHarness,
  type AgentHarnessTool,
  InMemorySessionRepo,
  Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defaultModel, models as defaultModels, findModel, listModels } from "@petrel/ai";
import type { Database } from "@petrel/database";
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
  /** 模型集合，测试注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 @petrel/ai 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent → ai，且 pi 的接线只允许出现在 agent 与 ai 两个 package。
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
export function createHarness(options: CreateHarnessOptions): AgentHarness {
  const models = options.models ?? defaultModels;
  return new AgentHarness({
    session: options.session,
    models,
    model: resolveModel(options),
    tools: options.tools ?? [currentTime],
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  });
}

/**
 * 一次性的内存会话，用于会话表不可用时的降级。
 * 进程重启即丢——这正是「本轮不落库」想要的效果。
 */
export function createMemorySession(sessionId: string): Promise<Session> {
  return new InMemorySessionRepo().create({ id: sessionId });
}

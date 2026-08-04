import {
  AgentHarness,
  type AgentHarnessTool,
  InMemorySessionRepo,
  Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defaultModel, models as defaultModels } from "@petrel/ai";
import type { Database } from "@petrel/database";
import { PgSessionStorage } from "./session/pg-storage.ts";
import { currentTime } from "./tools/current-time.ts";

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

/**
 * 打开一个落在 Postgres 上的会话。
 *
 * 与 createHarness 分开导出，是为了让 harness 的装配可以脱离数据库测试：
 * 测试注入 pi 自带的内存 session，生产注入这一个。
 */
export function createPgSession(db: Database, sessionId: string, createdAt: Date): Session {
  return new Session(new PgSessionStorage(db, sessionId, createdAt));
}

export interface CreateHarnessOptions {
  /** 会话状态的载体。生产用 createPgSession()，测试用 InMemorySessionRepo。 */
  session: Session;
  /**
   * 系统提示。只在装配时生效——AgentHarness 没有 setSystemPrompt()，
   * 常驻实例被复用时后续请求传的 systemPrompt 不会生效（见 spec §5）。
   */
  systemPrompt?: string;
  tools?: AgentHarnessTool<undefined>[];
  /** 模型集合，测试注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
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
    model: options.model ?? defaultModel(),
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

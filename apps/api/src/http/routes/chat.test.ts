import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { CreateAgentOptions } from "@petrel/agent-core";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../services/session.ts";
import { app } from "../app.ts";

/**
 * state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通的顶层变量。
 * 类型标注不受影响（编译期就擦掉了）。
 */
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  /** 打开后 getDb() 直接抛，用来模拟数据库不可用 */
  dbBroken: false,
  agentOptions: undefined as CreateAgentOptions | undefined,
}));

/**
 * 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，
 * 所以整个模块替身一次，把它换成测试库（同 routes/sessions.test.ts）。
 */
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return {
    ...actual,
    getDb: () => {
      if (state.dbBroken) {
        throw new Error("database unavailable");
      }
      // getDb 的签名只认 NodePgDatabase，断言一次把 PGlite 实例塞进去
      return state.db as unknown as ReturnType<typeof actual.getDb>;
    },
  };
});

/**
 * chat 路由里的 createAgent() 是直接调的，测试得让它走 faux provider 而不是真实模型
 * （仓库里没有 SILICONFLOW_API_KEY）。
 *
 * 没有给生产代码开注入口子：路由要保持薄，而且那个口子只有测试会用。
 * 改成在模块边界包一层——底下调的仍是真的 createAgent，只是补上 faux 的 models/model，
 * 所以 agent loop、事件序列、attachPersistence 都是真在跑，没有 mock agent 内部。
 */
vi.mock("@petrel/agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent-core")>();
  return {
    ...actual,
    createAgent: (options: CreateAgentOptions = {}) =>
      actual.createAgent({ ...options, ...state.agentOptions }),
  };
});

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

let service: ReturnType<typeof createSessionService>;
let faux: ReturnType<typeof fauxProvider>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  service = createSessionService(testDb.db);

  faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  state.agentOptions = { models, model: faux.getModel() };
});

beforeEach(async () => {
  state.dbBroken = false;
  await reset();
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

function post(body: string) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/** 跑完一轮对话，返回读干净的 SSE 文本。流读完就意味着 handler（含落库）已结束 */
async function chatTurn(body: Record<string, unknown>) {
  const response = await post(JSON.stringify(body));
  const text = await response.text();
  return { response, text };
}

/** 把 SSE 文本还原成 (event, data) 对，用来断言协议没变 */
function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      return { event, data: JSON.parse(data) as unknown };
    });
}

/** 取一条消息里的纯文本，pi 的 user/assistant 消息 content 都是内容块数组 */
function textOf(message: unknown): string {
  const content = (message as { content?: { text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("");
}

function roleOf(message: unknown): string {
  return (message as { role?: string }).role ?? "";
}

describe("POST /api/chat 请求体校验", () => {
  // 这些请求体都能让「先当成 { message: string } 用」的写法抛 TypeError，
  // 被 error 中间件兜成 500——客户端错误却报服务端错误，还白打一条 stack 日志
  it.each([
    { name: "body 是 null", body: "null" },
    { name: "body 是数组", body: "[]" },
    { name: "body 是字符串", body: '"abc"' },
    { name: "body 是数字", body: "123" },
    { name: "没有 message", body: "{}" },
    { name: "message 是 null", body: '{"message":null}' },
    { name: "message 是数字", body: '{"message":123}' },
    { name: "message 是对象", body: '{"message":{}}' },
    { name: "message 是数组", body: '{"message":[]}' },
    { name: "message 只有空白", body: '{"message":"   "}' },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "message 不能为空" } });
  });

  it("请求体不是 JSON 返回 400", async () => {
    const response = await post("not json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "请求体必须是 JSON" } });
  });

  it.each([
    { name: "缺 sessionId", body: { message: "你好" } },
    { name: "sessionId 不是 UUID", body: { message: "你好", sessionId: "not-a-uuid" } },
    { name: "sessionId 是数字", body: { message: "你好", sessionId: 123 } },
    { name: "sessionId 是 null", body: { message: "你好", sessionId: null } },
  ])("$name 返回 400，且不碰数据库", async ({ body }) => {
    const response = await post(JSON.stringify(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "sessionId 必须是 UUID" } });
    // 校验在 prepareSession 之前，所以既没有建会话也没有写消息
    expect(await service.list()).toEqual([]);
  });
});

describe("POST /api/chat 会话持久化", () => {
  it("一轮对话后 user 与 assistant 都落库，seq 从 1 连续", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel")])]);

    const { response } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.status).toBe(200);

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages.map(roleOf)).toEqual(["user", "assistant"]);
    expect(textOf(history.messages[0])).toBe("你好");
    expect(textOf(history.messages[1])).toBe("你好，我是 Petrel");
    // nextSeq = 3 说明这两条占的是 1 和 2
    expect(history.nextSeq).toBe(3);
    expect(history.interruptedSeqs).toEqual([]);
  });

  it("会话不存在时自动建出来，标题取首条消息前 30 字", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好的")])]);

    await chatTurn({ message: "一".repeat(40), sessionId: SESSION_ID });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(SESSION_ID);
    expect(list[0]?.title).toBe(`${"一".repeat(30)}…`);
  });

  it("第二轮把上一轮的历史回灌给模型，seq 接着往下排", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("第一轮回答")])]);
    await chatTurn({ message: "第一轮提问", sessionId: SESSION_ID });

    // 用工厂形态的响应把 provider 实际收到的上下文录下来，
    // 这样断言的是「模型真看见了历史」，而不只是库里的行数对得上
    const seen: { messages: unknown[]; sessionId?: string }[] = [];
    faux.setResponses([
      (context, options) => {
        seen.push({ messages: context.messages, sessionId: options?.sessionId });
        return fauxAssistantMessage([fauxText("第二轮回答")]);
      },
    ]);
    await chatTurn({ message: "第二轮提问", sessionId: SESSION_ID });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.map(roleOf)).toEqual(["user", "assistant", "user"]);
    expect(seen[0]?.messages.map(textOf)).toEqual(["第一轮提问", "第一轮回答", "第二轮提问"]);
    // pi 的 Agent 顶层 sessionId 会随每次请求下发给 provider（agent-loop 把 config 整个摊给 streamFn）
    expect(seen[0]?.sessionId).toBe(SESSION_ID);

    const history = await service.loadHistory(SESSION_ID);
    // 1、2 是上一轮，3、4 是这一轮：没有从 1 重来，也没有把回灌的历史重复写一遍
    expect(history.messages).toHaveLength(4);
    expect(history.nextSeq).toBe(5);
  });

  it("数据库不可用时照常流式输出，只是这一轮不落库", async () => {
    state.dbBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("照常回答")])]);

    const { response, text } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.status).toBe(200);
    expect(text).toContain("照常回答");

    state.dbBroken = false;
    expect(await service.list()).toEqual([]);
    expect((await service.loadHistory(SESSION_ID)).messages).toEqual([]);
  });
});

describe("POST /api/chat SSE 协议", () => {
  it("仍然只发 event: agent，data 是 pi 的 AgentEvent 原文", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);

    const { response, text } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(text);
    expect(events.every((entry) => entry.event === "agent")).toBe(true);

    // 前端 useAgentStream.js 就是按这些 type 归约消息状态的，顺序和名字都不能变
    const types = events.map((entry) => (entry.data as { type: string }).type);
    expect(types.filter((type) => type !== "message_update")).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });
});

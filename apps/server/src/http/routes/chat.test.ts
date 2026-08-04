import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { type CreateHarnessOptions, DEFAULT_SYSTEM_PROMPT } from "@petrel/agent";
import { createEntryRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../services/session.ts";
import { app } from "../app.ts";
import { __resetRegistry } from "./chat.ts";

/**
 * state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通的顶层变量。
 * 类型标注不受影响（编译期就擦掉了）。
 */
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  /** 打开后 getDb() 直接抛，用来模拟整库不可用（连鉴权都查不出身份） */
  dbBroken: false,
  /** 打开后只有会话仓储的查询失败，鉴权用的用户查询照常，用来模拟「已登录但会话表读写不了」 */
  sessionRepoBroken: false,
  harnessOptions: undefined as Partial<CreateHarnessOptions> | undefined,
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
    /**
     * 故障粒度要比 getDb 更细：鉴权（createUserRepository）与会话仓储走的是
     * 同一个 db，整个 getDb 抛掉就只能覆盖「身份都验不出来」那条路径，
     * registry.acquire 的 catch-and-degrade 分支（已登录、但会话仓储查不动）就没人覆盖了。
     * 这里只让会话仓储失败，且失败发生在查询时而不是建仓储时——真实故障就是这个形态。
     */
    createSessionRepository: (...args: Parameters<typeof actual.createSessionRepository>) => {
      const repo = actual.createSessionRepository(...args);
      if (!state.sessionRepoBroken) return repo;
      return { ...repo, upsert: () => Promise.reject(new Error("database unavailable")) };
    },
  };
});

/**
 * chat 路由里的 registry 装配的是真的 createHarness()，测试得让它走 faux provider
 * 而不是真实模型（仓库里没有 SILICONFLOW_API_KEY）。
 *
 * 没有给生产代码开注入口子：路由要保持薄，而且那个口子只有测试会用。
 * 改成在模块边界包一层——底下调的仍是真的 createHarness，只是补上 faux 的 models/model，
 * 所以 harness、agent loop、落库都是真在跑，没有 mock 任何内部。
 */
vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    createHarness: (options: CreateHarnessOptions) =>
      actual.createHarness({ ...options, ...state.harnessOptions }),
  };
});

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/**
 * 分块由 tokenSize 决定：faux 每块吐 tokenSize * 4 个字符，min/max 都取 1 就是每块 4 字。
 * 中断用例要靠这个把回答切成多块，才有「流到一半」这个时刻。
 */
const CHUNKED = { tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } };
const LONG_ANSWER = "一".repeat(40);

let service: ReturnType<typeof createSessionService>;
let entryRepo: ReturnType<typeof createEntryRepository>;
let faux: ReturnType<typeof fauxProvider>;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let cookie: string;

/** 注册一个用户并返回它的 cookie（同 admin.test.ts 的 registerUser） */
async function registerUser(email: string): Promise<{ cookie: string; id: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  return { cookie: (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "", id: body.user.id };
}

/** 注册一个新用户并返回它的 cookie，用来跨用户测越权场景 */
async function registerAndLogin(email: string): Promise<string> {
  return (await registerUser(email)).cookie;
}

/** 换一套 faux provider 并让后续请求的 createHarness 用它；默认是不分块的快回答 */
function useFaux(options: Parameters<typeof fauxProvider>[0] = { tokensPerSecond: 10_000 }) {
  faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  state.harnessOptions = { models, model: faux.getModel() };
}

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  entryRepo = createEntryRepository(testDb.db);
});

beforeEach(async () => {
  state.dbBroken = false;
  state.sessionRepoBroken = false;
  state.harnessOptions = undefined;
  useFaux();
  await reset();
  __resetRegistry();
  const user = await registerUser("a@x.io");
  cookie = user.cookie;
  service = createSessionService(state.db!, user.id);
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 发一次对话请求，带当前用户的 cookie */
function postChat(
  body: { message: string; sessionId: string; systemPrompt?: unknown },
  init: RequestInit = {},
) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
    ...init,
  });
}

/** 把 SSE 流读干，返回原文 */
async function readAll(response: Response): Promise<string> {
  return response.text();
}

/**
 * 持续把响应流读干，同时提供「第一个字节已到达」的信号。
 *
 * 只读一次就撒手不管会触发 ReadableStream 的背压：writeSSE 迟迟等不到消费者，
 * 会一路阻塞回 harness 的事件订阅回调，进而卡住 registry 里那份维护 running
 * 标记与落库的常驻订阅——同一会话的 abort 请求因此永远等不到 stopReason。
 * 「用户点了停止但没关标签页」是真实场景，连接必须持续被读干。
 */
function drain(response: Response): { firstByte: Promise<void>; done: Promise<string> } {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE 响应没有 body");
  const decoder = new TextDecoder();
  let text = "";
  let resolveFirstByte = () => {};
  const firstByte = new Promise<void>((resolve) => {
    resolveFirstByte = resolve;
  });
  let sawFirstByte = false;

  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      text += decoder.decode(value, { stream: true });
      if (!sawFirstByte) {
        sawFirstByte = true;
        resolveFirstByte();
      }
    }
    return text;
  })();

  return { firstByte, done };
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

/** 会话里所有 message 条目的 role 序列，用来替代原先对 messages 表的 seq 断言 */
async function storedRoles(sessionId = SESSION_ID): Promise<string[]> {
  const rows = await entryRepo.listAll(sessionId);
  return rows
    .filter((row) => row.type === "message")
    .map((row) => (row.payload as { message: { role: string } }).message.role);
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
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "message 必须是非空字符串" },
    });
  });

  it("请求体不是 JSON 返回 400", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "not json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "请求体必须是 JSON" } });
  });

  it.each([
    { name: "缺 sessionId", body: { message: "你好" } },
    { name: "sessionId 不是 UUID", body: { message: "你好", sessionId: "not-a-uuid" } },
    { name: "sessionId 是数字", body: { message: "你好", sessionId: 123 } },
    { name: "sessionId 是 null", body: { message: "你好", sessionId: null } },
  ])("$name 返回 400，且不碰数据库", async ({ body }) => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "sessionId 必须是 UUID" } });
    // 校验在 registry.acquire 之前，所以既没有建会话也没有写条目
    expect(await service.list()).toEqual([]);
  });
});

describe("POST /api/chat 会话持久化", () => {
  it("一轮对话后 user 与 assistant 都进了会话树", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    await readAll(response);

    expect(await storedRoles()).toEqual(["user", "assistant"]);
  });

  it("会话不存在时自动建出来，标题取首条消息前 30 字", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好的")])]);

    await readAll(await postChat({ message: "一".repeat(40), sessionId: SESSION_ID }));

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(SESSION_ID);
    expect(list[0]?.title).toBe(`${"一".repeat(30)}…`);
  });

  it("第二轮能看到第一轮的上下文，不需要调用方回灌", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("第一轮回答")])]);
    await readAll(await postChat({ message: "第一个问题", sessionId: SESSION_ID }));

    let seen: unknown[] | undefined;
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage([fauxText("第二轮回答")]);
      },
    ]);
    await readAll(await postChat({ message: "第二个问题", sessionId: SESSION_ID }));

    // 历史由 harness 自己从 session 读出来，chat 路由一行回灌代码都没有
    expect(JSON.stringify(seen)).toContain("第一轮回答");
    expect(await storedRoles()).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("连接断开后 agent 继续跑完，回答完整落库", async () => {
    // 分块吐字才有「流到一半」这个时刻；tokenSize/tokensPerSecond 是 fauxProvider
    // 实例化时定死的，不能事后切换，所以要整个换一套 faux（同 useFaux 的用法）
    useFaux(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);

    const controller = new AbortController();
    const response = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ message: "讲个长故事", sessionId: SESSION_ID }),
        signal: controller.signal,
      },
      undefined,
    );
    // 读到第一块就掐断连接
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE 响应没有 body");
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // 关键：断开不再等于停止，等它自己跑完
    await vi.waitFor(async () => {
      const roles = await storedRoles();
      expect(roles).toEqual(["user", "assistant"]);
    }, 5000);
    const rows = await entryRepo.listAll(SESSION_ID);
    expect(JSON.stringify(rows)).toContain(LONG_ANSWER);
  });

  it("同一会话连发两条，第二条排队后也落库", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一轮回答")]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const [first, second] = await Promise.all([
      postChat({ message: "第一个问题", sessionId: SESSION_ID }),
      postChat({ message: "第二个问题", sessionId: SESSION_ID }),
    ]);
    await Promise.all([readAll(first), readAll(second)]);

    await vi.waitFor(async () => {
      expect(await storedRoles()).toEqual(["user", "assistant", "user", "assistant"]);
    }, 5000);
  });

  it("POST /api/chat/abort 停掉正在跑的会话", async () => {
    useFaux(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);

    const response = await postChat({ message: "讲个长故事", sessionId: SESSION_ID });
    // 客户端连接始终开着（用户没关标签页），所以要持续读干，否则背压会卡住 harness
    const { firstByte, done } = drain(response);
    await firstByte;

    const aborted = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(aborted.status).toBe(200);

    // 流会在 harness 跑完这一轮（含 abort 触发的收尾）后自然结束
    await done;
    // 半截回答仍然落库，标记由消息自带的 stopReason 表达，不再有 interrupted 列
    await vi.waitFor(async () => {
      const rows = await entryRepo.listAll(SESSION_ID);
      expect(JSON.stringify(rows)).toContain('"stopReason":"aborted"');
    }, 5000);
  });

  it("abort 别人的会话返回 403", async () => {
    const otherCookie = await registerAndLogin("other@example.com");
    const response = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(403);
  });

  /**
   * Task 10 之前这里断言的是「数据库不可用时照常流式输出，只是这一轮不落库」——
   * 那时 chat 没有认证，registry.acquire 的 try/catch 是数据库唯一会被摸到的地方。
   * 挂上 requireAuth 之后，鉴权本身也要查库（resolveUser 用 cookie 里的 sub 查用户），
   * 库不可用时连身份都验不出来，请求进不到 handler 就已经失败——这是 fail-closed，
   * 不是回归：宁可拒绝服务，也不能在验不出身份时还把请求当成已登录处理。
   */
  it("数据库不可用时鉴权本身就会失败，请求进不到 chat handler", async () => {
    state.dbBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("照常回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const text = await readAll(response);

    expect(response.status).toBe(500);
    expect(text).not.toContain("照常回答");

    state.dbBroken = false;
    expect(await service.list()).toEqual([]);
  });

  /**
   * 上面那条覆盖的是「身份都验不出来」，这条才是 registry.acquire 的降级分支：
   * 用户已经登录（鉴权的用户查询正常），但会话仓储查不动。
   * 这时对话必须照常进行，只是这一轮不落库——能用但记不住，好过直接不能用。
   */
  it("已登录但会话仓储查库失败时照常流式输出，只是这一轮不落库", async () => {
    state.sessionRepoBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("降级也能答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const body = await readAll(response);

    // upsert 抛错 → 降级成内存会话，SSE 照常输出
    expect(response.status).toBe(200);
    expect(body).toContain("降级也能答");
    expect(body).not.toContain("event: error");
    // 但这一轮什么都没落库
    expect(await storedRoles()).toEqual([]);
  });

  /**
   * 与上一条的区别是这条存在的价值：upsert 返回 false 是越权（403），
   * upsert 抛错是故障（降级）。两者共用一个返回值就会把越权也降级成
   * 「照常对话」，等于把归属校验绕过去了。
   */
  it("会话 id 属于别人时返回 403，不降级", async () => {
    // 先用当前用户建出这个会话
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    await readAll(await postChat({ message: "你好", sessionId: SESSION_ID }));

    const otherCookie = await registerAndLogin("other@example.com");
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ message: "偷看", sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(403);
  });
});

describe("POST /api/chat systemPrompt", () => {
  /** 录下 provider 实际收到的 systemPrompt */
  function recordSystemPrompt() {
    const seen: (string | undefined)[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("回答")]);
      },
    ]);
    return seen;
  }

  it("合法的 systemPrompt 会传给模型", async () => {
    const seen = recordSystemPrompt();

    await readAll(await postChat({ message: "你好", sessionId: SESSION_ID, systemPrompt: "你是测试助手" }));

    expect(seen).toEqual(["你是测试助手"]);
  });

  // 断言式泛型时代这些值会被原样塞进 initialState.systemPrompt 发给模型
  it.each([
    { name: "数字", value: 123 },
    { name: "对象", value: {} },
    { name: "null", value: null },
  ])("systemPrompt 是$name 时被丢弃，回落到默认提示词", async ({ value }) => {
    const seen = recordSystemPrompt();

    await readAll(await postChat({ message: "你好", sessionId: SESSION_ID, systemPrompt: value }));

    expect(seen).toEqual([DEFAULT_SYSTEM_PROMPT]);
  });

  /**
   * AgentHarness 没有 setSystemPrompt()，常驻实例被复用时第二次的提示不生效。
   * 这条用例存在的意义就是把这个行为钉住，否则将来有人传了新提示却查不出为什么没用
   */
  it("systemPrompt 只在会话首次装配时生效", async () => {
    const seen: (string | undefined)[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("一")]);
      },
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("二")]);
      },
    ]);

    await readAll(await postChat({ message: "一", sessionId: SESSION_ID, systemPrompt: "第一个提示" }));
    await readAll(await postChat({ message: "二", sessionId: SESSION_ID, systemPrompt: "第二个提示" }));

    expect(seen[0]).toBe("第一个提示");
    expect(seen[1]).toBe("第一个提示");
  });
});

describe("POST /api/chat SSE 协议", () => {
  it("仍然只发 event: agent，data 是 pi 的 AgentEvent 原文", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const text = await readAll(response);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(text);
    expect(events.every((entry) => entry.event === "agent")).toBe(true);

    // 前端 useAgentStream.js 就是按这些 type 归约消息状态的，顺序和名字都不能变。
    // AgentHarness 比裸 Agent 多发 after_provider_response / save_point / settled——
    // 这是它自己落库与维护 running 标记要用的信号，前端按类型归约，多出来的类型不影响
    const types = events.map((entry) => (entry.data as { type: string }).type);
    expect(types.filter((type) => type !== "message_update")).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "after_provider_response",
      "message_start",
      "message_end",
      "turn_end",
      "save_point",
      "agent_end",
      "settled",
    ]);
  });
});

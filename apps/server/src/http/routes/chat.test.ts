import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { type CreateHarnessOptions, DEFAULT_SYSTEM_PROMPT } from "@petrel/agent";
import {
  createEntryRepository,
  createQuotaLimitsRepository,
  createTokenUsageRepository,
  createUserRepository,
} from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../services/session.ts";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";
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
  /** 记录路由实际传给 createHarness 的选项，用来断言 modelId 有没有透传 */
  seenHarnessOptions: undefined as Partial<CreateHarnessOptions> | undefined,
  /** HEU-40 配额测试开关：默认沿用真实 env（enforcement=false，不拦截） */
  quotaEnforcement: false,
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
 * HEU-40：mock @petrel/config 透传真实 env，只让 quotaEnforcement 可切换。
 * 配额测试用例开它测拦截；其余用例默认 false 不拦截。
 */
vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get quotaEnforcement() {
        return state.quotaEnforcement;
      },
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
    createHarness: (options: CreateHarnessOptions) => {
      state.seenHarnessOptions = options;
      return actual.createHarness({ ...options, ...state.harnessOptions });
    },
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
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await createUserRepository(state.db!).setEmailVerified(body.user.id, new Date());
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return { cookie: (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "", id: body.user.id };
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
  state.quotaEnforcement = false;
  useFaux();
  await reset();
  __resetAuthRateLimits();
  __resetRegistry();
  const user = await registerUser("a@x.io");
  cookie = user.cookie;
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  service = createSessionService(state.db!, user.id);
  state.seenHarnessOptions = undefined;
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

  // HEU-37 验收：首轮以 error 收尾时，排队的第二条不能静默丢失
  it("首轮以 error 收尾时，并发排队的第二条消息仍被回答并落库", async () => {
    useFaux(CHUNKED);
    faux.setResponses([
      fauxAssistantMessage([fauxText("答")], { stopReason: "error" }),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    // 先发第一条并等到首轮真正开始（firstByte），再发第二条——保证第二条进排队
    // 分支而不是落在首轮结束后的 idle 路径，避免并发时序抖动消费错 faux 响应
    const first = await postChat({ message: "第一个问题", sessionId: SESSION_ID });
    const { firstByte: firstStarted, done: firstDone } = drain(first);
    await firstStarted;

    const second = await postChat({ message: "第二个问题", sessionId: SESSION_ID });
    const { done: secondDone } = drain(second);

    const secondText = await secondDone;
    await firstDone;

    // 第二条连接不能静默空流：必须带着答案正常收尾
    expect(secondText).toContain("第二轮回答");
    const secondEvents = parseSse(secondText);
    expect(secondEvents.map((entry) => (entry.data as { type: string }).type)).toContain("agent_end");

    await vi.waitFor(async () => {
      expect(await storedRoles()).toEqual(["user", "assistant", "user", "assistant"]);
    }, 5000);
  });

  // HEU-37 验收：abort 只停当前轮，排队中的消息照常被回答并落库
  it("abort 只停当前轮，排队中的消息仍被回答并落库", async () => {
    useFaux(CHUNKED);
    faux.setResponses([
      fauxAssistantMessage([fauxText(LONG_ANSWER)]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const first = await postChat({ message: "第一个问题", sessionId: SESSION_ID });
    const { firstByte: firstStarted, done: firstDone } = drain(first);
    await firstStarted;

    const second = await postChat({ message: "第二个问题", sessionId: SESSION_ID });
    const { done: secondDone } = drain(second);

    // 首轮还在跑时 abort：排队中的第二条不能被静默丢弃
    await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const secondText = await secondDone;
    await firstDone;
    expect(secondText).toContain("第二轮回答");

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

  /**
   * 核心回归用例：曾经 subscribe 回调里直接 `await stream.writeSSE(...)`，
   * 客户端完全不读流时 hono streamSSE 的 TransformStream 背压会让 writer.write()
   * 永不 resolve，直接冻死 pi 的 emitAny/emitOwn（串行 await、无超时），
   * 进而冻住 registry 维护 running 标记的常驻订阅——同会话的 abort 会跟着永远挂住。
   *
   * 故意不读 postChat() 返回的响应体，模拟「连上了但从不读流」的客户端
   * （比如 curl 不接 --no-buffer，或者只是挂着的浏览器标签页），
   * 断言同会话的 abort 请求仍能在默认的测试超时内返回 200。
   */
  it("慢客户端不读流也不会卡住 harness：同会话的 abort 仍然及时返回", async () => {
    useFaux(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);

    // 不读它的 body，故意留着背压
    await postChat({ message: "讲个长故事", sessionId: SESSION_ID });

    const aborted = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    expect(aborted.status).toBe(200);
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
   *
   * HEU-40 的 fail-closed：降级到内存会话（persistence="memory"）时 usage 不落库。
   * 该行为**受 QUOTA_ENFORCEMENT 开关控制**（review 🟡#7）：
   * - enforcement 开启：503 不调用模型（不能让用户通过触发降级绕过配额计量）；
   * - enforcement 关闭：放行，恢复配额引入前的「能聊不落库」——开关才是真正的 kill switch。
   * 两条用例共同覆盖 flag on/off × dependency failed 矩阵。
   */
  it("enforcement 开启时，会话仓储查库失败 → fail-closed 503，不调用模型", async () => {
    state.quotaEnforcement = true;
    state.sessionRepoBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("降级也该被挡")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const body = await readAll(response);

    // upsert 抛错 → 降级成内存会话 → chat 检测 persistence=memory → 503，模型未启动
    expect(response.status).toBe(503);
    expect(body).not.toContain("降级也该被挡");
    // 没有调用模型，也没有落库
    expect(await storedRoles()).toEqual([]);
  });

  it("enforcement 关闭时，会话仓储查库失败 → 放行（kill switch 可回滚旧行为）", async () => {
    state.quotaEnforcement = false;
    state.sessionRepoBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("降级也照常回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const body = await readAll(response);

    // enforcement=false 是真正的 kill switch：降级也放行，恢复配额引入前的可用性
    expect(response.status).toBe(200);
    expect(body).toContain("降级也照常回答");
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

  it("复用常驻实例时使用最新的 systemPrompt", async () => {
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
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("三")]);
      },
    ]);

    await readAll(await postChat({ message: "一", sessionId: SESSION_ID, systemPrompt: "第一个提示" }));
    await readAll(await postChat({ message: "二", sessionId: SESSION_ID, systemPrompt: "第二个提示" }));
    await readAll(await postChat({ message: "三", sessionId: SESSION_ID }));

    expect(seen[0]).toBe("第一个提示");
    expect(seen[1]).toBe("第二个提示");
    expect(seen[2]).toBe(DEFAULT_SYSTEM_PROMPT);
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

describe("模型选择", () => {
  it("合法的 model 透传给 createHarness", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "deepseek-ai/DeepSeek-V3",
      }),
    });
    // SSE 响应读干净才意味着 handler 已经跑完
    await response.text();

    expect(response.status).toBe(200);
    expect(state.seenHarnessOptions?.modelId).toBe("deepseek-ai/DeepSeek-V3");
  });

  // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
  it("未注册的 model 返回 400，且压根不进 harness", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "gpt-does-not-exist",
      }),
    });

    expect(response.status).toBe(400);
    expect(state.seenHarnessOptions).toBeUndefined();
  });

  /**
   * 守的是「兜默认值是 createHarness 的职责，路由不许注入默认模型」。
   *
   * 注意这条不由 TDD 驱动——实现之前它就是绿的（那时压根不解析 model）。
   * 它的价值在于能被有意义的变异打红：若有人把 parseChatRequest 改成
   * `model = rawModel ?? DEFAULT_MODEL_ID` 之类，这里就会拿到一个非 undefined 的
   * modelId 而变红。路由一旦自己兜默认，createHarness 里
   * 「modelId === undefined → defaultModel()」那条分支就永远走不到，
   * 将来改 packages/agent 的 DEFAULT_MODEL_ID 会出现「改了却不生效」的怪问题。
   * 别因为它「看起来是恒真的」就删掉。
   */
  it("不传 model 时路由不注入 modelId，默认值交给 createHarness 兜", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "你好", sessionId: SESSION_ID }),
    });
    await response.text();

    expect(state.seenHarnessOptions?.modelId).toBeUndefined();
  });
});

describe("自动压缩", () => {
  /**
   * 换一套小窗口 faux，并把会话树填到超阈值。
   *
   * 窗口取 48000（阈值 38400）而不是 40000：40000 会让 fixture 落在「内容 40000 =
   * 窗口 40000」这个不真实的区间——压缩失败或被守卫挡住之后模型照样「成功」应答，
   * 但 usage.input（含 system prompt 等固定开销）已经超过窗口，被 pi-ai 的静默溢出
   * 检测判成真实溢出，于是这一轮会继续走 (d) 兜底、最后以 `event: error` 收尾。
   * 那样下面那条用例名义上在验「pre-prompt 压缩失败的帧」，实际验的是一条四段
   * 混合路径，用 find() 任取一个 failed 帧还照样通过。48000 之后是
   * 「阈值 38400 < 内容 40000 < 窗口 48000」，压缩该触发照常触发，失败也不会连带
   * 被判成溢出。harness-registry.test.ts 的 compactionFactory 已经因为同样的原因
   * 改过一次，这里当时漏改。
   */
  async function seedLongSession(sessionId: string) {
    faux = fauxProvider({
      tokensPerSecond: 10_000,
      models: [{ id: "faux-compaction", contextWindow: 48_000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    state.harnessOptions = { models, model: faux.getModel() };

    // 直接写会话树，不跑 agent loop：压缩只读这颗树，跑 20 轮模型调用纯属浪费
    if (!state.db) throw new Error("test db 尚未初始化");
    const db = state.db;
    const sessionRepo = (await import("@petrel/database")).createSessionRepository(db);
    const user = await registerUser("long@x.io");
    await sessionRepo.upsert({ id: sessionId, userId: user.id, title: "长会话" });
    const { createPgSession } = await import("@petrel/agent");
    const session = createPgSession(db as never, sessionId, new Date(), user.id);
    const chunk = "一".repeat(4000);
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: chunk }],
        timestamp: Date.now(),
      } as never);
      await session.appendMessage(fauxAssistantMessage([fauxText(chunk)]));
    }
    return { cookie: user.cookie, session };
  }

  it("压缩后模型侧变短、用户侧 transcript 一条不少", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const { cookie: longCookie, session } = await seedLongSession(sessionId);
    faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const before = (await entryRepo.listAll(sessionId)).filter((e) => e.type === "message").length;

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: longCookie },
      body: JSON.stringify({ message: "再问一句", sessionId }),
    });
    const text = await response.text(); // 读完流，等 harness 跑完

    // 模型侧：compaction 条目已生效，上溯在它那里停住
    const contextEntries = await session.buildContextEntries();
    expect(contextEntries.some((entry) => entry.type === "compaction")).toBe(true);

    // compacted 帧的形状也要锁：CompactionOutcome 上还挂着 pureBefore / contextWindow
    // 这两个只给内部逻辑用的字段，toCompactionFrame 漏投影就会整份漏出去，
    // 而键集合之外的任何断言都发现不了
    const compactedFrame = parseSse(text).find(
      (frame) =>
        frame.event === "compaction" &&
        (frame.data as { outcome?: { kind: string } }).outcome?.kind === "compacted",
    );
    const compacted = (compactedFrame as { data: { outcome: Record<string, unknown> } }).data.outcome;
    expect(Object.keys(compacted)).toEqual(["kind", "tokensBefore", "tokensAfter"]);

    // 用户侧：GET /:id/messages 用 listAll 投影，压缩不影响它。
    // 这一条不许改成 buildContext()——那样压缩后用户刷新会看到历史凭空消失
    const history = await app.request(`/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: longCookie },
    });
    const body = (await history.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThanOrEqual(before);
  });

  it("SSE 里有 event: compaction，且 failed 的 outcome 只透出 kind，不泄露 error 的其余字段", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const { cookie: longCookie } = await seedLongSession(sessionId);
    faux.setResponses([
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "秘密的内部报错" }),
      fauxAssistantMessage([fauxText("回答")]),
    ]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: longCookie },
      body: JSON.stringify({ message: "再问一句", sessionId }),
    });
    const text = await response.text();

    const frames = parseSse(text);
    const compactionFrames = frames.filter((frame) => frame.event === "compaction");
    // 断言完整序列而不是 find()：这一轮的正确形状恰好是「一个 start + 一个 failed」，
    // 用 find() 的话「压缩失败 → 撞窗口 → 兜底压缩又失败」这种多出一个 failed 帧的
    // 路径也照样通过，验的就不是这条用例声称的场景了
    expect(compactionFrames.map((frame) => (frame.data as { phase: string }).phase)).toEqual([
      "start",
      "end",
    ]);
    const failedFrame = compactionFrames[1];
    // 压缩失败不阻断本轮：阈值 80% 之外还有余量，本轮该照常回答完，不该以 error 收尾
    expect(text).not.toContain("event: error");
    expect(text).toContain("回答");

    /**
     * (a) 锁住投影后的形状，而不是字符串匹配：Error 的 message/stack 是不可枚举属性，
     * JSON.stringify 本来就带不出来，`expect(text).not.toContain("秘密的内部报错")`
     * 在这个数据形状下恒真——不管 toCompactionFrame 有没有做投影都会通过，测不出投影
     * 有没有做事。而 pi 的 AgentHarnessError 用 `this.code = code` / `this.name = ...`
     * 赋值，两个都是自有可枚举属性，不投影就会带着 `{"code":"compaction",
     * "name":"AgentHarnessError"}` 混进 outcome.error 漏进响应体，
     * 所以断言键集合才是真的在验证投影生效。
     */
    const outcome = (failedFrame as { data: { outcome: Record<string, unknown> } }).data.outcome;
    expect(Object.keys(outcome)).toEqual(["kind"]);

    // (b) 跳过：更真实的泄露场景是 provider 错误带 status/response 这类可枚举属性，
    // 但这条 failed 只可能来自 harness.compact() 内部抛出的 AgentHarnessError（pi 库层），
    // faux 只能控制被摘要的那条 assistant 消息内容，控制不了 harness.compact() 抛错时
    // 携带什么额外字段——要做到这一步得去 mock maybeCompact，而这正是不该做的事。
  });

  /**
   * blocked 帧的路由级覆盖。registry 层与前端层各自都有用例，中间这一段（HarnessNotice
   * → SSE 帧）此前零覆盖：`toCompactionFrame` 对 blocked 是原样透传，将来
   * HarnessNotice 的 blocked 分支加字段就会静默漏出去。
   *
   * 触发方式不用测试专用的后门：第一轮让摘要请求失败会给这个实例设上 60s 冷却
   * （harness 按 sessionId 常驻，第二轮拿到的是同一个实例），第二轮的压缩就会被
   * cooldown 守卫挡住，而阈值确实还超着 → 发 blocked。
   */
  it("守卫挡住时 SSE 发 blocked 帧，且只带 phase 与 reason", async () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const { cookie: longCookie } = await seedLongSession(sessionId);
    faux.setResponses([
      // 第一轮：摘要失败 → 设 60s 冷却
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
      fauxAssistantMessage([fauxText("第一轮回答")]),
      // 第二轮：压缩被冷却挡住，只发生这一次回答
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);
    const send = () =>
      app.request("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: longCookie },
        body: JSON.stringify({ message: "再问一句", sessionId }),
      });

    await (await send()).text();
    const text = await (await send()).text();

    const frames = parseSse(text).filter((frame) => frame.event === "compaction");
    expect(frames).toHaveLength(1);
    // 没有 start：守卫在 onPhase 回调之前就 return 了，被挡住的压缩压根没开始
    expect(frames[0]?.data).toEqual({ phase: "blocked", reason: "cooldown" });
  });

  it("低于阈值的普通请求没有任何 compaction 帧", async () => {
    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const text = await response.text();

    expect(text).not.toContain("event: compaction");
  });

  /** 前端 `/compact` 与 `/context` 两条斜杠命令的服务端契约 */
  describe("手动压缩命令", () => {
    function postCompact(sessionId: string, withCookie: string) {
      return app.request("/api/chat/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: withCookie },
        body: JSON.stringify({ sessionId }),
      });
    }

    it("POST /api/chat/compact 压缩成功，outcome 只透出三个字段", async () => {
      const sessionId = "66666666-6666-6666-6666-666666666666";
      const { cookie: longCookie, session } = await seedLongSession(sessionId);
      // 只需要摘要那一次调用：手动压缩不 prompt
      faux.setResponses([fauxAssistantMessage([fauxText("## Goal\n摘要")])]);

      const response = await postCompact(sessionId, longCookie);
      expect(response.status).toBe(200);

      // 与 SSE 帧共用 projectOutcome，同样只能断言键集合：pureBefore / contextWindow
      // 漏投影时任何数值断言都发现不了
      const body = (await response.json()) as { outcome: Record<string, unknown> };
      expect(Object.keys(body.outcome)).toEqual(["kind", "tokensBefore", "tokensAfter"]);
      expect(body.outcome.kind).toBe("compacted");

      const contextEntries = await session.buildContextEntries();
      expect(contextEntries.some((entry) => entry.type === "compaction")).toBe(true);
    });

    it("摘要失败时 outcome 只剩 kind，不泄露 error", async () => {
      const sessionId = "77777777-7777-7777-7777-777777777777";
      const { cookie: longCookie } = await seedLongSession(sessionId);
      faux.setResponses([
        fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "秘密的内部报错" }),
      ]);

      const response = await postCompact(sessionId, longCookie);

      // 压缩失败不是请求失败：用户要看到「压不动」这个结果，而不是一个 5xx
      expect(response.status).toBe(200);
      const body = (await response.json()) as { outcome: Record<string, unknown> };
      expect(Object.keys(body.outcome)).toEqual(["kind"]);
      expect(body.outcome.kind).toBe("failed");
    });

    it("正在生成回答时返回 409", async () => {
      useFaux(CHUNKED);
      faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);

      const response = await postChat({ message: "讲个长故事", sessionId: SESSION_ID });
      // 与 abort 用例同理：连接要持续读干，否则背压会卡住 harness
      const { firstByte, done } = drain(response);
      await firstByte;

      const conflict = await postCompact(SESSION_ID, cookie);
      expect(conflict.status).toBe(409);

      await done;
    });

    it("压别人的会话返回 403", async () => {
      const otherCookie = await registerAndLogin("other-compact@example.com");
      const response = await postCompact(SESSION_ID, otherCookie);

      expect(response.status).toBe(403);
    });

    it("GET /api/chat/context 报告当前占用与阈值", async () => {
      const sessionId = "88888888-8888-8888-8888-888888888888";
      const { cookie: longCookie } = await seedLongSession(sessionId);

      const response = await app.request(`/api/chat/context?sessionId=${sessionId}`, {
        headers: { Cookie: longCookie },
      });
      expect(response.status).toBe(200);

      // 阈值 = min(48000 × 0.8, 120000)，两个数都由 fixture 与 env 默认值定死
      const usage = (await response.json()) as Record<string, number>;
      expect(usage).toEqual({
        tokens: expect.any(Number),
        threshold: 38_400,
        contextWindow: 48_000,
      });
      // fixture 本来就是为「超阈值」造的，这一条同时守住 tokens 不是 0
      expect(usage.tokens).toBeGreaterThan(usage.threshold as number);
    });

    it("看别人的会话占用返回 403", async () => {
      const otherCookie = await registerAndLogin("other-context@example.com");
      const response = await app.request(`/api/chat/context?sessionId=${SESSION_ID}`, {
        headers: { Cookie: otherCookie },
      });

      expect(response.status).toBe(403);
    });

    it("sessionId 不是 UUID 时两个端点都返回 400", async () => {
      const compact = await postCompact("not-a-uuid", cookie);
      const context = await app.request("/api/chat/context?sessionId=not-a-uuid", {
        headers: { Cookie: cookie },
      });

      expect(compact.status).toBe(400);
      expect(context.status).toBe(400);
    });
  });
});

describe("POST /api/chat HEU-40 配额拦截", () => {
  /** 给当前登录用户插一条超额用量事实，模拟「本窗口已用满」 */
  async function fillQuota(tokens: number) {
    const user = await (await import("@petrel/database"))
      // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
      .createUserRepository(state.db!)
      .findByEmail("a@x.io");
    if (!user) throw new Error("测试用户未找到");
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    const usageRepo = createTokenUsageRepository(state.db!);
    await usageRepo.insertFact({
      entryId: crypto.randomUUID(),
      userId: user.id,
      sessionId: SESSION_ID,
      sourceType: "message",
      inputTokens: 0,
      outputTokens: tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: tokens,
      costTotal: "1.00",
    });
  }

  it("enforcement 关闭时即使超额也放行（只计量不拦截）", async () => {
    state.quotaEnforcement = false;
    await fillQuota(10_000_000);
    faux.setResponses([fauxAssistantMessage([fauxText("正常回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const body = await readAll(response);

    expect(response.status).toBe(200);
    expect(body).toContain("正常回答");
  });

  it("enforcement 开启且超额时返回 429，且不调用模型", async () => {
    state.quotaEnforcement = true;
    await fillQuota(10_000_000); // 远超默认 1_000_000
    faux.setResponses([fauxAssistantMessage([fauxText("不该出现")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    // 429 是前置拒绝，body 不是 SSE——直接读 json 断言，不要先 readAll（会耗尽 body）
    expect(response.status).toBe(429);
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("配额");
    // 没有调用模型，session_entries 不该有 assistant 条目（acquire 可能建了空 session 行，但无消息）
    expect(await storedRoles()).toEqual([]);
  });

  it("429 拒绝后释放了 registry handle：同会话下一个请求正常进流", async () => {
    // 如果配额拒绝路径忘了 handle.release()，refCount 会泄漏，registry 可能拒绝后续请求
    state.quotaEnforcement = true;
    await fillQuota(10_000_000);
    faux.setResponses([fauxAssistantMessage([fauxText("不该出现")])]);
    const blocked = await postChat({ message: "你好", sessionId: SESSION_ID });
    await readAll(blocked);
    expect(blocked.status).toBe(429);

    // 关掉 enforcement 让下一个请求能通过配额检查；若 handle 没 release，这里会卡/503
    state.quotaEnforcement = false;
    faux.setResponses([fauxAssistantMessage([fauxText("恢复后回答")])]);
    const ok = await postChat({ message: "再问", sessionId: SESSION_ID });
    const body = await readAll(ok);
    expect(ok.status).toBe(200);
    expect(body).toContain("恢复后回答");
  });

  it("配额覆盖为 0 时普通用户被拦（429）；admin 豁免由 quota.test.ts 覆盖", async () => {
    state.quotaEnforcement = true;
    // 当前测试用户 a@x.io 不是 admin（ADMIN_EMAILS 未配），无法在 e2e 里测 admin 豁免。
    // 这里给该用户设额度覆盖为 0，验证普通用户被拦；admin 豁免的单元覆盖在 quota.test.ts。
    const user = await (await import("@petrel/database"))
      // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
      .createUserRepository(state.db!)
      .findByEmail("a@x.io");
    if (!user) throw new Error("测试用户未找到");
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    await createQuotaLimitsRepository(state.db!).upsertLimit(user.id, 0);

    faux.setResponses([fauxAssistantMessage([fauxText("不该出现")])]);
    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    await readAll(response);
    expect(response.status).toBe(429);
  });
});

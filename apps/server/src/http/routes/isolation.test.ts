import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { CreateHarnessOptions } from "@petrel/agent";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  harnessOptions: undefined as Partial<CreateHarnessOptions> | undefined,
}));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  // getDb 的签名只认 NodePgDatabase，断言一次把 PGlite 实例塞进去（同 routes/sessions.test.ts）
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

/**
 * chat 路由走的是常驻 harness（registry 装配的是 createHarness），只在模块边界
 * 包一层，底下调的仍是真的 createHarness，只补上 faux 的 models/model
 * （仓库里没有 SILICONFLOW_API_KEY）。同 routes/chat.test.ts。
 *
 * 不手写替身 harness：消息落库现在由 harness 自己通过 session 完成，
 * 替身一旦少发或错序地发事件，「读不到别人的历史」就会退化成
 * 「两边都是空数组」的恒真断言，测不出任何东西。
 */
vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    createHarness: (options: CreateHarnessOptions) =>
      actual.createHarness({ ...options, ...state.harnessOptions }),
  };
});

// vi.mock 已提升，这里拿到的是替身模块，createUserRepository 走的是测试库；
// __resetRegistry 用来清掉上一个用例留下的常驻实例，避免它绑着已被 reset() 清空的会话树
const { createUserRepository } = await import("@petrel/database");
const { __resetRegistry } = await import("./chat.ts");

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

const ALICE_FIRST_MESSAGE = "alice 的第一句话";
const ALICE_ANSWER = "alice 收到的回答";

let faux: ReturnType<typeof fauxProvider>;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let alice: string;
let bob: string;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(async () => {
  await reset();
  __resetAuthRateLimits();
  __resetRegistry();
  faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  state.harnessOptions = { models, model: faux.getModel() };
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 注册一个用户并返回它的 cookie 与 id（同 admin.test.ts 的 registerUser；验证流程本身在 auth.test.ts 覆盖） */
async function register(email: string): Promise<{ cookie: string; id: string }> {
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

/** 注册后直接改库提权，再重新登录拿到 admin 身份的 cookie（同 admin.test.ts） */
async function registerAdmin(email: string): Promise<string> {
  const { id } = await register(email);
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await createUserRepository(state.db!).setRole(id, "admin");

  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

function chat(sessionId: string, message: string, cookie: string) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message, sessionId }),
  });
}

/** 让 alice 拥有一个会话，里面有一问一答两条消息 */
async function aliceCreatesSession(): Promise<void> {
  faux.setResponses([fauxAssistantMessage([fauxText(ALICE_ANSWER)])]);

  const response = await chat(SESSION_ID, ALICE_FIRST_MESSAGE, alice);
  expect(response.status).toBe(200);
  // SSE 响应读干净才意味着 handler（含落库）已经结束
  await response.text();
}

function listSessions(cookie: string) {
  return app.request("/api/sessions", { headers: { Cookie: cookie } });
}

describe("路由保护范围", () => {
  it("health 不需要登录", async () => {
    const response = await app.request("/api/system/health");

    expect(response.status).toBe(200);
  });

  // 这两条守着 app.ts 的挂载顺序，调整顺序时会先在这里红
  it("会话列表没有 cookie 返回 401", async () => {
    const response = await app.request("/api/sessions");

    expect(response.status).toBe(401);
  });

  it("对话端点没有 cookie 返回 401", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "你好", sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(401);
  });

  it("账号偏好没有 cookie 返回 401", async () => {
    const response = await app.request("/api/account/preferences");

    expect(response.status).toBe(401);
  });

  // HEU-53：provider 配置状态接口也必须挂在 requireAuth 之下。同时锁住
  // 「未登录访问未知 provider 的 models 端点也是 401（401 优先于 404）」——
  // 否则匿名用户能通过遍历 providerId 探测部署状态。
  it("provider 状态接口没有 cookie 返回 401", async () => {
    const response = await app.request("/api/providers");

    expect(response.status).toBe(401);
  });

  it("provider 模型目录没有 cookie 返回 401（而非 404）", async () => {
    const response = await app.request("/api/providers/not-real/models");

    expect(response.status).toBe(401);
  });

  it("记忆列表没有 cookie 返回 401", async () => {
    const response = await app.request("/api/memories");

    expect(response.status).toBe(401);
  });
});

describe("会话跨用户隔离", () => {
  // 注册要跑 scrypt（每次约 100ms），只有这一组用例需要两个真实用户
  beforeEach(async () => {
    alice = (await register("alice@x.io")).cookie;
    bob = (await register("bob@x.io")).cookie;
  });

  it("bob 的列表里看不到 alice 的会话", async () => {
    await aliceCreatesSession();

    const response = await listSessions(bob);

    await expect(response.json()).resolves.toEqual({ sessions: [] });
  });

  it("bob 读不到 alice 的会话历史", async () => {
    await aliceCreatesSession();

    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: bob },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [] });
  });

  // 上一条的护栏：alice 自己读得到，才说明「bob 读到空」不是因为压根没落库
  it("alice 读得到自己刚发的消息", async () => {
    await aliceCreatesSession();

    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: alice },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: { role: string; content: unknown }[];
    };
    // 只对 role 与 content 全等：其余字段是 pi 自带的 timestamp / usage / api id，
    // 每次运行都不同，钉死它们等于把 pi 的消息结构再固化一遍
    expect(body.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: ALICE_FIRST_MESSAGE }]],
      ["assistant", [{ type: "text", text: ALICE_ANSWER }]],
    ]);
  });

  it("bob 改不了 alice 的会话标题", async () => {
    await aliceCreatesSession();

    const response = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: bob },
      body: JSON.stringify({ title: "被劫持了" }),
    });

    expect(response.status).toBe(404);
    const list = (await (await listSessions(alice)).json()) as { sessions: { title: string }[] };
    expect(list.sessions[0]?.title).toBe(ALICE_FIRST_MESSAGE);
  });

  it("bob 删不掉 alice 的会话", async () => {
    await aliceCreatesSession();

    const response = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: bob },
    });

    expect(response.status).toBe(404);
    const list = (await (await listSessions(alice)).json()) as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);
  });

  // 比改名 / 删除更严重的一种越权：往别人的会话里注入内容
  it("bob 用 alice 的 sessionId 发消息被 403 拒绝", async () => {
    await aliceCreatesSession();

    const response = await chat(SESSION_ID, "注入的消息", bob);

    expect(response.status).toBe(403);
  });

  it("被拒绝的注入不会污染 alice 的历史", async () => {
    await aliceCreatesSession();

    // 读干净响应体：越权一旦漏了，落库发生在 SSE 流里，不等流结束这条断言会恒真
    await (await chat(SESSION_ID, "注入的消息", bob)).text();

    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: alice },
    });
    const body = (await response.json()) as { messages: unknown[] };
    expect(JSON.stringify(body.messages)).not.toContain("注入的消息");
  });
});

/**
 * 这两条原属 Task 8 的 admin 用例，因为要验证的是「禁用状态立刻影响 requireAuth」，
 * 依赖 requireAuth 已经挂上，所以留到这里跟其他 HTTP 边界用例放一起。
 */
describe("禁用用户立即失效", () => {
  it("禁用后该用户立即无法访问受保护端点", async () => {
    const adminCookie = await registerAdmin("boss@x.io");
    const victim = await register("victim@x.io");
    // 先确认禁用之前是通的，否则下面的 401 可能只是 cookie 本来就不对
    expect((await listSessions(victim.cookie)).status).toBe(200);

    const patched = await app.request(`/api/admin/users/${victim.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ disabled: true }),
    });

    expect(patched.status).toBe(200);
    // 同一张旧 token：禁用以库里为准，不等 token 自然过期
    expect((await listSessions(victim.cookie)).status).toBe(401);
  });

  it("可以再启用回来", async () => {
    const adminCookie = await registerAdmin("boss@x.io");
    const victim = await register("victim@x.io");
    const patch = (disabled: boolean) =>
      app.request(`/api/admin/users/${victim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ disabled }),
      });

    await patch(true);
    await patch(false);

    expect((await listSessions(victim.cookie)).status).toBe(200);
  });
});

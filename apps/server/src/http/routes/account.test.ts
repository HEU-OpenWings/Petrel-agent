import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

// 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 注册一个用户并返回它的 cookie（同 admin.test.ts 的 registerUser） */
async function registerUser(email: string): Promise<string> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

function getPreferences(cookie: string) {
  return app.request("/api/account/preferences", { headers: { Cookie: cookie } });
}

function putPreferences(body: unknown, cookie: string) {
  return app.request("/api/account/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function changePassword(body: unknown, cookie: string) {
  return app.request("/api/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function login(email: string, password: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

/** 取一个真实的模型 id。白名单校验要求它必须是注册过的，不能随便编一个 */
async function firstModelId(cookie: string): Promise<string> {
  const body = (await (await getPreferences(cookie)).json()) as { models: { id: string }[] };
  return body.models[0]!.id;
}

describe("GET /api/account/preferences", () => {
  it("未登录返回 401", async () => {
    expect((await app.request("/api/account/preferences")).status).toBe(401);
  });

  // 响应形状恒定：前端不必区分「没这行」与「两项都跟随默认」
  it("没改过设置的用户拿到两个 null，而不是 preferences: null", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await getPreferences(cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  it("同一个响应里带回可用模型清单", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await getPreferences(cookie);

    const body = (await response.json()) as {
      models: { id: string; name: string; isDefault: boolean }[];
    };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.filter((model) => model.isDefault)).toHaveLength(1);
  });
});

describe("PUT /api/account/preferences", () => {
  it("未登录返回 401", async () => {
    const response = await app.request("/api/account/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: null, systemPrompt: null }),
    });

    expect(response.status).toBe(401);
  });

  it("写入后能读回来", async () => {
    const cookie = await registerUser("a@x.io");
    const modelId = await firstModelId(cookie);

    const put = await putPreferences({ defaultModel: modelId, systemPrompt: "你是助手" }, cookie);

    expect(put.status).toBe(200);
    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: modelId, systemPrompt: "你是助手" });
  });

  // 不归一的话「清空 system prompt」会存一个 ""，然后被当作有效值发给模型，
  // agent 拿到的是空 prompt 而不是 DEFAULT_SYSTEM_PROMPT。
  // 前置必须把两个字段都写成非 null，否则断言「清成 null」对本来就是 null 的字段恒真
  it("空字符串归一成 null", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: await firstModelId(cookie), systemPrompt: "你是助手" }, cookie);

    await putPreferences({ defaultModel: "", systemPrompt: "   " }, cookie);

    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  // 全量语义：字段缺失就是 null，不是「这项别动」。
  // 同上，前置两个字段都要是非 null，才能区分「清空了」和「保留了旧值」
  it("字段缺失等同于 null，会清掉已有的值", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: await firstModelId(cookie), systemPrompt: "你是助手" }, cookie);

    await putPreferences({}, cookie);

    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  it("未注册的模型返回 400", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ defaultModel: "gpt-does-not-exist" }, cookie);

    expect(response.status).toBe(400);
  });

  it.each([
    { name: "body 是 null", body: null },
    { name: "defaultModel 是数字", body: { defaultModel: 1 } },
    { name: "systemPrompt 是数组", body: { systemPrompt: [] } },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const cookie = await registerUser("a@x.io");

    expect((await putPreferences(body, cookie)).status).toBe(400);
  });

  it("超长 systemPrompt 返回 400", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ systemPrompt: "很".repeat(4001) }, cookie);

    expect(response.status).toBe(400);
  });

  // NUL 过不了 Postgres 的 text 列，漏过去是 500（routes/sessions.ts 的 requireTitle 踩过）
  it("systemPrompt 里的 NUL 被清掉而不是 500", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ systemPrompt: `你${String.fromCharCode(0)}是助手` }, cookie);

    expect(response.status).toBe(200);
    const body = (await (await getPreferences(cookie)).json()) as {
      preferences: { systemPrompt: string };
    };
    expect(body.preferences.systemPrompt).toBe("你是助手");
  });

  it("偏好按用户隔离", async () => {
    const alice = await registerUser("alice@x.io");
    const bob = await registerUser("bob@x.io");
    await putPreferences({ systemPrompt: "alice 的 prompt" }, alice);

    const body = (await (await getPreferences(bob)).json()) as { preferences: unknown };

    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });
});

/**
 * 每个用例用独占邮箱：失败计数器在 services/auth.ts 的模块级单例里，
 * 是进程级状态，beforeEach 的 reset() 只清数据库不清它。共用邮箱会让
 * 前面用例记下的失败次数污染后面的期望（400 变 429、第 5 次就 429）。
 */
describe("POST /api/account/password", () => {
  const OLD = "hunter2hunter2";
  const NEW = "correcthorsebattery";

  it("未登录返回 401", async () => {
    const response = await app.request("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: OLD, newPassword: NEW }),
    });

    expect(response.status).toBe(401);
  });

  it("改成功后新密码能登录、旧密码不能", async () => {
    const cookie = await registerUser("pw-ok@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: NEW }, cookie);

    expect(response.status).toBe(200);
    expect((await login("pw-ok@x.io", NEW)).status).toBe(200);
    expect((await login("pw-ok@x.io", OLD)).status).toBe(401);
  });

  // 当前会话不该因为改了密码而掉线
  it("改成功后重新签发 cookie", async () => {
    const cookie = await registerUser("pw-reissue@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: NEW }, cookie);

    expect(response.headers.get("Set-Cookie")).toContain("petrel_token=");
  });

  // 403 与认证中间件的 401 分开，前端才能只在登录态真的失效时登出
  it("旧密码不正确返回 403 且文案具体", async () => {
    const cookie = await registerUser("pw-wrong@x.io");

    const response = await changePassword({ currentPassword: "wrong-password", newPassword: NEW }, cookie);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { message: "当前密码不正确" } });
  });

  it("新密码太短返回 400", async () => {
    const cookie = await registerUser("pw-short@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: "short" }, cookie);

    expect(response.status).toBe(400);
  });

  it("旧密码连错 5 次后返回 429", async () => {
    const cookie = await registerUser("pw-ratelimit@x.io");
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await changePassword({ currentPassword: "wrong-password", newPassword: NEW }, cookie)).status,
      ).toBe(403);
    }

    const response = await changePassword({ currentPassword: "wrong-password", newPassword: NEW }, cookie);

    expect(response.status).toBe(429);
  });

  it.each([
    { name: "body 是 null", body: null, email: "pw-null@x.io" },
    { name: "缺 newPassword", body: { currentPassword: OLD }, email: "pw-missing@x.io" },
    {
      name: "currentPassword 是数字",
      body: { currentPassword: 1, newPassword: NEW },
      email: "pw-type@x.io",
    },
  ])("$name 返回 400 而不是 500", async ({ body, email }) => {
    const cookie = await registerUser(email);

    expect((await changePassword(body, cookie)).status).toBe(400);
  });
});

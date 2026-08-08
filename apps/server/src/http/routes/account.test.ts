import { createUserRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

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

// GET /preferences 的模型清单来自 listConfiguredModels()——只列「已配置」的 provider。
// 测试环境不配真实 key，每个用例前 stub 一个让 DeepSeek 被判为已配置，模型清单才非空
// （firstModelId 与「带回可用模型清单」两条断言依赖它）。pi 的 envApiKeyAuth 实时读
// process.env。用例后清理，避免污染同进程其他测试文件（与 models.test.ts 同口径）。
beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", "test-stub");
  __resetAuthRateLimits();
  return reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 注册一个用户并返回它的 cookie（验证流程本身在 routes/auth.test.ts 覆盖，这里直接置为已验证再登录） */
async function registerUser(email: string): Promise<string> {
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
  return (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
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
  // biome-ignore lint/style/noNonNullAssertion: 模型注册表非空，白名单校验依赖这一点
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

  // review 🟡#4：GET 用 configured 过滤，PUT 也必须同口径，否则能存一个选择器里看不到、
  // 必然运行时失败的 model id。gpt-4 已注册（openai provider）但测试环境没配 OPENAI_API_KEY，
  // 属于「已注册但未配置」——旧代码用 listModels（全部）会接受它，新代码按 configured 拒绝。
  // 这条钉住读写两侧白名单一致。stubEnv 清掉 OPENAI_API_KEY 确保它确实未配置。
  it("已注册但未配置 key 的模型也返回 400（PUT 与 GET 白名单同口径）", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ defaultModel: "gpt-4" }, cookie);

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

  // 验收：A 设备登录拿到 token → B 设备改密码 → A 的下一个请求返回 401
  it("改密码后其他设备的旧 cookie 立即失效（tokenVersion）", async () => {
    const deviceA = await registerUser("pw-tv@x.io");
    const deviceB = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pw-tv@x.io", password: OLD }),
    });
    const cookieB = (deviceB.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

    // B 设备改密码成功（当前会话重新签发，不掉线）
    const change = await changePassword({ currentPassword: OLD, newPassword: NEW }, cookieB);
    expect(change.status).toBe(200);
    const newCookieB = (change.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

    // A 设备的下一个请求必须 401
    const stale = await getPreferences(deviceA);
    expect(stale.status).toBe(401);
    // B 设备重签的新 cookie 仍然有效
    expect((await getPreferences(newCookieB)).status).toBe(200);
  });
});

describe("POST /api/account/logout-all", () => {
  it("退出所有设备后旧 cookie 失效，响应清掉当前 cookie", async () => {
    const cookie = await registerUser("logout-all@x.io");

    const response = await app.request("/api/account/logout-all", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await getPreferences(cookie)).status).toBe(401);
  });

  it("未登录返回 401", async () => {
    const response = await app.request("/api/account/logout-all", { method: "POST" });

    expect(response.status).toBe(401);
  });
});

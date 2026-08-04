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
    const models = (await (await getPreferences(cookie)).json()) as { models: { id: string }[] };
    const modelId = models.models[0]!.id;

    const put = await putPreferences({ defaultModel: modelId, systemPrompt: "你是助手" }, cookie);

    expect(put.status).toBe(200);
    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: modelId, systemPrompt: "你是助手" });
  });

  // 不归一的话「清空 system prompt」会存一个 ""，然后被当作有效值发给模型，
  // agent 拿到的是空 prompt 而不是 DEFAULT_SYSTEM_PROMPT
  it("空字符串归一成 null", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: null, systemPrompt: "你是助手" }, cookie);

    await putPreferences({ defaultModel: "", systemPrompt: "   " }, cookie);

    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  // 全量语义：字段缺失就是 null，不是「这项别动」
  it("字段缺失等同于 null，会清掉已有的值", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: null, systemPrompt: "你是助手" }, cookie);

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

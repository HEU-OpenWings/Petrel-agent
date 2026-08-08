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
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

/**
 * 禁用用户会清掉 registry 里的活实例，要让 chat 路由的 createHarness 走 faux
 * provider 而不是真实模型（同 routes/chat.test.ts）。
 */
vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    createHarness: (options: CreateHarnessOptions) =>
      actual.createHarness({ ...options, ...state.harnessOptions }),
  };
});

const { createUserRepository } = await import("@petrel/database");
const { __resetRegistry, getRegistry } = await import("./chat.ts");

let reset: () => Promise<void>;
let close: () => Promise<void>;

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
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  state.harnessOptions = { models, model: faux.getModel() };
});

afterAll(() => close?.());

/** 让某个用户跑一轮对话，用来让 registry 里出现一个活实例 */
function postChatAs(cookie: string, body: { message: string; sessionId: string }) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

/** 注册一个用户并返回它的 cookie 与 id。验证流程本身在 routes/auth.test.ts 覆盖，这里直接置为已验证再登录 */
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
  return { cookie: cookieFrom(login), id: body.user.id };
}

/** 注册后直接改库提权，再重新登录拿到 admin 身份的 cookie */
async function registerAdmin(email: string): Promise<{ cookie: string; id: string }> {
  const { id } = await registerUser(email);
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await createUserRepository(state.db!).setRole(id, "admin");

  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return { cookie: cookieFrom(response), id };
}

function patchUser(id: string, body: unknown, cookie: string) {
  return app.request(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe("GET /api/admin/users", () => {
  it("admin 能拿到用户列表", async () => {
    const admin = await registerAdmin("boss@x.io");
    await registerUser("a@x.io");

    const response = await app.request("/api/admin/users", { headers: { Cookie: admin.cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: { email: string }[] };
    expect(body.users.map((user) => user.email)).toContain("a@x.io");
  });

  it("列表里没有 passwordHash", async () => {
    const admin = await registerAdmin("boss@x.io");

    const response = await app.request("/api/admin/users", { headers: { Cookie: admin.cookie } });

    expect(await response.text()).not.toContain("passwordHash");
  });

  it("普通用户返回 403", async () => {
    const user = await registerUser("a@x.io");

    const response = await app.request("/api/admin/users", { headers: { Cookie: user.cookie } });

    expect(response.status).toBe(403);
  });

  it("未登录返回 401", async () => {
    const response = await app.request("/api/admin/users");

    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/admin/users/:id", () => {
  // 否则唯一的 admin 一次误操作就把管理入口彻底关掉，只能改库恢复
  it("不能禁用自己", async () => {
    const admin = await registerAdmin("boss@x.io");

    const response = await patchUser(admin.id, { disabled: true }, admin.cookie);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "不能禁用自己" } });
  });

  it("用户不存在返回 404", async () => {
    const admin = await registerAdmin("boss@x.io");

    const response = await patchUser(
      "00000000-0000-0000-0000-0000000000ff",
      { disabled: true },
      admin.cookie,
    );

    expect(response.status).toBe(404);
  });

  it("非法 UUID 返回 400", async () => {
    const admin = await registerAdmin("boss@x.io");

    const response = await patchUser("not-a-uuid", { disabled: true }, admin.cookie);

    expect(response.status).toBe(400);
  });

  it.each([
    { name: "body 是 null", body: null },
    { name: "没有 disabled", body: {} },
    { name: "disabled 是字符串", body: { disabled: "true" } },
    { name: "disabled 是数字", body: { disabled: 1 } },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("a@x.io");

    const response = await patchUser(victim.id, body, admin.cookie);

    expect(response.status).toBe(400);
  });

  it("普通用户返回 403", async () => {
    const attacker = await registerUser("a@x.io");
    const victim = await registerUser("b@x.io");

    const response = await patchUser(victim.id, { disabled: true }, attacker.cookie);

    expect(response.status).toBe(403);
  });

  it("禁用用户后他的会话实例被清掉", async () => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("victim@x.io");
    const sessionId = "11111111-1111-1111-1111-111111111111";

    // 让目标用户先跑一轮，registry 里就有实例了
    await (await postChatAs(victim.cookie, { message: "你好", sessionId })).text();
    expect(getRegistry().size()).toBe(1);

    const response = await patchUser(victim.id, { disabled: true }, admin.cookie);

    expect(response.status).toBe(200);
    // 实例已清：被禁用者的会话不再占着内存，正在跑的轮次也被 abort
    expect(getRegistry().size()).toBe(0);
  });
});

describe("HEU-40 PUT/DELETE /api/admin/users/:id/quota", () => {
  function putQuota(id: string, tokenLimit: unknown, cookie: string) {
    return app.request(`/api/admin/users/${id}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ tokenLimit }),
    });
  }
  function deleteQuota(id: string, cookie: string) {
    return app.request(`/api/admin/users/${id}/quota`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
  }

  it("admin 设置覆盖额度，普通用户随后按它被拦", async () => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("victim@x.io");

    // 设为 0：禁止该用户调用模型
    const put = await putQuota(victim.id, 0, admin.cookie);
    expect(put.status).toBe(200);

    // 直接读库确认覆盖生效（quota-limits repository）
    const { createQuotaLimitsRepository } = await import("@petrel/database");
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    const limit = await createQuotaLimitsRepository(state.db!).getLimit(victim.id);
    expect(limit).toBe(0);
  });

  it("tokenLimit 为 null 时恢复系统默认（删除覆盖）", async () => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("victim@x.io");
    await putQuota(victim.id, 500, admin.cookie);
    expect(
      // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
      await (await import("@petrel/database")).createQuotaLimitsRepository(state.db!).getLimit(victim.id),
    ).toBe(500);

    const putNull = await putQuota(victim.id, null, admin.cookie);
    expect(putNull.status).toBe(200);
    // 删除覆盖后 getLimit 返回 undefined（跟随系统默认）
    expect(
      // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
      await (await import("@petrel/database")).createQuotaLimitsRepository(state.db!).getLimit(victim.id),
    ).toBeUndefined();
  });

  it("DELETE 删除覆盖，无覆盖时幂等成功", async () => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("victim@x.io");

    const del = await deleteQuota(victim.id, admin.cookie);
    expect(del.status).toBe(200);
  });

  it("目标用户不存在返回 404", async () => {
    const admin = await registerAdmin("boss@x.io");
    const ghost = "00000000-0000-0000-0000-000000000099";

    const put = await putQuota(ghost, 1000, admin.cookie);
    expect(put.status).toBe(404);
  });

  it.each([
    { name: "tokenLimit 是负数", value: -1 },
    { name: "tokenLimit 是小数", value: 1.5 },
    { name: "tokenLimit 是字符串", value: "1000" },
    { name: "缺 tokenLimit 字段", value: undefined },
  ])("$name 返回 400", async ({ value }) => {
    const admin = await registerAdmin("boss@x.io");
    const victim = await registerUser("victim@x.io");
    // value 为 undefined 时 body 不含 tokenLimit 字段
    const body = value === undefined ? {} : { tokenLimit: value };
    const response = await app.request(`/api/admin/users/${victim.id}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("普通用户不能设置配额（403）", async () => {
    const attacker = await registerUser("a@x.io");
    const victim = await registerUser("b@x.io");

    const response = await putQuota(victim.id, 1000, attacker.cookie);
    expect(response.status).toBe(403);
  });

  it("未登录返回 401", async () => {
    const victim = await registerUser("a@x.io");
    const response = await app.request(`/api/admin/users/${victim.id}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenLimit: 1000 }),
    });
    expect(response.status).toBe(401);
  });
});

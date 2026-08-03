import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

const { createUserRepository } = await import("@petrel/database");

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(() => reset());
afterAll(() => close?.());

function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

/** 注册一个用户并返回它的 cookie 与 id */
async function registerUser(email: string): Promise<{ cookie: string; id: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  return { cookie: cookieFrom(response), id: body.user.id };
}

/** 注册后直接改库提权，再重新登录拿到 admin 身份的 cookie */
async function registerAdmin(email: string): Promise<{ cookie: string; id: string }> {
  const { id } = await registerUser(email);
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
});

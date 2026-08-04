import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

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

function post(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

describe("POST /api/auth/register", () => {
  it("注册成功返回 201 与用户，并种上 cookie", async () => {
    const response = await post("/api/auth/register", {
      email: "a@x.io",
      password: "hunter2hunter2",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { user: { email: string; role: string } };
    expect(body.user).toEqual({
      id: expect.any(String),
      email: "a@x.io",
      role: "user",
    });
    expect(response.headers.get("Set-Cookie")).toContain("petrel_token=");
  });

  it("响应里没有 passwordHash", async () => {
    const response = await post("/api/auth/register", {
      email: "a@x.io",
      password: "hunter2hunter2",
    });

    expect(await response.text()).not.toContain("passwordHash");
  });

  it("邮箱重复返回 409", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: "hunter2hunter2" });

    const response = await post("/api/auth/register", { email: "a@x.io", password: "hunter2hunter2" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { message: "该邮箱已注册" } });
  });

  it("弱密码返回 400", async () => {
    const response = await post("/api/auth/register", { email: "a@x.io", password: "short" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "密码至少 8 位" } });
  });

  // 这些请求体都能让「先当成 { email: string } 用」的写法抛 TypeError，
  // 被 error 中间件兜成 500——客户端错误却报服务端错误
  it.each([
    { name: "body 是 null", body: null },
    { name: "body 是数组", body: [] },
    { name: "body 是字符串", body: "abc" },
    { name: "没有 email", body: { password: "hunter2hunter2" } },
    { name: "没有 password", body: { email: "a@x.io" } },
    { name: "email 是数字", body: { email: 123, password: "hunter2hunter2" } },
    { name: "password 是对象", body: { email: "a@x.io", password: {} } },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const response = await post("/api/auth/register", body);

    expect(response.status).toBe(400);
  });

  it("请求体不是 JSON 返回 400", async () => {
    const response = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "请求体必须是 JSON" } });
  });
});

describe("POST /api/auth/login", () => {
  it("登录成功返回用户并种 cookie", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: "hunter2hunter2" });

    const response = await post("/api/auth/login", { email: "a@x.io", password: "hunter2hunter2" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("petrel_token=");
  });

  it("密码错误返回 401", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: "hunter2hunter2" });

    const response = await post("/api/auth/login", { email: "a@x.io", password: "wrongpassword" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { message: "邮箱或密码不正确" } });
  });

  it("账号不存在与密码错误的响应完全一致", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: "hunter2hunter2" });

    const wrongPassword = await post("/api/auth/login", { email: "a@x.io", password: "wrongpassword" });
    const noSuchUser = await post("/api/auth/login", { email: "nobody@x.io", password: "wrongpassword" });

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(await wrongPassword.json()).toEqual(await noSuchUser.json());
  });

  it("连续失败 5 次后第 6 次 HTTP 请求返回 429", async () => {
    await post("/api/auth/register", { email: "limited@x.io", password: "hunter2hunter2" });

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post("/api/auth/login", {
        email: "limited@x.io",
        password: "wrongpassword",
      });
      expect(response.status).toBe(401);
    }

    const response = await post("/api/auth/login", {
      email: "limited@x.io",
      password: "wrongpassword",
    });
    expect(response.status).toBe(429);
  });
});

describe("POST /api/auth/logout", () => {
  it("清掉 cookie", async () => {
    const registered = await post("/api/auth/register", {
      email: "a@x.io",
      password: "hunter2hunter2",
    });
    const cookie = cookieFrom(registered);

    const response = await post("/api/auth/logout", {}, cookie);

    expect(response.status).toBe(200);
    // deleteCookie 的做法是种一个 Max-Age=0 的同名 cookie
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("GET /api/auth/me", () => {
  it("已登录返回当前用户", async () => {
    const registered = await post("/api/auth/register", {
      email: "a@x.io",
      password: "hunter2hunter2",
    });
    const cookie = cookieFrom(registered);

    const response = await app.request("/api/auth/me", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { email: string } };
    expect(body.user.email).toBe("a@x.io");
  });

  it("未登录返回 401", async () => {
    const response = await app.request("/api/auth/me");

    expect(response.status).toBe(401);
  });
});

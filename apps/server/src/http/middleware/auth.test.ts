import { createTestDb, type TestDb } from "@petrel/database/testing";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../types.ts";
import { COOKIE_NAME, issueToken, requireAdmin, requireAuth } from "./auth.ts";

const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

const { createUserRepository } = await import("@petrel/database");
const { env } = await import("@petrel/config");

let reset: () => Promise<void>;
let close: () => Promise<void>;
let userId: string;

// 一个最小应用：登录端点只负责种 cookie，受保护端点回显当前用户
const app = new Hono<AppEnv>()
  .post("/issue/:id/:role", async (c) => {
    await issueToken(c, { id: c.req.param("id"), email: "x@x.io", role: c.req.param("role") });
    return c.json({ ok: true });
  })
  .use("/protected/*", requireAuth)
  .get("/protected/whoami", (c) => c.json({ id: c.get("currentUser").id }))
  .use("/admin-only/*", requireAuth, requireAdmin)
  .get("/admin-only/secret", (c) => c.json({ ok: true }));

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(async () => {
  await reset();
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  const user = await createUserRepository(state.db!).create({
    email: "a@x.io",
    passwordHash: "scrypt$a$b",
  });
  userId = user.id;
});

afterAll(() => close?.());

/** 从 Set-Cookie 里取出可直接回填给下一个请求的 cookie 串 */
function cookieFrom(response: Response): string {
  const raw = response.headers.get("Set-Cookie") ?? "";
  // biome-ignore lint/style/noNonNullAssertion: split(";") 对任意字符串至少返回一个元素
  return raw.split(";")[0]!;
}

async function issue(id: string, role = "user"): Promise<string> {
  const response = await app.request(`/issue/${id}/${role}`, { method: "POST" });
  return cookieFrom(response);
}

describe("issueToken", () => {
  it("种的是 httpOnly + SameSite=Strict 的 cookie", async () => {
    const response = await app.request(`/issue/${userId}/user`, { method: "POST" });

    const raw = response.headers.get("Set-Cookie") ?? "";
    expect(raw).toContain(`${COOKIE_NAME}=`);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/");
  });

  it("非生产环境不带 Secure（本地 http 下带了会被浏览器丢弃）", async () => {
    const response = await app.request(`/issue/${userId}/user`, { method: "POST" });

    expect(response.headers.get("Set-Cookie")).not.toContain("Secure");
  });
});

describe("requireAuth", () => {
  it("带合法 cookie 时放行并注入当前用户", async () => {
    const cookie = await issue(userId);

    const response = await app.request("/protected/whoami", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: userId });
  });

  it("没有 cookie 返回 401", async () => {
    const response = await app.request("/protected/whoami");

    expect(response.status).toBe(401);
  });

  it("签名不对返回 401", async () => {
    const forged = await sign({ sub: userId, role: "admin", exp: nowInSeconds() + 3600 }, "wrong-secret");

    const response = await app.request("/protected/whoami", {
      headers: { Cookie: `${COOKIE_NAME}=${forged}` },
    });

    expect(response.status).toBe(401);
  });

  it("过期的 token 返回 401", async () => {
    const expired = await sign({ sub: userId, role: "user", exp: nowInSeconds() - 10 }, env.jwtSecret);

    const response = await app.request("/protected/whoami", {
      headers: { Cookie: `${COOKIE_NAME}=${expired}` },
    });

    expect(response.status).toBe(401);
  });

  it("token 合法但用户已被删除返回 401", async () => {
    const cookie = await issue("00000000-0000-0000-0000-0000000000ff");

    const response = await app.request("/protected/whoami", { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
  });

  // 每请求查库的意义就在这条：禁用必须立即生效，不能等 token 自然过期
  it("token 合法但用户已被禁用返回 401", async () => {
    const cookie = await issue(userId);
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    await createUserRepository(state.db!).setDisabled(userId, true);

    const response = await app.request("/protected/whoami", { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
  });

  // 角色以库里为准，不信 token 里的那份
  it("token 里写着 admin 但库里是 user，按库里算", async () => {
    const cookie = await issue(userId, "admin");

    const response = await app.request("/admin-only/secret", { headers: { Cookie: cookie } });

    expect(response.status).toBe(403);
  });
});

describe("requireAdmin", () => {
  it("admin 放行", async () => {
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    await createUserRepository(state.db!).setRole(userId, "admin");
    const cookie = await issue(userId, "admin");

    const response = await app.request("/admin-only/secret", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
  });

  it("普通用户返回 403", async () => {
    const cookie = await issue(userId);

    const response = await app.request("/admin-only/secret", { headers: { Cookie: cookie } });

    expect(response.status).toBe(403);
  });
});

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

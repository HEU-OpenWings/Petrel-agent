import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  mails: [] as { to: string; text: string }[],
  /** 置 true 模拟 SMTP 挂掉：send 抛错 */
  mailBroken: false,
}));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

/**
 * 注册/忘记密码/重发验证都会走邮件。路由测试用假 mailer 收集邮件，
 * 从邮件正文里抽出验证/重置链接的 token。
 */
vi.mock("../../services/mailer.ts", () => ({
  getMailer: () => ({
    send: async (input: { to: string; text: string }) => {
      if (state.mailBroken) {
        throw new Error("smtp down");
      }
      state.mails.push(input);
    },
  }),
}));

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
  state.mails.length = 0;
  state.mailBroken = false;
  __resetAuthRateLimits();
});

afterAll(() => close?.());

function post(path: string, body: unknown, options?: { cookie?: string; ip?: string; xff?: string }) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // clientIp 优先 X-Real-IP（nginx 覆盖语义，伪造不了）；xff 只留给伪造回归用例
      ...(options?.ip ? { "x-real-ip": options.ip } : {}),
      ...(options?.xff ? { "x-forwarded-for": options.xff } : {}),
      ...(options?.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

function lastMail(): { to: string; text: string } {
  const mail = state.mails.at(-1);
  if (!mail) throw new Error("没有发送过邮件");
  return mail;
}

/** 从邮件正文里抽出 token（验证与重置链接都是 ?token=... 形式） */
function tokenFrom(mail: { text: string }): string {
  const match = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("邮件里没有 token");
  const token = match[1];
  if (!token) throw new Error("邮件里没有 token");
  return token;
}

const PASSWORD = "hunter2hunter2";

/** 注册 → 从假邮件取验证 token → 验证 → 登录，返回可用的 cookie */
async function registerVerified(email: string): Promise<string> {
  const registered = await post("/api/auth/register", { email, password: PASSWORD });
  expect(registered.status).toBe(201);
  const token = tokenFrom(lastMail());
  const verified = await app.request(`/api/auth/verify-email?token=${token}`);
  expect(verified.status).toBe(200);
  const login = await post("/api/auth/login", { email, password: PASSWORD });
  expect(login.status).toBe(200);
  return cookieFrom(login);
}

describe("POST /api/auth/register", () => {
  it("注册成功返回 201 与用户，不再种 cookie，并声明验证邮件已发送", async () => {
    const response = await post("/api/auth/register", {
      email: "a@x.io",
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      user: { email: string; role: string; emailVerifiedAt: string | null };
      verificationSent: boolean;
    };
    expect(body.user).toEqual({
      id: expect.any(String),
      email: "a@x.io",
      role: "user",
      emailVerifiedAt: null,
    });
    expect(body.verificationSent).toBe(true);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("邮件发送失败时仍返回 201，verificationSent=false", async () => {
    state.mailBroken = true;

    const response = await post("/api/auth/register", {
      email: "a@x.io",
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { verificationSent: boolean };
    expect(body.verificationSent).toBe(false);
  });

  it("注册即发验证邮件，收件人是注册邮箱且链接带 token", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });

    const mail = lastMail();
    expect(mail.to).toBe("a@x.io");
    expect(mail.text).toContain("/api/auth/verify-email?token=");
  });

  it("响应里没有 passwordHash", async () => {
    const response = await post("/api/auth/register", {
      email: "a@x.io",
      password: PASSWORD,
    });

    expect(await response.text()).not.toContain("passwordHash");
  });

  it("邮箱重复返回 409", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });

    const response = await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { message: "该邮箱已注册" } });
  });

  it("弱密码返回 400", async () => {
    const response = await post("/api/auth/register", { email: "a@x.io", password: "short" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "密码至少 8 位" } });
  });

  it.each([
    { name: "body 是 null", body: null },
    { name: "body 是数组", body: [] },
    { name: "body 是字符串", body: "abc" },
    { name: "没有 email", body: { password: PASSWORD } },
    { name: "没有 password", body: { email: "a@x.io" } },
    { name: "email 是数字", body: { email: 123, password: PASSWORD } },
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

  it("同一 X-Real-IP 第 6 次注册返回 429（默认 5 次/窗口）", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post(
        "/api/auth/register",
        { email: `a${attempt}@x.io`, password: PASSWORD },
        { ip: "203.0.113.7" },
      );
      expect(response.status).toBe(201);
    }

    const response = await post(
      "/api/auth/register",
      { email: "a5@x.io", password: PASSWORD },
      { ip: "203.0.113.7" },
    );
    expect(response.status).toBe(429);
  });

  it("不同 X-Real-IP 互不影响", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post(
        "/api/auth/register",
        { email: `a${attempt}@x.io`, password: PASSWORD },
        { ip: `203.0.113.${attempt + 1}` },
      );
      expect(response.status).toBe(201);
    }

    const response = await post(
      "/api/auth/register",
      { email: "a5@x.io", password: PASSWORD },
      { ip: "203.0.113.9" },
    );
    expect(response.status).toBe(201);
  });

  it("XFF 伪造第一段不再生效：取最后一跳（追加语义下才是代理写的真实 IP）", async () => {
    // 客户端发 X-Forwarded-For: 1.2.3.4，nginx 的 $proxy_add_x_forwarded_for
    // 追加真实 IP 变成 "1.2.3.4, <真实IP>"。取最后一跳 = 真实 IP，轮换第一段无效
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post(
        "/api/auth/register",
        { email: `a${attempt}@x.io`, password: PASSWORD },
        { xff: `1.2.3.${attempt}, 203.0.113.77` },
      );
      expect(response.status).toBe(201);
    }

    const response = await post(
      "/api/auth/register",
      { email: "a5@x.io", password: PASSWORD },
      { xff: "9.9.9.9, 203.0.113.77" },
    );
    expect(response.status).toBe(429);
  });
});

describe("POST /api/auth/login", () => {
  it("未验证的账号密码正确也返回 403，且不种 cookie", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });

    const response = await post("/api/auth/login", { email: "a@x.io", password: PASSWORD });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { message: "邮箱尚未验证，请先查收验证邮件" },
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("未验证时密码错误仍与账号不存在完全一致（不泄漏未验证状态）", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });

    const wrongPassword = await post("/api/auth/login", { email: "a@x.io", password: "wrongpassword" });
    const noSuchUser = await post("/api/auth/login", {
      email: "nobody@x.io",
      password: "wrongpassword",
    });

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(await wrongPassword.json()).toEqual(await noSuchUser.json());
  });

  it("验证后登录成功并种 cookie", async () => {
    const cookie = await registerVerified("a@x.io");

    expect(cookie).toContain("petrel_token=");
  });

  it("连续失败 5 次后第 6 次 HTTP 请求返回 429", async () => {
    await registerVerified("limited@x.io");

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

describe("GET /api/auth/verify-email", () => {
  it("用邮件里的 token 验证成功，之后可以登录", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });
    const token = tokenFrom(lastMail());

    const response = await app.request(`/api/auth/verify-email?token=${token}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("已验证");
    const login = await post("/api/auth/login", { email: "a@x.io", password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("无效 token 返回失败页而非 500", async () => {
    const response = await app.request("/api/auth/verify-email?token=bogus");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("验证链接无效或已过期");
  });
});

describe("POST /api/auth/resend-verification", () => {
  it("给未验证用户重发邮件", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });
    state.mails.length = 0;

    const response = await post("/api/auth/resend-verification", { email: "a@x.io" });

    expect(response.status).toBe(200);
    expect(lastMail().to).toBe("a@x.io");
  });

  it("账号不存在也返回 200（防枚举）", async () => {
    const response = await post("/api/auth/resend-verification", { email: "nobody@x.io" });

    expect(response.status).toBe(200);
    expect(state.mails).toHaveLength(0);
  });

  it("已验证账号不重发（静默成功）", async () => {
    await registerVerified("a@x.io");
    state.mails.length = 0;

    const response = await post("/api/auth/resend-verification", { email: "a@x.io" });

    expect(response.status).toBe(200);
    expect(state.mails).toHaveLength(0);
  });

  it("同一邮箱第 4 次请求返回 429（默认 3 次/窗口）", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post("/api/auth/resend-verification", { email: "a@x.io" });
      expect(response.status).toBe(200);
    }

    const response = await post("/api/auth/resend-verification", { email: "a@x.io" });
    expect(response.status).toBe(429);
  });
});

describe("忘记密码", () => {
  it("GET 渲染表单页", async () => {
    const response = await app.request("/api/auth/forgot-password");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("发送重置邮件");
  });

  it("已注册邮箱收到带 token 的重置邮件", async () => {
    await registerVerified("a@x.io");
    state.mails.length = 0;

    const response = await post("/api/auth/forgot-password", { email: "a@x.io" });

    expect(response.status).toBe(200);
    expect(lastMail().to).toBe("a@x.io");
    expect(lastMail().text).toContain("/api/auth/reset-password?token=");
  });

  it("账号不存在也返回 200（防枚举）", async () => {
    const response = await post("/api/auth/forgot-password", { email: "nobody@x.io" });

    expect(response.status).toBe(200);
    expect(state.mails).toHaveLength(0);
  });

  it("同一邮箱第 4 次请求返回 429", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post("/api/auth/forgot-password", { email: "a@x.io" });
      expect(response.status).toBe(200);
    }

    const response = await post("/api/auth/forgot-password", { email: "a@x.io" });
    expect(response.status).toBe(429);
  });
});

describe("重置密码", () => {
  async function requestReset(email: string): Promise<string> {
    await post("/api/auth/forgot-password", { email });
    return tokenFrom(lastMail());
  }

  it("GET 带有效 token 渲染表单页", async () => {
    await registerVerified("a@x.io");
    const token = await requestReset("a@x.io");

    const response = await app.request(`/api/auth/reset-password?token=${token}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("设置新密码");
  });

  it("GET 带无效 token 渲染失败页", async () => {
    const response = await app.request("/api/auth/reset-password?token=bogus");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("重置链接无效或已过期");
  });

  it("POST 重置后旧密码失效、新密码可登录，且未验证账号顺带完成验证", async () => {
    await post("/api/auth/register", { email: "a@x.io", password: PASSWORD });
    const token = await requestReset("a@x.io");

    const response = await post("/api/auth/reset-password", {
      token,
      password: "brandnewpassword",
    });
    expect(response.status).toBe(200);

    const oldLogin = await post("/api/auth/login", { email: "a@x.io", password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await post("/api/auth/login", {
      email: "a@x.io",
      password: "brandnewpassword",
    });
    expect(newLogin.status).toBe(200);
  });

  it("token 一次性：重置后再次使用返回 400", async () => {
    await registerVerified("a@x.io");
    const token = await requestReset("a@x.io");
    await post("/api/auth/reset-password", { token, password: "brandnewpassword" });

    const response = await post("/api/auth/reset-password", { token, password: "anotherpassword" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "重置链接无效或已过期" },
    });
  });

  it("弱密码返回 400 且不改变原密码", async () => {
    await registerVerified("a@x.io");
    const token = await requestReset("a@x.io");

    const response = await post("/api/auth/reset-password", { token, password: "short" });
    expect(response.status).toBe(400);

    const login = await post("/api/auth/login", { email: "a@x.io", password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("HTML 表单提交成功返回成功页", async () => {
    await registerVerified("a@x.io");
    const token = await requestReset("a@x.io");

    const response = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${token}&password=brandnewpassword`,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("密码已重置");
  });
});

describe("POST /api/auth/logout", () => {
  it("清掉 cookie", async () => {
    const cookie = await registerVerified("a@x.io");

    const response = await post("/api/auth/logout", {}, { cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});

describe("GET /api/auth/me", () => {
  it("已登录返回当前用户", async () => {
    const cookie = await registerVerified("a@x.io");

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

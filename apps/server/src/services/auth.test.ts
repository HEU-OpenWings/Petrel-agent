import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthService } from "./auth.ts";
import type { Mailer } from "./mailer.ts";

const PASSWORD = "hunter2hunter2";

let db: TestDb;
let service: ReturnType<typeof createAuthService>;
let mails: { to: string; subject: string; text: string }[];
let reset: () => Promise<void>;
let close: () => Promise<void>;

function fakeMailer(): Mailer {
  return {
    async send(input) {
      mails.push({ to: input.to, subject: input.subject, text: input.text });
    },
  };
}

function lastToken(): string {
  const mail = mails.at(-1);
  if (!mail) throw new Error("没有发送过邮件");
  const match = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("邮件里没有 token");
  const token = match[1];
  if (!token) throw new Error("邮件里没有 token");
  return token;
}

function firstMail(): { to: string; subject: string; text: string } {
  const mail = mails[0];
  if (!mail) throw new Error("没有发送过邮件");
  return mail;
}

/** 注册 + 用假邮件里的 token 验证，返回已验证用户 */
async function registerVerified(email: string, password = PASSWORD) {
  const { user } = await service.register(email, password);
  await service.verifyEmail(lastToken());
  return user;
}

beforeAll(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(async () => {
  await reset();
  mails = [];
  // 每个用例一个全新的 service：限流计数是实例内的 Map，不重建会串味
  service = createAuthService(db, fakeMailer());
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => close?.());

describe("register", () => {
  it("注册成功返回公开字段", async () => {
    const { user } = await service.register("Alice@Example.com", PASSWORD);

    expect(user.email).toBe("alice@example.com");
    expect(user.role).toBe("user");
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("注册即发验证邮件并声明 verificationSent，收件人是注册邮箱", async () => {
    const { verificationSent } = await service.register("a@x.io", PASSWORD);

    expect(verificationSent).toBe(true);
    expect(mails).toHaveLength(1);
    expect(firstMail().to).toBe("a@x.io");
    expect(firstMail().text).toContain("/api/auth/verify-email?token=");
  });

  it("邮件发送失败时仍返回 201 语义（verificationSent=false）且用户已建出", async () => {
    const broken = createAuthService(db, {
      async send() {
        throw new Error("smtp down");
      },
    });

    const result = await broken.register("a@x.io", PASSWORD);

    expect(result.verificationSent).toBe(false);
    expect(result.user.email).toBe("a@x.io");
    // 未验证（开关仍开启），可走重发验证 / 忘记密码自救
    expect(result.user.emailVerifiedAt).toBeNull();
    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 403 });
  });

  it("邮箱大小写归一后重复注册返回 409", async () => {
    await service.register("a@x.io", PASSWORD);

    await expect(service.register("A@X.IO", PASSWORD)).rejects.toMatchObject({ status: 409 });
  });

  it("密码短于 8 位返回 400", async () => {
    await expect(service.register("a@x.io", "short")).rejects.toMatchObject({ status: 400 });
  });

  it("密码超过 200 位返回 400", async () => {
    await expect(service.register("a@x.io", "x".repeat(201))).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    { name: "没有 @", email: "notanemail" },
    { name: "没有域名", email: "a@" },
    { name: "域名没有点", email: "a@localhost" },
    { name: "有空格", email: "a b@x.io" },
    { name: "空字符串", email: "" },
  ])("$name 返回 400", async ({ email }) => {
    await expect(service.register(email, PASSWORD)).rejects.toMatchObject({ status: 400 });
  });

  it("邮箱在 ADMIN_EMAILS 里时直接建成 admin", async () => {
    vi.stubEnv("ADMIN_EMAILS", "boss@x.io");
    vi.resetModules();
    const { createAuthService: freshFactory } = await import("./auth.ts");

    const { user } = await freshFactory(db, fakeMailer()).register("Boss@X.io", PASSWORD);

    expect(user.role).toBe("admin");
    vi.unstubAllEnvs();
  });
});

describe("EMAIL_VERIFICATION_ENABLED=false（开发/内网演示）", () => {
  it("注册即已验证、不发邮件、可以直接登录", async () => {
    vi.stubEnv("EMAIL_VERIFICATION_ENABLED", "false");
    vi.resetModules();
    const { createAuthService: freshFactory } = await import("./auth.ts");
    const relaxed = freshFactory(db, fakeMailer());

    const { user, verificationSent } = await relaxed.register("a@x.io", PASSWORD);

    expect(verificationSent).toBe(false);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(mails).toHaveLength(0);
    await expect(relaxed.login("a@x.io", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
    vi.unstubAllEnvs();
  });

  it("默认 true：开关缺失时仍要求验证", async () => {
    const { user } = await service.register("a@x.io", PASSWORD);

    expect(user.emailVerifiedAt).toBeNull();
    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 403 });
  });
});

describe("邮箱验证", () => {
  it("未验证时正确密码登录返回 403", async () => {
    await service.register("a@x.io", PASSWORD);

    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({
      status: 403,
      message: "邮箱尚未验证，请先查收验证邮件",
    });
  });

  it("密码错误与账号不存在的错误完全一致（不泄漏未验证状态）", async () => {
    await service.register("a@x.io", PASSWORD);

    const wrongPassword = await service.login("a@x.io", "wrongpassword").catch((error) => error);
    const noSuchUser = await service.login("nobody@x.io", "wrongpassword").catch((error) => error);

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(wrongPassword.message).toBe(noSuchUser.message);
  });

  it("用邮件里的 token 验证后可以登录", async () => {
    await service.register("a@x.io", PASSWORD);
    const verified = await service.verifyEmail(lastToken());

    expect(verified.emailVerifiedAt).toBeInstanceOf(Date);
    await expect(service.login("a@x.io", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("验证幂等：重复点击同一链接仍成功", async () => {
    await service.register("a@x.io", PASSWORD);
    const token = lastToken();

    await service.verifyEmail(token);
    await expect(service.verifyEmail(token)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("无效 token 返回 400", async () => {
    await expect(service.verifyEmail("bogus")).rejects.toMatchObject({
      status: 400,
      message: "验证链接无效或已过期",
    });
  });

  it("验证 token 过期后返回 400", async () => {
    vi.useFakeTimers();
    await service.register("a@x.io", PASSWORD);
    const token = lastToken();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    await expect(service.verifyEmail(token)).rejects.toMatchObject({ status: 400 });
  });
});

describe("resendVerification", () => {
  it("给未验证用户重发邮件", async () => {
    await service.register("a@x.io", PASSWORD);
    mails.length = 0;

    await service.resendVerification("a@x.io");

    expect(mails).toHaveLength(1);
    expect(firstMail().to).toBe("a@x.io");
  });

  it("账号不存在时静默成功（防枚举）", async () => {
    await expect(service.resendVerification("nobody@x.io")).resolves.toBeUndefined();
    expect(mails).toHaveLength(0);
  });

  it("已验证账号静默成功", async () => {
    await registerVerified("a@x.io");
    mails.length = 0;

    await service.resendVerification("a@x.io");

    expect(mails).toHaveLength(0);
  });

  it("同一邮箱第 4 次请求返回 429", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await service.resendVerification("a@x.io");
    }

    await expect(service.resendVerification("a@x.io")).rejects.toMatchObject({ status: 429 });
  });
});

describe("login", () => {
  it("验证后正确密码登录成功", async () => {
    await registerVerified("a@x.io");

    await expect(service.login("a@x.io", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("邮箱大小写不影响登录", async () => {
    await registerVerified("a@x.io");

    await expect(service.login("A@X.IO", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("被禁用的账号登不进来", async () => {
    await registerVerified("a@x.io");
    const { createUserRepository } = await import("@petrel/database");
    const found = await createUserRepository(db).findByEmail("a@x.io");
    await createUserRepository(db).setDisabled(found!.id, true);

    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 401 });
  });

  it("邮箱进了 ADMIN_EMAILS 的既有用户，下次登录自动提权", async () => {
    await registerVerified("boss@x.io");

    vi.stubEnv("ADMIN_EMAILS", "boss@x.io");
    vi.resetModules();
    const { createAuthService: freshFactory } = await import("./auth.ts");

    const user = await freshFactory(db, fakeMailer()).login("boss@x.io", PASSWORD);

    expect(user.role).toBe("admin");
    vi.unstubAllEnvs();
  });
});

describe("登录失败限流", () => {
  it("连续失败 5 次后第 6 次返回 429", async () => {
    await registerVerified("a@x.io");

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 401 });
    }

    await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 429 });
  });

  it("限流期间正确密码同样被拒（到阈值就不再验密码）", async () => {
    await registerVerified("a@x.io");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 429 });
  });

  it("15 分钟后自动解除", async () => {
    vi.useFakeTimers();
    await registerVerified("a@x.io");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    await expect(service.login("a@x.io", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("成功登录清零计数", async () => {
    await registerVerified("a@x.io");
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await service.login("a@x.io", PASSWORD);

    // 计数已清零，又能再失败 5 次才触发限流
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 401 });
    }
  });

  it("限流按邮箱隔离，打 A 不影响 B", async () => {
    await registerVerified("a@x.io");
    await registerVerified("b@x.io");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await expect(service.login("b@x.io", PASSWORD)).resolves.toMatchObject({ email: "b@x.io" });
  });
});

describe("忘记密码", () => {
  it("已注册邮箱收到带 token 的重置邮件", async () => {
    await registerVerified("a@x.io");
    mails.length = 0;

    await service.forgotPassword("a@x.io");

    expect(mails).toHaveLength(1);
    expect(firstMail().to).toBe("a@x.io");
    expect(firstMail().text).toContain("/api/auth/reset-password?token=");
  });

  it("账号不存在时静默成功（防枚举）", async () => {
    await expect(service.forgotPassword("nobody@x.io")).resolves.toBeUndefined();
    expect(mails).toHaveLength(0);
  });

  it("同一邮箱第 4 次请求返回 429", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await service.forgotPassword("a@x.io");
    }

    await expect(service.forgotPassword("a@x.io")).rejects.toMatchObject({ status: 429 });
  });
});

describe("重置密码", () => {
  it("重置后旧密码失效、新密码可登录，未验证账号顺带完成验证", async () => {
    await service.register("a@x.io", PASSWORD);
    await service.forgotPassword("a@x.io");

    await service.resetPassword(lastToken(), "brandnewpassword");

    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 401 });
    await expect(service.login("a@x.io", "brandnewpassword")).resolves.toMatchObject({
      email: "a@x.io",
    });
  });

  it("重置 token 一次性：用过后再请求返回 400", async () => {
    await registerVerified("a@x.io");
    await service.forgotPassword("a@x.io");
    const token = lastToken();
    await service.resetPassword(token, "brandnewpassword");

    await expect(service.resetPassword(token, "anotherpassword")).rejects.toMatchObject({
      status: 400,
      message: "重置链接无效或已过期",
    });
  });

  it("弱密码返回 400 且不改变原密码", async () => {
    await registerVerified("a@x.io");
    await service.forgotPassword("a@x.io");

    await expect(service.resetPassword(lastToken(), "short")).rejects.toMatchObject({ status: 400 });
    await expect(service.login("a@x.io", PASSWORD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("重置 token 过期后返回 400", async () => {
    vi.useFakeTimers();
    await registerVerified("a@x.io");
    await service.forgotPassword("a@x.io");
    const token = lastToken();

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    await expect(service.resetPassword(token, "brandnewpassword")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("重置成功后解除登录失败锁定", async () => {
    await registerVerified("a@x.io");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }
    await expect(service.login("a@x.io", PASSWORD)).rejects.toMatchObject({ status: 429 });

    await service.forgotPassword("a@x.io");
    await service.resetPassword(lastToken(), "brandnewpassword");

    await expect(service.login("a@x.io", "brandnewpassword")).resolves.toMatchObject({
      email: "a@x.io",
    });
  });

  it("isResetTokenValid 对有效 token 为 true，无效/过期为 false", async () => {
    await registerVerified("a@x.io");
    await service.forgotPassword("a@x.io");
    const token = lastToken();

    await expect(service.isResetTokenValid(token)).resolves.toBe(true);
    await expect(service.isResetTokenValid("bogus")).resolves.toBe(false);
  });
});

describe("changePassword", () => {
  const OLD = PASSWORD;
  const NEW = "correcthorsebattery";

  async function seedUser() {
    return registerVerified("a@x.io", OLD);
  }

  it("旧密码正确时换掉密码", async () => {
    const user = await seedUser();

    await service.changePassword(user, OLD, NEW);

    await expect(service.login("a@x.io", NEW)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("换完之后旧密码登不进来", async () => {
    const user = await seedUser();
    await service.changePassword(user, OLD, NEW);

    await expect(service.login("a@x.io", OLD)).rejects.toMatchObject({ status: 401 });
  });

  it("旧密码不正确时 403 且不改动密码", async () => {
    const user = await seedUser();

    await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
      status: 403,
      message: "当前密码不正确",
    });
    await expect(service.login("a@x.io", OLD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("新密码太短返回 400", async () => {
    const user = await seedUser();

    await expect(service.changePassword(user, OLD, "short")).rejects.toMatchObject({
      status: 400,
    });
  });

  // 必须用「错误的旧密码 + 过短的新密码」才测得到顺序：
  // 长度校验在前 → 根本走不到 verifyPassword，所以既拿到 400、也不计失败次数；
  // 若有人把顺序调换 → verifyPassword 先失败，拿到的是 403 而不是 400，这条立刻红。
  // 只用正确的旧密码是测不出来的：那样 verifyPassword 成功，两种顺序下都不会计数
  it("新密码太短时先报 400，且不消耗失败次数", async () => {
    const user = await seedUser();

    for (let i = 0; i < 6; i += 1) {
      await expect(service.changePassword(user, "wrong-password", "short")).rejects.toMatchObject({
        status: 400,
      });
    }

    // 失败次数没被消耗：正确的旧密码仍然改得动，而不是撞上 429
    await expect(service.changePassword(user, OLD, NEW)).resolves.toBeUndefined();
  });

  it("旧密码连错 5 次后返回 429", async () => {
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
        status: 403,
      });
    }

    await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
      status: 429,
    });
  });

  // 计数器与 login 共用，这是有意的取舍：人已经在登录态里，锁住的只是重新登录，
  // 代价小于为它单开一套计数与清理逻辑。行为要有测试钉住，不然以后会被当成 bug 改掉
  it("改密码打满失败次数会连带锁住登录", async () => {
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
        status: 403,
      });
    }

    await expect(service.login("a@x.io", OLD)).rejects.toMatchObject({ status: 429 });
  });
});

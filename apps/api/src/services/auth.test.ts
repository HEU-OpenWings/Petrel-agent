import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthService } from "./auth.ts";

let db: TestDb;
let service: ReturnType<typeof createAuthService>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(async () => {
  await reset();
  // 每个用例一个全新的 service：限流计数是实例内的 Map，不重建会串味
  service = createAuthService(db);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => close?.());

describe("register", () => {
  it("注册成功返回公开字段", async () => {
    const user = await service.register("Alice@Example.com", "hunter2hunter2");

    expect(user.email).toBe("alice@example.com");
    expect(user.role).toBe("user");
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("邮箱大小写归一后重复注册返回 409", async () => {
    await service.register("a@x.io", "hunter2hunter2");

    await expect(service.register("A@X.IO", "hunter2hunter2")).rejects.toMatchObject({ status: 409 });
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
    await expect(service.register(email, "hunter2hunter2")).rejects.toMatchObject({ status: 400 });
  });

  it("邮箱在 ADMIN_EMAILS 里时直接建成 admin", async () => {
    vi.stubEnv("ADMIN_EMAILS", "boss@x.io");
    vi.resetModules();
    const { createAuthService: freshFactory } = await import("./auth.ts");

    const user = await freshFactory(db).register("Boss@X.io", "hunter2hunter2");

    expect(user.role).toBe("admin");
    vi.unstubAllEnvs();
  });
});

describe("login", () => {
  it("正确密码登录成功", async () => {
    await service.register("a@x.io", "hunter2hunter2");

    const user = await service.login("a@x.io", "hunter2hunter2");

    expect(user.email).toBe("a@x.io");
  });

  it("邮箱大小写不影响登录", async () => {
    await service.register("a@x.io", "hunter2hunter2");

    await expect(service.login("A@X.IO", "hunter2hunter2")).resolves.toMatchObject({ email: "a@x.io" });
  });

  // 账号枚举防护：两种失败必须给出完全一样的响应
  it("密码错误与账号不存在的错误完全一致", async () => {
    await service.register("a@x.io", "hunter2hunter2");

    const wrongPassword = await service.login("a@x.io", "wrongpassword").catch((error) => error);
    const noSuchUser = await service.login("nobody@x.io", "wrongpassword").catch((error) => error);

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(wrongPassword.message).toBe(noSuchUser.message);
  });

  it("被禁用的账号登不进来", async () => {
    await service.register("a@x.io", "hunter2hunter2");
    const { createUserRepository } = await import("@petrel/database");
    const found = await createUserRepository(db).findByEmail("a@x.io");
    await createUserRepository(db).setDisabled(found!.id, true);

    await expect(service.login("a@x.io", "hunter2hunter2")).rejects.toMatchObject({ status: 401 });
  });

  it("邮箱进了 ADMIN_EMAILS 的既有用户，下次登录自动提权", async () => {
    await service.register("boss@x.io", "hunter2hunter2");

    vi.stubEnv("ADMIN_EMAILS", "boss@x.io");
    vi.resetModules();
    const { createAuthService: freshFactory } = await import("./auth.ts");

    const user = await freshFactory(db).login("boss@x.io", "hunter2hunter2");

    expect(user.role).toBe("admin");
    vi.unstubAllEnvs();
  });
});

describe("登录失败限流", () => {
  it("连续失败 5 次后第 6 次返回 429", async () => {
    await service.register("a@x.io", "hunter2hunter2");

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 401 });
    }

    await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 429 });
  });

  it("限流期间正确密码同样被拒（到阈值就不再验密码）", async () => {
    await service.register("a@x.io", "hunter2hunter2");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await expect(service.login("a@x.io", "hunter2hunter2")).rejects.toMatchObject({ status: 429 });
  });

  it("15 分钟后自动解除", async () => {
    vi.useFakeTimers();
    await service.register("a@x.io", "hunter2hunter2");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    await expect(service.login("a@x.io", "hunter2hunter2")).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("成功登录清零计数", async () => {
    await service.register("a@x.io", "hunter2hunter2");
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await service.login("a@x.io", "hunter2hunter2");

    // 计数已清零，又能再失败 5 次才触发限流
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(service.login("a@x.io", "wrongpassword")).rejects.toMatchObject({ status: 401 });
    }
  });

  it("限流按邮箱隔离，打 A 不影响 B", async () => {
    await service.register("a@x.io", "hunter2hunter2");
    await service.register("b@x.io", "hunter2hunter2");
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.login("a@x.io", "wrongpassword").catch(() => {});
    }

    await expect(service.login("b@x.io", "hunter2hunter2")).resolves.toMatchObject({ email: "b@x.io" });
  });
});

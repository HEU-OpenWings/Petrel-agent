import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * env 是模块顶层求值的常量，改完环境变量必须重置模块缓存再动态 import，
 * 否则拿到的永远是本文件第一次 import 时的那份。
 */
async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("./index.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("jwtSecret", () => {
  it("生产环境缺失时抛错", async () => {
    await expect(loadEnv({ NODE_ENV: "production", JWT_SECRET: "" })).rejects.toThrow(
      "生产环境必须提供 JWT_SECRET",
    );
  });

  it("生产环境提供了就用它", async () => {
    const { env } = await loadEnv({ NODE_ENV: "production", JWT_SECRET: "s3cret-from-env" });
    expect(env.jwtSecret).toBe("s3cret-from-env");
  });

  it("开发环境缺失时回落到开发密钥", async () => {
    const { env } = await loadEnv({ NODE_ENV: "development", JWT_SECRET: "" });
    expect(env.jwtSecret).toBe("petrel-dev-secret-do-not-use-in-production");
  });
});

describe("adminEmails", () => {
  it("逗号分隔，统一小写并去空白", async () => {
    const { env } = await loadEnv({ ADMIN_EMAILS: " Alice@Example.COM , bob@x.io " });
    expect(env.adminEmails).toEqual(["alice@example.com", "bob@x.io"]);
  });

  it("缺省是空数组", async () => {
    const { env } = await loadEnv({ ADMIN_EMAILS: "" });
    expect(env.adminEmails).toEqual([]);
  });

  it("忽略多余的逗号", async () => {
    const { env } = await loadEnv({ ADMIN_EMAILS: "a@x.io,,b@x.io," });
    expect(env.adminEmails).toEqual(["a@x.io", "b@x.io"]);
  });
});

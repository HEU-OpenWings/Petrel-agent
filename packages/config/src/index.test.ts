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

describe("compaction", () => {
  it("默认值：开启、0.8、120000", async () => {
    const { env } = await loadEnv({
      COMPACTION_ENABLED: undefined,
      COMPACTION_THRESHOLD_RATIO: undefined,
      COMPACTION_ABSOLUTE_CAP: undefined,
    });
    expect(env.compaction).toEqual({ enabled: true, thresholdRatio: 0.8, absoluteCap: 120_000 });
  });

  it("显式合法值被采用", async () => {
    const { env } = await loadEnv({
      COMPACTION_ENABLED: "false",
      COMPACTION_THRESHOLD_RATIO: "0.5",
      COMPACTION_ABSOLUTE_CAP: "60000",
    });
    expect(env.compaction).toEqual({ enabled: false, thresholdRatio: 0.5, absoluteCap: 60_000 });
  });

  // 非法值一律启动即失败。悄悄回落到默认值的后果是「永不压缩」或「每轮都压」，
  // 而且没有任何报错指向配置
  it.each(["yes", "1", "TRUE", "0"])("COMPACTION_ENABLED 非布尔字符串抛错：%s", async (raw) => {
    await expect(loadEnv({ COMPACTION_ENABLED: raw })).rejects.toThrow("COMPACTION_ENABLED");
  });

  it.each(["0", "1", "1.5", "-0.2", "abc", "NaN"])(
    "COMPACTION_THRESHOLD_RATIO 越界或非数抛错：%s",
    async (raw) => {
      await expect(loadEnv({ COMPACTION_THRESHOLD_RATIO: raw })).rejects.toThrow(
        "COMPACTION_THRESHOLD_RATIO",
      );
    },
  );

  it.each(["0", "-1", "1.5", "abc"])("COMPACTION_ABSOLUTE_CAP 非正整数抛错：%s", async (raw) => {
    await expect(loadEnv({ COMPACTION_ABSOLUTE_CAP: raw })).rejects.toThrow(
      "COMPACTION_ABSOLUTE_CAP",
    );
  });
});

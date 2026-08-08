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
    const { env } = await loadEnv({
      NODE_ENV: "production",
      JWT_SECRET: "s3cret-from-env",
      MAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
    });
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
    await expect(loadEnv({ COMPACTION_ABSOLUTE_CAP: raw })).rejects.toThrow("COMPACTION_ABSOLUTE_CAP");
  });
});

describe("vllmBaseUrl", () => {
  // review 🔴#1：vLLM 的 baseUrl 必须真的从 env 读，否则用户改 VLLM_BASE_URL 无效。
  // 这条测试钉死「env 配置会传到 env.vllmBaseUrl」——ai 包据此装配 provider。
  it("显式值被采用", async () => {
    const { env } = await loadEnv({ VLLM_BASE_URL: "http://localhost:8001/v1" });
    expect(env.vllmBaseUrl).toBe("http://localhost:8001/v1");
  });

  it("留空回落到默认 :8000/v1", async () => {
    const { env } = await loadEnv({ VLLM_BASE_URL: undefined });
    expect(env.vllmBaseUrl).toBe("http://localhost:8000/v1");
  });
});

describe("quota", () => {
  it("默认值：100 万 token、24 小时、enforcement 关闭", async () => {
    const { env } = await loadEnv({
      QUOTA_TOKEN_LIMIT: undefined,
      QUOTA_WINDOW_HOURS: undefined,
      QUOTA_ENFORCEMENT: undefined,
    });
    expect(env.quotaTokenLimit).toBe(1_000_000);
    expect(env.quotaWindowHours).toBe(24);
    expect(env.quotaEnforcement).toBe(false);
  });

  it("显式合法值被采用", async () => {
    const { env } = await loadEnv({
      QUOTA_TOKEN_LIMIT: "500000",
      QUOTA_WINDOW_HOURS: "12",
      QUOTA_ENFORCEMENT: "true",
    });
    expect(env.quotaTokenLimit).toBe(500_000);
    expect(env.quotaWindowHours).toBe(12);
    expect(env.quotaEnforcement).toBe(true);
  });

  // review 🔴#2 回归锁：空串必须回落默认，而非 Number("")===0。
  // QUOTA_TOKEN_LIMIT= → 若不判空串，额度变 0，enforcement 开启后全员被拒；
  // QUOTA_WINDOW_HOURS= → 窗口 0，配额永不生效（静默失效）。两者都无报错指向根因。
  // 这条测试钉死 nonNegativeInt 的 raw==="" 判断：谁删了它，测试就红。
  it('空串回落默认值，不变成 0（防 Number("")===0 静默错配）', async () => {
    const { env } = await loadEnv({
      QUOTA_TOKEN_LIMIT: "",
      QUOTA_WINDOW_HOURS: "",
      QUOTA_ENFORCEMENT: "",
    });
    expect(env.quotaTokenLimit).toBe(1_000_000);
    expect(env.quotaWindowHours).toBe(24);
    expect(env.quotaEnforcement).toBe(false);
  });

  it.each(["-1", "1.5", "abc"])("QUOTA_TOKEN_LIMIT 非非负整数抛错：%s", async (raw) => {
    await expect(loadEnv({ QUOTA_TOKEN_LIMIT: raw })).rejects.toThrow("QUOTA_TOKEN_LIMIT");
  });

  // booleanEnv 大小写不敏感（toLowerCase），故 TRUE/false 等合法；只拒绝真非法值
  it.each(["yes", "1", "maybe", "on"])("QUOTA_ENFORCEMENT 非布尔字符串抛错：%s", async (raw) => {
    await expect(loadEnv({ QUOTA_ENFORCEMENT: raw })).rejects.toThrow("QUOTA_ENFORCEMENT");
  });
});

describe("mail", () => {
  it("开发环境默认 console 传输，不要求 SMTP 配置", async () => {
    const { env } = await loadEnv({
      NODE_ENV: "development",
      MAIL_TRANSPORT: undefined,
      SMTP_HOST: undefined,
    });
    expect(env.mail.transport).toBe("console");
    expect(env.mail.smtp.host).toBe("");
  });

  it("生产环境缺 MAIL_TRANSPORT 启动失败", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        JWT_SECRET: "s3cret",
        MAIL_TRANSPORT: undefined,
      }),
    ).rejects.toThrow("MAIL_TRANSPORT");
  });

  it("生产环境缺 SMTP_HOST 启动失败", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        JWT_SECRET: "s3cret",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: undefined,
      }),
    ).rejects.toThrow("SMTP_HOST");
  });

  it("smtp 配置被完整解析", async () => {
    const { env } = await loadEnv({
      NODE_ENV: "production",
      JWT_SECRET: "s3cret",
      MAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "no-reply@example.com",
      SMTP_PASSWORD: "hunter2",
      MAIL_FROM: " Petrel <no-reply@example.com> ",
    });
    expect(env.mail).toEqual({
      transport: "smtp",
      from: "Petrel <no-reply@example.com>",
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "no-reply@example.com",
        password: "hunter2",
      },
    });
  });

  it("publicApiUrl 与 publicWebUrl 有开发默认值", async () => {
    const { env } = await loadEnv({ PUBLIC_API_URL: undefined, PUBLIC_WEB_URL: undefined });
    expect(env.publicApiUrl).toBe("http://localhost:5050");
    expect(env.publicWebUrl).toBe("http://localhost:5173");
  });
});

describe("rateLimit", () => {
  it("默认值：注册 5 次/15 分钟，邮件 3 次/15 分钟，凭据写 10 次/test 5 次/15 分钟", async () => {
    const { env } = await loadEnv({
      REGISTER_RATE_LIMIT_MAX: undefined,
      REGISTER_RATE_LIMIT_WINDOW_MINUTES: undefined,
      AUTH_MAIL_RATE_LIMIT_MAX: undefined,
      AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES: undefined,
      PROVIDER_CREDENTIAL_WRITE_RATE_LIMIT_MAX: undefined,
      PROVIDER_CREDENTIAL_TEST_RATE_LIMIT_MAX: undefined,
      PROVIDER_CREDENTIAL_RATE_LIMIT_WINDOW_MINUTES: undefined,
    });
    expect(env.rateLimit).toEqual({
      registerMax: 5,
      registerWindowMs: 15 * 60_000,
      authMailMax: 3,
      authMailWindowMs: 15 * 60_000,
      providerCredentialWriteMax: 10,
      providerCredentialTestMax: 5,
      providerCredentialWindowMs: 15 * 60_000,
    });
  });

  it("显式合法值被采用（分钟换算成毫秒）", async () => {
    const { env } = await loadEnv({
      REGISTER_RATE_LIMIT_MAX: "10",
      REGISTER_RATE_LIMIT_WINDOW_MINUTES: "60",
      AUTH_MAIL_RATE_LIMIT_MAX: "5",
      AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES: "30",
    });
    expect(env.rateLimit.registerMax).toBe(10);
    expect(env.rateLimit.registerWindowMs).toBe(60 * 60_000);
    expect(env.rateLimit.authMailMax).toBe(5);
    expect(env.rateLimit.authMailWindowMs).toBe(30 * 60_000);
  });

  it.each(["0", "-1", "1.5", "abc"])("REGISTER_RATE_LIMIT_MAX 非正整数抛错：%s", async (raw) => {
    await expect(loadEnv({ REGISTER_RATE_LIMIT_MAX: raw })).rejects.toThrow("REGISTER_RATE_LIMIT_MAX");
  });

  it.each(["0", "-1", "1.5", "abc"])("REGISTER_RATE_LIMIT_WINDOW_MINUTES 非正整数抛错：%s", async (raw) => {
    await expect(loadEnv({ REGISTER_RATE_LIMIT_WINDOW_MINUTES: raw })).rejects.toThrow(
      "REGISTER_RATE_LIMIT_WINDOW_MINUTES",
    );
  });
});

describe("providerCredentials（HEU-54 kill switch + 加密密钥）", () => {
  // 生成一个合法的 32 字节 base64 密钥（44 字符）
  const VALID_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

  it("默认两开关都 false，且不要求加密密钥（完整 R0 行为）", async () => {
    const { env } = await loadEnv({
      PROVIDER_STORED_CREDENTIALS_ENABLED: undefined,
      PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED: undefined,
      PROVIDER_CREDENTIAL_ENCRYPTION_KEY: undefined,
    });
    expect(env.providerCredentials.storedEnabled).toBe(false);
    expect(env.providerCredentials.managementEnabled).toBe(false);
    expect(env.providerCredentials.encryptionKey).toBeUndefined();
  });

  it("两开关都 false 时，即使加密密钥非法也不报错（kill switch 完整回退）", async () => {
    await expect(
      loadEnv({
        PROVIDER_STORED_CREDENTIALS_ENABLED: "false",
        PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED: "false",
        PROVIDER_CREDENTIAL_ENCRYPTION_KEY: "not-base64-garbage",
      }),
    ).resolves.toBeDefined();
  });

  it("storedEnabled=true 但缺密钥 → 启动失败", async () => {
    await expect(
      loadEnv({
        PROVIDER_STORED_CREDENTIALS_ENABLED: "true",
        PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED: "false",
        PROVIDER_CREDENTIAL_ENCRYPTION_KEY: undefined,
      }),
    ).rejects.toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("managementEnabled=true 但缺密钥 → 启动失败", async () => {
    await expect(
      loadEnv({
        PROVIDER_STORED_CREDENTIALS_ENABLED: "false",
        PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED: "true",
        PROVIDER_CREDENTIAL_ENCRYPTION_KEY: undefined,
      }),
    ).rejects.toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("开关开 + 合法密钥 → 返回 32 字节 Uint8Array", async () => {
    const { env } = await loadEnv({
      PROVIDER_STORED_CREDENTIALS_ENABLED: "true",
      PROVIDER_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY,
    });
    expect(env.providerCredentials.encryptionKey).toBeInstanceOf(Uint8Array);
    expect(env.providerCredentials.encryptionKey?.length).toBe(32);
  });

  it.each([
    ["空串", ""],
    ["长度不对（10 字节）", Buffer.from(new Uint8Array(10)).toString("base64")],
    ["含非法字符（空格）", `${VALID_KEY.slice(0, -1)} `],
    ["base64url 而非标准 base64", Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")],
  ])("开关开 + 非法密钥（%s）→ 启动失败", async (_label, badKey) => {
    await expect(
      loadEnv({
        PROVIDER_STORED_CREDENTIALS_ENABLED: "true",
        PROVIDER_CREDENTIAL_ENCRYPTION_KEY: badKey,
      }),
    ).rejects.toThrow("PROVIDER_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("错误信息不含密钥值（不回显）", async () => {
    const SECRET = "a-very-unique-secret-value-not-base64!!";
    let message = "";
    try {
      await loadEnv({
        PROVIDER_STORED_CREDENTIALS_ENABLED: "true",
        PROVIDER_CREDENTIAL_ENCRYPTION_KEY: SECRET,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(SECRET);
  });
});

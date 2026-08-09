import { createUserRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

// 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

// 与 account.test.ts 一致：不 mock @petrel/agent。listProviderStatuses / listProviderModels
// 是纯查询函数（不进 createHarness），走真实实现，用 vi.stubEnv 控制 configured 状态。

// 全部需要解析凭据的环境变量。默认全部清空，避免开发者机器真实 key 污染断言。
const ALL_AUTH_ENV_VARS = [
  "DEEPSEEK_API_KEY",
  "SILICONFLOW_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "ZAI_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "OLLAMA_API_KEY",
  "VLLM_API_KEY",
];

const SECRET_SENTINEL = "secret-sentinel-DO-NOT-LEAK-9f3a";

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

// 默认清空全部 auth env（pi 实时读 process.env，空串视为未设置）。需要某 provider
// 已配置的用例自己 stub。这样每个用例起点都是「全部未配置」的确定状态。
beforeEach(() => {
  for (const name of ALL_AUTH_ENV_VARS) vi.stubEnv(name, "");
  __resetAuthRateLimits();
  return reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => close?.());

/** 注册一个用户并返回它的 cookie（验证流程在 routes/auth.test.ts 覆盖，这里直接置为已验证再登录） */
async function registerUser(email: string): Promise<string> {
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
  return (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

describe("GET /api/providers 鉴权与挂载", () => {
  it("未登录返回 401 且不缓存", async () => {
    const response = await app.request("/api/providers");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("已登录普通用户可访问（不要求 admin）", async () => {
    const cookie = await registerUser("user@x.io");
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
  });
});

describe("GET /api/providers 响应内容", () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = await registerUser("content@x.io");
  });

  it("返回 defaultProviderId / defaultModelId 与 providers 数组", async () => {
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    const body = (await response.json()) as {
      defaultProviderId: string;
      defaultModelId: string;
      providers: unknown[];
    };

    expect(body.defaultProviderId).toBe("deepseek");
    expect(body.defaultModelId).toBe("deepseek-v4-flash");
    // 11 个运行时 provider 全列出（含未配置的）
    expect(body.providers.length).toBe(11);
  });

  it("带 Cache-Control: no-store", async () => {
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("未配置的 provider configured=false 但 envVars 仍有值", async () => {
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    const body = (await response.json()) as {
      providers: Array<{ id: string; configured: boolean; envVars: string[] }>;
    };
    const openai = body.providers.find((p) => p.id === "openai");

    expect(openai?.configured).toBe(false);
    expect(openai?.envVars).toEqual(["OPENAI_API_KEY"]);
  });

  it("配了 DeepSeek key 后，deepseek configured=true，明文 key 不泄露", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", SECRET_SENTINEL);
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET_SENTINEL);

    const body = JSON.parse(text) as { providers: Array<{ id: string; configured: boolean }> };
    const deepseek = body.providers.find((p) => p.id === "deepseek");
    expect(deepseek?.configured).toBe(true);
  });

  // ollama/vllm 的 envVars 必须是真实值（OLLAMA_API_KEY / VLLM_API_KEY），
  // 不能是空数组——王若宁前端硬编码的是 []，后端必须纠正。
  it("ollama / vllm 返回真实 env var 名（非空数组）", async () => {
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    const body = (await response.json()) as { providers: Array<{ id: string; envVars: string[] }> };
    const ollama = body.providers.find((p) => p.id === "ollama");
    const vllm = body.providers.find((p) => p.id === "vllm");

    expect(ollama?.envVars).toEqual(["OLLAMA_API_KEY"]);
    expect(vllm?.envVars).toEqual(["VLLM_API_KEY"]);
  });

  // 安全：响应 JSON 不含 pi 内部字段（baseUrl/headers/auth/apiKey/cost）
  it("响应 JSON 不含 baseUrl / headers / apiKey / cost 等内部字段", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", SECRET_SENTINEL);
    const response = await app.request("/api/providers", { headers: { Cookie: cookie } });
    const text = await response.text();

    expect(text).not.toMatch(/"baseUrl"/i);
    expect(text).not.toMatch(/"headers"/i);
    expect(text).not.toMatch(/"apiKey"/i);
    expect(text).not.toMatch(/"cost"/i);
  });
});

describe("GET /api/providers/:providerId/models", () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = await registerUser("models@x.io");
  });

  it("未登录返回 401（401 优先于 404）", async () => {
    const response = await app.request("/api/providers/does-not-exist/models");
    expect(response.status).toBe(401);
  });

  it("未知 provider 返回 404", async () => {
    const response = await app.request("/api/providers/does-not-exist/models", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PROVIDER_NOT_FOUND", message: expect.any(String) },
    });
  });

  // N1：404 也带 no-store（新增同名 provider 后，暂存的 404 会让客户端以为它不存在）
  it("未知 provider 的 404 也带 Cache-Control: no-store", async () => {
    const response = await app.request("/api/providers/does-not-exist/models", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("未配置 provider 仍返回 200，模型 available=false", async () => {
    const response = await app.request("/api/providers/openai/models", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      models: Array<{ available: boolean }>;
    };
    expect(body.configured).toBe(false);
    expect(body.models.length).toBeGreaterThan(0);
    for (const m of body.models) expect(m.available).toBe(false);
  });

  it("已配置 provider 的模型 available=true", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", SECRET_SENTINEL);
    const response = await app.request("/api/providers/deepseek/models", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      models: Array<{ id: string; available: boolean }>;
    };
    expect(body.configured).toBe(true);
    expect(body.models.length).toBe(1);
    expect(body.models[0]?.available).toBe(true);
  });

  it("带 Cache-Control: no-store", async () => {
    const response = await app.request("/api/providers/deepseek/models", {
      headers: { Cookie: cookie },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("明文 key 不泄露", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", SECRET_SENTINEL);
    const response = await app.request("/api/providers/deepseek/models", {
      headers: { Cookie: cookie },
    });
    const text = await response.text();
    expect(text).not.toContain(SECRET_SENTINEL);
  });
});

describe("management kill switch 关闭时写端点自然 404", () => {
  // 测试进程使用默认 management=false。三个写路由不注册占位 handler，
  // 认证后自然落到 notFound；开启时的完整合同由 providers-write.test.ts 覆盖。
  let cookie: string;
  beforeEach(async () => {
    cookie = await registerUser("r1@x.io");
  });

  it("PUT /api/providers/:id/credential 认证后 404", async () => {
    const response = await app.request("/api/providers/deepseek/credential", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ apiKey: "x" }),
    });
    expect(response.status).toBe(404);
  });

  it("DELETE /api/providers/:id/credential 认证后 404", async () => {
    const response = await app.request("/api/providers/deepseek/credential", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });

  it("POST /api/providers/:id/test 认证后 404", async () => {
    const response = await app.request("/api/providers/deepseek/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ apiKey: "x" }),
    });
    expect(response.status).toBe(404);
  });
});

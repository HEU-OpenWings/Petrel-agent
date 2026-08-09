import { UserProviderServiceError } from "@petrel/agent";
import type { PublicUser } from "@petrel/database";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { RateLimiter } from "../../services/rate-limit.ts";
import type { AppEnv } from "../../types.ts";
import { createProvidersRoutes } from "./providers.ts";

const USER: PublicUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "provider-owner@example.com",
  role: "user",
  disabled: false,
  emailVerifiedAt: new Date(0),
  createdAt: new Date(0),
};

function limiter(allowed = true): RateLimiter & { hit: ReturnType<typeof vi.fn> } {
  return {
    hit: vi.fn(() => allowed),
    reset: vi.fn(),
  };
}

function serviceStub() {
  return {
    listProviders: vi.fn(async () => ({
      defaultProviderId: "deepseek",
      defaultModelId: "deepseek-v4-flash",
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      providers: [],
    })),
    listProviderModels: vi.fn(async () => ({
      provider: { id: "deepseek", name: "DeepSeek", isDefault: true },
      configured: true,
      runtimeStatus: "ready" as const,
      statusMessage: null,
      models: [],
    })),
    saveCredential: vi.fn(async (providerId: string) => ({
      providerId,
      credential: { status: "stored" as const, keyHint: "abcd", updatedAt: "2026-08-09T00:00:00.000Z" },
    })),
    testCredential: vi.fn(async (providerId: string) => ({
      ok: true as const,
      providerId,
      modelId: "deepseek-v4-flash",
      source: "candidate" as const,
    })),
    deleteCredentialAndNormalizeDefaultModel: vi.fn(async (providerId: string) => ({
      providerId,
      credential: { status: "not_stored" as const, keyHint: null, updatedAt: null },
      defaultModelReset: true,
    })),
  };
}

function createTestApp(input: {
  managementEnabled: boolean;
  service?: ReturnType<typeof serviceStub>;
  writeLimiter?: RateLimiter;
  testLimiter?: RateLimiter;
}) {
  const service = input.service ?? serviceStub();
  const createService = vi.fn(() => service);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("currentUser", USER);
    await next();
  });
  app.route(
    "/api/providers",
    createProvidersRoutes({
      managementEnabled: input.managementEnabled,
      createService,
      writeLimiter: input.writeLimiter ?? limiter(),
      testLimiter: input.testLimiter ?? limiter(),
    }),
  );
  return { app, service, createService };
}

function request(method: "PUT" | "POST" | "DELETE", body?: unknown) {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe("Provider credential management kill switch", () => {
  it.each([
    ["PUT", "/api/providers/deepseek/credential", { apiKey: "candidate-key-1234" }],
    ["POST", "/api/providers/deepseek/test", {}],
    ["DELETE", "/api/providers/deepseek/credential", undefined],
  ] as const)("management=false 时 %s 写路由自然 404 且 no-store", async (method, path, body) => {
    const { app, createService } = createTestApp({ managementEnabled: false });

    const response = await app.request(path, request(method, body));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(createService).not.toHaveBeenCalled();
  });
});

describe("Provider credential management contract", () => {
  it("PUT 只用 currentUser.id，保存并返回安全 metadata", async () => {
    const { app, service, createService } = createTestApp({ managementEnabled: true });

    const response = await app.request(
      "/api/providers/deepseek/credential?userId=attacker",
      request("PUT", { apiKey: "candidate-key-1234" }),
    );

    expect(response.status).toBe(200);
    expect(createService).toHaveBeenCalledWith(USER.id);
    expect(service.saveCredential).toHaveBeenCalledWith("deepseek", "candidate-key-1234");
    await expect(response.json()).resolves.toEqual({
      providerId: "deepseek",
      credential: { status: "stored", keyHint: "abcd", updatedAt: "2026-08-09T00:00:00.000Z" },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("PUT 拒绝 userId 或其他额外 body 字段", async () => {
    const { app, service } = createTestApp({ managementEnabled: true });
    const response = await app.request(
      "/api/providers/deepseek/credential",
      request("PUT", {
        apiKey: "candidate-key-1234",
        userId: "attacker",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: expect.any(String) },
    });
    expect(service.saveCredential).not.toHaveBeenCalled();
  });

  it("POST 在 apiKey 属性存在且为空时仍把 candidate 传给领域层", async () => {
    const { app, service } = createTestApp({ managementEnabled: true });
    service.testCredential.mockRejectedValueOnce(
      new UserProviderServiceError("invalid_api_key", "API key 不能为空"),
    );

    const response = await app.request("/api/providers/deepseek/test", request("POST", { apiKey: "" }));

    expect(service.testCredential).toHaveBeenCalledWith("deepseek", { apiKey: "" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_API_KEY", message: "API key 不能为空" },
    });
  });

  it("POST 在 candidate 缺省时传空对象，保留 personal/ambient 回落语义", async () => {
    const { app, service } = createTestApp({ managementEnabled: true });

    const response = await app.request("/api/providers/deepseek/test", request("POST", {}));

    expect(response.status).toBe(200);
    expect(service.testCredential).toHaveBeenCalledWith("deepseek", {});
  });

  it("DELETE 返回幂等 not_stored 状态与 defaultModelReset", async () => {
    const { app, service } = createTestApp({ managementEnabled: true });

    const response = await app.request("/api/providers/deepseek/credential", request("DELETE"));

    expect(service.deleteCredentialAndNormalizeDefaultModel).toHaveBeenCalledWith("deepseek");
    await expect(response.json()).resolves.toEqual({
      providerId: "deepseek",
      credential: { status: "not_stored", keyHint: null, updatedAt: null },
      defaultModelReset: true,
    });
  });

  it("PUT/DELETE 共用 write limiter，POST test 使用独立 limiter，均只按 userId 分桶", async () => {
    const writeLimiter = limiter(false);
    const testLimiter = limiter(true);
    const { app, service } = createTestApp({
      managementEnabled: true,
      writeLimiter,
      testLimiter,
    });

    const put = await app.request(
      "/api/providers/deepseek/credential",
      request("PUT", { apiKey: "candidate-key-1234" }),
    );
    const deleted = await app.request("/api/providers/openai/credential", request("DELETE"));
    const tested = await app.request("/api/providers/openai/test", request("POST", {}));

    expect(put.status).toBe(429);
    expect(deleted.status).toBe(429);
    expect(tested.status).toBe(200);
    expect(writeLimiter.hit).toHaveBeenNthCalledWith(1, USER.id);
    expect(writeLimiter.hit).toHaveBeenNthCalledWith(2, USER.id);
    expect(testLimiter.hit).toHaveBeenCalledWith(USER.id);
    expect(put.headers.has("retry-after")).toBe(false);
    expect(service.saveCredential).not.toHaveBeenCalled();
    expect(service.deleteCredentialAndNormalizeDefaultModel).not.toHaveBeenCalled();
  });

  it.each([
    ["provider_not_found", 404, "PROVIDER_NOT_FOUND"],
    ["invalid_api_key", 400, "INVALID_API_KEY"],
    ["credential_conflict", 409, "CREDENTIAL_CONFLICT"],
    ["credential_not_configured", 409, "CREDENTIAL_NOT_CONFIGURED"],
    ["credential_rejected", 422, "CREDENTIAL_REJECTED"],
    ["credential_test_failed", 422, "CREDENTIAL_TEST_FAILED"],
    ["local_service_unavailable", 422, "CREDENTIAL_TEST_FAILED"],
    ["credential_store_unavailable", 503, "CREDENTIAL_STORE_UNAVAILABLE"],
    ["credential_test_timeout", 504, "CREDENTIAL_TEST_TIMEOUT"],
  ] as const)("领域错误 %s 映射为 %s/%s", async (kind, status, code) => {
    const service = serviceStub();
    service.testCredential.mockRejectedValueOnce(new UserProviderServiceError(kind, "安全领域文案"));
    const { app } = createTestApp({ managementEnabled: true, service });

    const response = await app.request("/api/providers/deepseek/test", request("POST", {}));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: "安全领域文案" },
    });
  });

  it("未知错误固定为 500，不透传原始异常", async () => {
    const service = serviceStub();
    service.saveCredential.mockRejectedValueOnce(new Error("raw upstream secret response"));
    const { app } = createTestApp({ managementEnabled: true, service });

    const response = await app.request(
      "/api/providers/deepseek/credential",
      request("PUT", { apiKey: "candidate-key-1234" }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("raw upstream");
    expect(JSON.parse(text)).toEqual({
      error: { code: "PROVIDER_OPERATION_FAILED", message: expect.any(String) },
    });
  });
});

import { randomBytes } from "node:crypto";
import {
  type AssistantMessage,
  type AuthContext,
  createModels,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createPreferencesRepository,
  createProviderCredentialRepository,
  type Database,
  users,
} from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbCredentialStore } from "./db-credential-store.ts";
import { createProviderCredentialCipher } from "./provider-credential-crypto.ts";
import { PROVIDER_CREDENTIAL_HINTS, PROVIDERS } from "./providers.ts";
import { createUserModels } from "./user-models.ts";
import {
  createUserProviderService,
  type ProviderCapabilities,
  UserProviderServiceError,
} from "./user-provider-service.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const cipher = createProviderCredentialCipher(new Uint8Array(randomBytes(32)));
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});

beforeEach(async () => {
  await reset();
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, email: "other@example.com", passwordHash: "!" })
    .onConflictDoNothing();
});

afterAll(() => close?.());

function context(values: Record<string, string> = {}): AuthContext {
  return {
    env: async (name) => values[name],
    fileExists: async () => false,
  };
}

function ambientModels(values: Record<string, string> = {}): Models {
  const registry = createModels({ authContext: context(values) });
  for (const provider of PROVIDERS) registry.setProvider(provider);
  return registry;
}

function successMessage(
  provider: string,
  model: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "openai-responses",
    provider,
    model,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 0,
  };
}

function createService(input: {
  capabilities: ProviderCapabilities;
  ambient?: Record<string, string>;
  probeExecutor?: (
    registry: Models,
    model: Parameters<Models["completeSimple"]>[0],
    probeContext: Parameters<Models["completeSimple"]>[1],
    options: ModelsSimpleStreamOptions,
  ) => Promise<AssistantMessage>;
  probeTimeoutMs?: number;
}) {
  const authContext = context(input.ambient);
  const envModels = ambientModels(input.ambient);
  const userModels = createUserModels(db, TEST_USER_ID, { cipher, authContext });
  return {
    userModels,
    service: createUserProviderService(db, TEST_USER_ID, {
      capabilities: input.capabilities,
      ambientModels: envModels,
      userModels,
      cipher,
      ...(input.probeExecutor ? { probeExecutor: input.probeExecutor } : {}),
      ...(input.probeTimeoutMs !== undefined ? { probeTimeoutMs: input.probeTimeoutMs } : {}),
    }),
  };
}

function providerFrom(
  providers: Awaited<ReturnType<ReturnType<typeof createUserProviderService>["listProviders"]>>["providers"],
  id: string,
) {
  const provider = providers.find((item) => item.id === id);
  if (!provider) throw new Error(`测试预期找到 provider ${id}`);
  return provider;
}

function expectServiceError(error: unknown, kind: UserProviderServiceError["kind"]): void {
  expect(error).toBeInstanceOf(UserProviderServiceError);
  expect((error as UserProviderServiceError).kind).toBe(kind);
}

describe("kill-switch 与 runtime credential source", () => {
  it("stored=false management=false：完整 R0，不读个人元数据，runtime 只认 ambient", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: false, credentialManagementEnabled: false },
      ambient: { DEEPSEEK_API_KEY: "ambient-deepseek-key" },
    });

    const result = await service.listProviders();
    const deepseek = providerFrom(result.providers, "deepseek");
    expect(result.capabilities).toEqual({
      storedCredentialsEnabled: false,
      credentialManagementEnabled: false,
    });
    expect(deepseek.configured).toBe(true);
    expect(deepseek.personalCredential).toEqual({
      status: "disabled",
      keyHint: null,
      updatedAt: null,
    });
    expect(deepseek.runtimeCredentialSource).toBe("ambient");

    await service
      .saveCredential("deepseek", "candidate-valid-key")
      .catch((error) => expectServiceError(error, "management_disabled"));
  });

  it("stored=false management=true：可预灌个人 key，但 runtime 仍保持 R0", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: false, credentialManagementEnabled: true },
    });
    await service.saveCredential("deepseek", "personal-preloaded-key");

    const result = await service.listProviders();
    const deepseek = providerFrom(result.providers, "deepseek");
    expect(deepseek.personalCredential.status).toBe("stored");
    expect(deepseek.configured).toBe(false);
    expect(deepseek.runtimeCredentialSource).toBe("none");
    await expect(service.listConfiguredModels()).resolves.toEqual([]);
  });

  it("stored=true management=false：runtime 使用已有个人 key，但管理操作冻结", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify("deepseek", async () => ({ type: "api_key", key: "preexisting-user-key" }));
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: false },
    });

    const result = await service.listProviders();
    const deepseek = providerFrom(result.providers, "deepseek");
    expect(deepseek.personalCredential.status).toBe("stored");
    expect(deepseek.configured).toBe(true);
    expect(deepseek.runtimeCredentialSource).toBe("personal");

    await service
      .deleteCredentialAndNormalizeDefaultModel("deepseek")
      .catch((error) => expectServiceError(error, "management_disabled"));
  });

  it("stored=true management=true：保存后同一 service 立即按个人 key 提供模型", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
    });
    await service.saveCredential("deepseek", "full-r1-personal-key");

    const result = await service.listProviders();
    const deepseek = providerFrom(result.providers, "deepseek");
    expect(deepseek.configured).toBe(true);
    expect(deepseek.runtimeCredentialSource).toBe("personal");
    expect((await service.listConfiguredModels()).some((model) => model.provider === "deepseek")).toBe(true);
  });

  it("个人 metadata 查询失败时状态为 unknown，不伪装成未保存或 ambient", async () => {
    const authContext = context();
    const registry = createUserModels(db, TEST_USER_ID, { cipher, authContext });
    const unavailableDb = {
      select() {
        throw new Error("raw database unavailable");
      },
    } as unknown as Database;
    const service = createUserProviderService(unavailableDb, TEST_USER_ID, {
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambientModels: ambientModels(),
      userModels: registry,
      cipher,
    });

    const deepseek = providerFrom((await service.listProviders()).providers, "deepseek");
    expect(deepseek.personalCredential).toEqual({
      status: "unknown",
      keyHint: null,
      updatedAt: null,
    });
    expect(deepseek.runtimeCredentialSource).toBe("unknown");
  });
});

describe("保存与覆盖", () => {
  it("只做本地校验和加密保存，不调用连接探针", async () => {
    const probeExecutor = vi.fn();
    const { service, userModels } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor,
    });

    const saved = await service.saveCredential("deepseek", "  key-version-one-abcd  ");
    expect(saved.providerId).toBe("deepseek");
    expect(saved.credential.status).toBe("stored");
    expect(saved.credential.keyHint).toBe("abcd");
    expect(saved.credential.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(saved.credential).sort()).toEqual(["keyHint", "status", "updatedAt"]);
    expect(JSON.stringify(saved)).not.toContain("key-version-one-abcd");
    expect(probeExecutor).not.toHaveBeenCalled();

    const model = userModels.getModel("deepseek", "deepseek-v4-flash");
    if (!model) throw new Error("测试缺少 DeepSeek 模型");
    expect((await userModels.getAuth(model))?.auth.apiKey).toBe("key-version-one-abcd");
  });

  it("覆盖后同一 Models 实例下一次 auth 立即读到新 key", async () => {
    const { service, userModels } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
    });
    await service.saveCredential("deepseek", "key-version-one-aaaa");
    await service.saveCredential("deepseek", "key-version-two-bbbb");

    const model = userModels.getModel("deepseek", "deepseek-v4-flash");
    if (!model) throw new Error("测试缺少 DeepSeek 模型");
    expect((await userModels.getAuth(model))?.auth.apiKey).toBe("key-version-two-bbbb");
    expect(
      (await service.listProviders()).providers.find((p) => p.id === "deepseek")?.personalCredential.keyHint,
    ).toBe("bbbb");
  });

  it("拒绝非法 key 与未知 provider", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
    });

    await service
      .saveCredential("deepseek", "short")
      .catch((error) => expectServiceError(error, "invalid_api_key"));
    await service
      .saveCredential("missing", "long-enough-key")
      .catch((error) => expectServiceError(error, "provider_not_found"));
  });
});

describe("删除与默认模型归一", () => {
  it("删除唯一的个人凭据后，默认模型不可用则条件清回 null", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
    });
    await service.saveCredential("deepseek", "personal-delete-key");
    await createPreferencesRepository(db).save(TEST_USER_ID, {
      defaultModel: "deepseek-v4-flash",
      systemPrompt: "保留提示词",
    });

    await expect(service.deleteCredentialAndNormalizeDefaultModel("deepseek")).resolves.toMatchObject({
      providerId: "deepseek",
      credential: { status: "not_stored", keyHint: null, updatedAt: null },
      defaultModelReset: true,
    });
    await expect(createPreferencesRepository(db).findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: "保留提示词",
    });
    await expect(
      createProviderCredentialRepository(db).findMetadataByUserAndProvider(TEST_USER_ID, "deepseek"),
    ).resolves.toBeUndefined();
  });

  it("ambient fallback 仍可用时保留默认模型，runtime source 变为 ambient", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambient: { DEEPSEEK_API_KEY: "ambient-fallback-key" },
    });
    await service.saveCredential("deepseek", "personal-delete-key");
    await createPreferencesRepository(db).save(TEST_USER_ID, {
      defaultModel: "deepseek-v4-flash",
      systemPrompt: null,
    });

    const deleted = await service.deleteCredentialAndNormalizeDefaultModel("deepseek");
    expect(deleted.defaultModelReset).toBe(false);
    expect((await createPreferencesRepository(db).findByUserId(TEST_USER_ID)).defaultModel).toBe(
      "deepseek-v4-flash",
    );
    const deepseek = providerFrom((await service.listProviders()).providers, "deepseek");
    expect(deepseek.runtimeCredentialSource).toBe("ambient");
  });

  it("management-only 删除预灌 key 不改 runtime 默认模型", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: false, credentialManagementEnabled: true },
    });
    await service.saveCredential("deepseek", "preloaded-delete-key");
    await createPreferencesRepository(db).save(TEST_USER_ID, {
      defaultModel: "deepseek-v4-flash",
      systemPrompt: null,
    });

    const deleted = await service.deleteCredentialAndNormalizeDefaultModel("deepseek");
    expect(deleted.defaultModelReset).toBe(false);
    expect((await createPreferencesRepository(db).findByUserId(TEST_USER_ID)).defaultModel).toBe(
      "deepseek-v4-flash",
    );
  });

  it("删除从可用性判断开始就持有 mutex，后发保存不会被删除吞掉", async () => {
    const envModels = ambientModels();
    const userModels = createUserModels(db, TEST_USER_ID, { cipher, authContext: context() });
    const service = createUserProviderService(db, TEST_USER_ID, {
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambientModels: envModels,
      userModels,
      cipher,
    });
    await service.saveCredential("deepseek", "credential-before-delete");
    await createPreferencesRepository(db).save(TEST_USER_ID, {
      defaultModel: "deepseek-v4-flash",
      systemPrompt: null,
    });

    let releaseAmbientCheck!: () => void;
    const ambientCheckBlocked = new Promise<void>((resolve) => {
      releaseAmbientCheck = resolve;
    });
    let notifyAmbientCheckStarted!: () => void;
    const ambientCheckStarted = new Promise<void>((resolve) => {
      notifyAmbientCheckStarted = resolve;
    });
    vi.spyOn(envModels, "checkAuth").mockImplementation(async () => {
      notifyAmbientCheckStarted();
      await ambientCheckBlocked;
      return undefined;
    });

    const deleting = service.deleteCredentialAndNormalizeDefaultModel("deepseek");
    await ambientCheckStarted;
    const saving = service.saveCredential("deepseek", "credential-saved-after-delete");
    releaseAmbientCheck();

    await expect(Promise.all([deleting, saving])).resolves.toHaveLength(2);
    const model = userModels.getModel("deepseek", "deepseek-v4-flash");
    if (!model) throw new Error("测试缺少 DeepSeek 模型");
    expect((await userModels.getAuth(model))?.auth.apiKey).toBe("credential-saved-after-delete");
  });
});

describe("连接测试", () => {
  it("11 个 provider 都使用各自声明的探针模型与候选 key，且不落库", async () => {
    const calls: Array<{
      providerId: string;
      modelId: string;
      options: ModelsSimpleStreamOptions;
    }> = [];
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor: async (_registry, model, _probeContext, options) => {
        calls.push({ providerId: model.provider, modelId: model.id, options });
        await options.onResponse?.({ status: 200, headers: {} }, model);
        return successMessage(model.provider, model.id);
      },
    });

    for (const provider of PROVIDERS) {
      const result = await service.testCredential(provider.id, { apiKey: "candidate-key-1234" });
      expect(result).toEqual({
        ok: true,
        providerId: provider.id,
        modelId: PROVIDER_CREDENTIAL_HINTS.get(provider.id)?.probeModelId,
        source: "candidate",
      });
    }

    expect(calls).toHaveLength(11);
    for (const call of calls) {
      expect(call.options.apiKey).toBe("candidate-key-1234");
      expect(call.options.maxRetries).toBe(0);
      expect(call.options.maxRetryDelayMs).toBe(0);
      expect(call.options.maxTokens).toBe(8);
      expect(call.modelId).toBe(PROVIDER_CREDENTIAL_HINTS.get(call.providerId)?.probeModelId);
    }
    await expect(createProviderCredentialRepository(db).listMetadataByUser(TEST_USER_ID)).resolves.toEqual(
      [],
    );
  });

  it("apiKey 属性存在但为空时按候选校验失败，不 truthy 回退 ambient", async () => {
    const probeExecutor = vi.fn();
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambient: { DEEPSEEK_API_KEY: "ambient-valid-key" },
      probeExecutor,
    });

    await service
      .testCredential("deepseek", { apiKey: "" })
      .catch((error) => expectServiceError(error, "invalid_api_key"));
    expect(probeExecutor).not.toHaveBeenCalled();
  });

  it("候选缺省时 personal 优先于 ambient；无个人行时才使用 ambient", async () => {
    const seen: Array<{ providerId: string; apiKey: string | undefined; override: string | undefined }> = [];
    const probeExecutor = vi.fn(async (registry, model, _probeContext, options) => {
      const auth = await registry.getAuth(model);
      seen.push({
        providerId: model.provider,
        apiKey: auth?.auth.apiKey,
        override: options.apiKey,
      });
      return successMessage(model.provider, model.id);
    });
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambient: { DEEPSEEK_API_KEY: "ambient-valid-key", OPENAI_API_KEY: "ambient-openai-key" },
      probeExecutor,
    });
    await service.saveCredential("deepseek", "personal-valid-key");

    await expect(service.testCredential("deepseek")).resolves.toMatchObject({ source: "personal" });
    await expect(service.testCredential("openai")).resolves.toMatchObject({ source: "ambient" });
    expect(seen).toEqual([
      { providerId: "deepseek", apiKey: "personal-valid-key", override: undefined },
      { providerId: "openai", apiKey: "ambient-openai-key", override: undefined },
    ]);
  });

  it("management-only 模式可测试已预灌个人 key，但不会改变 runtime", async () => {
    const seenKeys: Array<string | undefined> = [];
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: false, credentialManagementEnabled: true },
      probeExecutor: async (registry, model) => {
        seenKeys.push((await registry.getAuth(model))?.auth.apiKey);
        return successMessage(model.provider, model.id);
      },
    });
    await service.saveCredential("deepseek", "management-only-key");

    await expect(service.testCredential("deepseek")).resolves.toMatchObject({ source: "personal" });
    expect(seenKeys).toEqual(["management-only-key"]);
    expect(providerFrom((await service.listProviders()).providers, "deepseek")).toMatchObject({
      configured: false,
      runtimeCredentialSource: "none",
    });
  });

  it("候选缺省且 personal/ambient 都没有时返回 not configured，不发起网络请求", async () => {
    const probeExecutor = vi.fn();
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor,
    });

    await service
      .testCredential("deepseek")
      .catch((error) => expectServiceError(error, "credential_not_configured"));
    expect(probeExecutor).not.toHaveBeenCalled();
  });

  it("个人 envelope 解密失败时 fail-closed，不静默改测 ambient", async () => {
    const wrongCipher = createProviderCredentialCipher(new Uint8Array(randomBytes(32)));
    await createDbCredentialStore(db, TEST_USER_ID, wrongCipher).modify("deepseek", async () => ({
      type: "api_key",
      key: "credential-encrypted-by-other-key",
    }));
    const probeExecutor = vi.fn();
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      ambient: { DEEPSEEK_API_KEY: "ambient-must-not-be-used" },
      probeExecutor,
    });

    await service
      .testCredential("deepseek")
      .catch((error) => expectServiceError(error, "credential_store_unavailable"));
    expect(probeExecutor).not.toHaveBeenCalled();
  });

  it.each([401, 403])("上游 %s 统一分类为 credential_rejected，不透传原始响应", async (status) => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor: async (_registry, model, _probeContext, options) => {
        await options.onResponse?.({ status, headers: { "x-request-id": "secret-id" } }, model);
        throw new Error("raw upstream unauthorized body");
      },
    });

    await service.testCredential("deepseek", { apiKey: "candidate-key-1234" }).catch((error) => {
      expectServiceError(error, "credential_rejected");
      expect((error as Error).message).not.toContain("raw");
      expect((error as Error).message).not.toContain("secret-id");
    });
  });

  it.each([404, 429, 500])("上游 %s 使用泛化测试失败，不误判为 key 拒绝", async (status) => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor: async (_registry, model, _probeContext, options) => {
        await options.onResponse?.({ status, headers: {} }, model);
        throw new Error("raw upstream response");
      },
    });

    await service.testCredential("deepseek", { apiKey: "candidate-key-1234" }).catch((error) => {
      expectServiceError(error, "credential_test_failed");
      expect((error as Error).message).not.toContain("raw");
    });
  });

  it("stopReason=error 判失败；本地 provider 使用服务/模型不可用分类", async () => {
    const probeExecutor = async (_registry: Models, model: Parameters<Models["completeSimple"]>[0]) =>
      successMessage(model.provider, model.id, "error");
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeExecutor,
    });

    await service
      .testCredential("deepseek", { apiKey: "candidate-key-1234" })
      .catch((error) => expectServiceError(error, "credential_test_failed"));
    await service
      .testCredential("ollama", { apiKey: "candidate-key-1234" })
      .catch((error) => expectServiceError(error, "local_service_unavailable"));
  });

  it("AbortSignal 超时映射为 credential_test_timeout", async () => {
    const { service } = createService({
      capabilities: { storedCredentialsEnabled: true, credentialManagementEnabled: true },
      probeTimeoutMs: 5,
      probeExecutor: async (_registry, _model, _probeContext, options) =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("raw abort")), {
            once: true,
          });
        }),
    });

    await service
      .testCredential("deepseek", { apiKey: "candidate-key-1234" })
      .catch((error) => expectServiceError(error, "credential_test_timeout"));
  });
});

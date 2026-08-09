import { randomBytes } from "node:crypto";
import { users } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { models as globalModels } from "./index.ts";
import { createProviderCredentialCipher } from "./provider-credential-crypto.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, PROVIDERS } from "./providers.ts";
import { __resetUserModelsCipherCache, assertAllProvidersStatic, createUserModels } from "./user-models.ts";

// HEU-54 R1 per-user Models 工厂测试。
// 关键不变式（planner Gate 6 的 Models 部分）：
// - 每个 user Models 是独立实例
// - provider/model id 集与 global Models 一致
// - A/B 用户凭据隔离
// - 同一 user Models 更新 key 后下次 checkAuth 立即用新值（无缓存）
// - 所有共享 provider 是静态的（refreshModels===undefined 门禁）

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const KEY_BYTES = new Uint8Array(randomBytes(32));
const cipher = createProviderCredentialCipher(KEY_BYTES);

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});

beforeEach(async () => {
  __resetUserModelsCipherCache();
  await reset();
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, email: "other@example.com", passwordHash: "!" })
    .onConflictDoNothing();
});

afterAll(() => close?.());

describe("createUserModels 实例独立性", () => {
  it("两次调用返回不同的 Models 实例", () => {
    const m1 = createUserModels(db, TEST_USER_ID, { cipher });
    const m2 = createUserModels(db, TEST_USER_ID, { cipher });
    expect(m1).not.toBe(m2);
  });

  it("provider id 集合与 global Models 一致", () => {
    const userModels = createUserModels(db, TEST_USER_ID, { cipher });
    const userProviderIds = userModels
      .getProviders()
      .map((p) => p.id)
      .sort();
    const globalProviderIds = globalModels
      .getProviders()
      .map((p) => p.id)
      .sort();
    expect(userProviderIds).toEqual(globalProviderIds);
  });

  it("model id 集合与 global Models 一致（按 provider）", () => {
    const userModels = createUserModels(db, TEST_USER_ID, { cipher });
    for (const provider of PROVIDERS) {
      const userModels_ = userModels
        .getModels(provider.id)
        .map((m) => m.id)
        .sort();
      const globalModels_ = globalModels
        .getModels(provider.id)
        .map((m) => m.id)
        .sort();
      expect(userModels_).toEqual(globalModels_);
    }
  });

  it("默认 provider 与默认 model 在 user Models 里可查到", () => {
    const userModels = createUserModels(db, TEST_USER_ID, { cipher });
    expect(userModels.getProvider(DEFAULT_PROVIDER_ID)).toBeDefined();
    expect(userModels.getModel(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID)).toBeDefined();
  });
});

describe("A/B 用户凭据隔离", () => {
  it("A 存了 key，A 的 Models checkAuth 通过、B 的 checkAuth 不通过", async () => {
    const { createDbCredentialStore } = await import("./db-credential-store.ts");
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await storeA.modify(DEFAULT_PROVIDER_ID, async () => ({ type: "api_key", key: "sk-A-isolated" }));

    const modelsA = createUserModels(db, TEST_USER_ID, { cipher });
    const modelsB = createUserModels(db, OTHER_USER_ID, { cipher });

    const checkA = await modelsA.checkAuth(DEFAULT_PROVIDER_ID);
    const checkB = await modelsB.checkAuth(DEFAULT_PROVIDER_ID);
    expect(checkA).toBeDefined();
    expect(checkB).toBeUndefined(); // B 没存 key，回落 env（测试无 env）→ undefined
  });

  it("A 删 key 后，A 的 Models checkAuth 不再通过（回落 env）", async () => {
    const { createDbCredentialStore } = await import("./db-credential-store.ts");
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await storeA.modify(DEFAULT_PROVIDER_ID, async () => ({ type: "api_key", key: "sk-user-A-aaaa" }));

    const modelsA1 = createUserModels(db, TEST_USER_ID, { cipher });
    expect(await modelsA1.checkAuth(DEFAULT_PROVIDER_ID)).toBeDefined();

    await storeA.delete(DEFAULT_PROVIDER_ID);
    const modelsA2 = createUserModels(db, TEST_USER_ID, { cipher });
    expect(await modelsA2.checkAuth(DEFAULT_PROVIDER_ID)).toBeUndefined();
  });
});

describe("无缓存：更新 key 后同一 Models 立即读到新值", () => {
  it("同一 user Models 实例，store 改 key 后下一次 checkAuth 用新值", async () => {
    const { createDbCredentialStore } = await import("./db-credential-store.ts");
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(DEFAULT_PROVIDER_ID, async () => ({ type: "api_key", key: "sk-version-1-aaaa" }));

    const userModels = createUserModels(db, TEST_USER_ID, { cipher });
    const model = userModels.getModel(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID);
    if (!model) throw new Error("默认模型未注册");

    const auth1 = await userModels.getAuth(model);
    expect(auth1?.auth.apiKey).toBe("sk-version-1-aaaa");

    // 改 key（不重建 Models）
    await store.modify(DEFAULT_PROVIDER_ID, async () => ({ type: "api_key", key: "sk-version-2-bbbb" }));

    const auth2 = await userModels.getAuth(model);
    expect(auth2?.auth.apiKey).toBe("sk-version-2-bbbb");
  });
});

describe("静态 provider 门禁", () => {
  it("所有共享 provider 的 refreshModels 为 undefined", () => {
    // 这条是门禁：将来若加入动态 provider，此断言失败，强制改 createUserModels
    expect(() => assertAllProvidersStatic()).not.toThrow();
    for (const provider of PROVIDERS) {
      expect(provider.refreshModels).toBeUndefined();
    }
  });
});

describe("fail-closed：DB 故障时 checkAuth 不回落 env", () => {
  it("store 抛错时 checkAuth 抛错（不返 undefined 回落 env）", async () => {
    const { createDbCredentialStore } = await import("./db-credential-store.ts");
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    // 先用正确 cipher 存一个 key
    await store.modify(DEFAULT_PROVIDER_ID, async () => ({ type: "api_key", key: "sk-original" }));

    // 用错误 cipher 构造 user Models（解密会失败）
    const wrongCipher = createProviderCredentialCipher(new Uint8Array(randomBytes(32)));
    const userModels = createUserModels(db, TEST_USER_ID, { cipher: wrongCipher });

    // checkAuth 应抛错（decrypt_failed），不返 undefined
    await expect(userModels.checkAuth(DEFAULT_PROVIDER_ID)).rejects.toThrow();
    // env 不该被当作兜底（测试环境无 DEEPSEEK_API_KEY，但即便有也不该回落）
    const authSpy = vi.fn();
    const emptyCtx = { env: async () => undefined, fileExists: async () => false };
    const userModels2 = createUserModels(db, TEST_USER_ID, { cipher: wrongCipher, authContext: emptyCtx });
    try {
      await userModels2.checkAuth(DEFAULT_PROVIDER_ID);
    } catch {
      // 预期抛错
    }
    expect(authSpy).not.toHaveBeenCalled();
  });
});

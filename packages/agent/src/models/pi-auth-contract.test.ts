import {
  type AuthContext,
  type Credential,
  type CredentialStore,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HEU-54 R1 的可行性根基：pi-ai 0.83 的自定义 CredentialStore / AuthContext 契约。
 *
 * 整个 per-user 凭据方案依赖下列行为全部成立——任意一条不成立，方案就要重来：
 * 1. createModels({ credentials, authContext }) 真的用注入的 store / ctx；
 * 2. stored credential 优先于 ambient env（pi 自己做合并，store 不读 env）；
 * 3. store.read 返回 undefined（无记录）时才回落 env；
 * 4. store.read 抛错（DB/解密失败）时不回落 env，而是冒泡成错误——fail-closed 的根基；
 * 5. auth 解析无缓存：连续两次 getAuth 会连续两次 read（改 key 后下次立即生效）；
 * 6. AgentHarness 在构造时绑定 models，没有 setModels（per-session Models 必须装配时定型）。
 *
 * 这一组是「永久合同测试」：pi 升级后若改了这些语义，这里会失败，强制重新审查设计。
 * （第 6 条在 harness.test.ts 用 @ts-expect-error 钉。）
 *
 * 不依赖本项目 R0 代码（providers.ts / models/index.ts），自建一个最小 provider，
 * 这样本测试在 R1 核心分支（不含 R0）也能跑。
 */

const PROVIDER_ID = "contract-test-provider";
const ENV_VAR = "CONTRACT_TEST_API_KEY";

/** 一个用 envApiKeyAuth 的最小 deepseek 风格 provider（openai-responses API）。 */
function contractProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: "Contract Test Provider",
    baseUrl: "https://contract.test",
    auth: { apiKey: envApiKeyAuth("Contract Test key", [ENV_VAR]) },
    models: [contractModel()],
    api: openAIResponsesApi(),
  });
}

function contractModel(): Model<"openai-responses"> {
  return {
    id: "contract-test-model",
    name: "Contract Test Model",
    api: "openai-responses",
    provider: PROVIDER_ID,
    baseUrl: "https://contract.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

/** 可观察的 CredentialStore：read/list/modify/delete 全部 spy，read 的返回值可控。 */
function spyStore(initial: Record<string, Credential> = {}): {
  store: CredentialStore;
  reads: ReturnType<typeof vi.fn>;
  lists: ReturnType<typeof vi.fn>;
  readReturn: (providerId: string) => Credential | undefined;
  setRead: (providerId: string, cred: Credential | undefined) => void;
  setReadThrow: (providerId: string, err: unknown) => void;
} {
  const data = new Map<string, Credential>(Object.entries(initial));
  const reads = vi.fn();
  const lists = vi.fn();
  const throwFor = new Map<string, unknown>();

  const store: CredentialStore = {
    read: async (providerId: string) => {
      reads(providerId);
      const err = throwFor.get(providerId);
      if (err !== undefined) throw err;
      return data.get(providerId);
    },
    list: async () => {
      lists();
      return [...data.keys()].map((providerId) => ({
        providerId,
        type: "api_key" as const,
      }));
    },
    modify: async (providerId, fn) => {
      const next = await fn(data.get(providerId));
      if (next !== undefined) data.set(providerId, next);
      return data.get(providerId);
    },
    delete: async (providerId: string) => {
      data.delete(providerId);
    },
  };

  return {
    store,
    reads,
    lists,
    readReturn: (providerId) => data.get(providerId),
    setRead: (providerId, cred) => {
      if (cred === undefined) data.delete(providerId);
      else data.set(providerId, cred);
    },
    setReadThrow: (providerId, err) => {
      throwFor.set(providerId, err);
    },
  };
}

/** 可观察的 AuthContext：env() spy，可断言「store 抛错时 env 是否被读到」。 */
function spyAuthContext(envValues: Record<string, string | undefined> = {}): {
  ctx: AuthContext;
  envCalls: ReturnType<typeof vi.fn>;
} {
  const envCalls = vi.fn();
  const ctx: AuthContext = {
    env: async (name: string) => {
      envCalls(name);
      return envValues[name];
    },
    fileExists: async () => false,
  };
  return { ctx, envCalls };
}

beforeEach(() => {
  // envApiKeyAuth 的 ctx.env 现读；测试各自 stub 自己的值
  vi.stubEnv(ENV_VAR, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createModels({ credentials, authContext }) 合同", () => {
  it("用注入的 store 与 authContext（不依赖全局 process.env 之外的副作用）", async () => {
    const { store, reads } = spyStore();
    const { ctx, envCalls } = spyAuthContext();

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());

    await models.checkAuth(PROVIDER_ID);
    expect(reads).toHaveBeenCalledWith(PROVIDER_ID);
    expect(envCalls).toHaveBeenCalledWith(ENV_VAR);
  });

  it("stored credential 优先于 ambient env", async () => {
    const storedKey = "stored-key-from-db";
    const { store } = spyStore({
      [PROVIDER_ID]: { type: "api_key", key: storedKey },
    });
    const { ctx, envCalls } = spyAuthContext({ [ENV_VAR]: "ambient-env-key" });

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());

    const check = await models.checkAuth(PROVIDER_ID);
    expect(check).toBeDefined();
    // 关键：用 store 的 key，不是 env 的。check.source 应反映 stored 来源，
    // 绝不是 ENV_VAR 名（那是 env 来源的标记）
    expect(check?.type).toBe("api_key");
    expect(check?.source).not.toBe(ENV_VAR);

    // 进一步用 getAuth 确认实际解析出的 apiKey 是 store 的那个
    const [model] = models.getModels(PROVIDER_ID);
    if (!model) throw new Error("合同测试模型未注册");
    const auth = await models.getAuth(model);
    expect(auth?.auth.apiKey).toBe(storedKey);
    // stored 命中时 env 不该被读（per-field 合并：key 已有就不读 env）
    expect(envCalls).not.toHaveBeenCalled();
  });

  it("store.read 返回 undefined（无记录）时才回落 env", async () => {
    const { store, reads } = spyStore(); // 空 store：无记录
    const { ctx, envCalls } = spyAuthContext({ [ENV_VAR]: "ambient-env-key" });

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());

    const check = await models.checkAuth(PROVIDER_ID);
    expect(reads).toHaveBeenCalledWith(PROVIDER_ID);
    expect(check).toBeDefined();
    // 回落到 env：source 是 ENV_VAR 名
    expect(check?.source).toBe(ENV_VAR);
    expect(envCalls).toHaveBeenCalledWith(ENV_VAR);

    const [model] = models.getModels(PROVIDER_ID);
    if (!model) throw new Error("合同测试模型未注册");
    const auth = await models.getAuth(model);
    expect(auth?.auth.apiKey).toBe("ambient-env-key");
  });

  it("store.read 抛错时不回落 env（fail-closed 根基）", async () => {
    const { store, setReadThrow } = spyStore();
    setReadThrow(PROVIDER_ID, new Error("simulated DB / decrypt failure"));
    const { ctx, envCalls } = spyAuthContext({ [ENV_VAR]: "ambient-env-key" });

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());

    // store 抛错必须冒泡——绝不能静默回落 env（否则 DB 故障期间会用上别人的 env key）
    await expect(models.checkAuth(PROVIDER_ID)).rejects.toThrow();
    // 核心断言：env 没被当作兜底读过
    expect(envCalls).not.toHaveBeenCalled();
  });

  it("auth 解析无缓存：连续两次 getAuth 触发两次 read，第二次读到更新后的 key", async () => {
    const { store, reads, setRead } = spyStore({
      [PROVIDER_ID]: { type: "api_key", key: "key-v1" },
    });
    const { ctx } = spyAuthContext();

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());
    const [model] = models.getModels(PROVIDER_ID);
    if (!model) throw new Error("合同测试模型未注册");

    const auth1 = await models.getAuth(model);
    expect(auth1?.auth.apiKey).toBe("key-v1");

    // 模拟「用户在另一个标签页改了 key」——store 里直接换值（不走 modify）
    setRead(PROVIDER_ID, { type: "api_key", key: "key-v2" });

    const auth2 = await models.getAuth(model);
    // 没有 setModels / 没有 evict，第二次 getAuth 直接读到新 key
    expect(auth2?.auth.apiKey).toBe("key-v2");

    // 两次 getAuth = 至少两次 read（无缓存）。这是「更新 DB key 后下一 run 用新 key」的根基
    expect(reads.mock.calls.filter((c) => c[0] === PROVIDER_ID).length).toBeGreaterThanOrEqual(2);
  });

  it("store 完全无记录也无 env 时 checkAuth 返回 undefined（未配置）", async () => {
    const { store } = spyStore();
    const { ctx } = spyAuthContext(); // env 也无值

    const models = createModels({ credentials: store, authContext: ctx });
    models.setProvider(contractProvider());

    const check = await models.checkAuth(PROVIDER_ID);
    expect(check).toBeUndefined();
  });
});

describe("CredentialStore.list 不暴露 secret（CredentialInfo 契约）", () => {
  it("list 返回 {providerId, type}，无 key/ciphertext/envelope", async () => {
    // Models 接口没有暴露 list()（那是 CredentialStore 自己的方法），
    // 这里直接测 store.list()，确认它返回的 CredentialInfo 不含 secret。
    const { store, lists } = spyStore({
      [PROVIDER_ID]: { type: "api_key", key: "super-secret-key-12345" },
    });

    const infos = await store.list();
    expect(lists).toHaveBeenCalled();
    const json = JSON.stringify(infos);
    // list 结果绝不包含明文 key
    expect(json).not.toContain("super-secret-key-12345");
    // 只含非敏感元数据
    for (const info of infos) {
      expect(Object.keys(info).sort()).toEqual(["providerId", "type"]);
    }
  });
});

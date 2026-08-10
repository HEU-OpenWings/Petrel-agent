import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, listProviderModels, listProviderStatuses } from "./index.ts";
import { PROVIDER_CREDENTIAL_HINTS } from "./providers.ts";

// 全部需要解析凭据的环境变量。测试里默认全部清空，避免开发者机器上真实 key
// 污染断言（pi-ai 的 env() 每次现读 process.env，空串视为未设置）。
// 必须与 PROVIDER_CREDENTIAL_HINTS 声明的变量保持一致——测试自己会校验这个一致性。
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

/**
 * 断言式取值：找不到就 fail，返回值已窄化为非空。
 * 遵循 account.test.ts 的约定「避免 Biome 禁止的非空断言」——用显式抛错代替 `!`。
 */
function requireFound<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`测试预期找到 ${label}，但得到 undefined`);
  return value;
}

function clearAllAuthEnvs(): void {
  for (const name of ALL_AUTH_ENV_VARS) vi.stubEnv(name, "");
}

beforeEach(() => {
  clearAllAuthEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// 一个明显的 secret 值，用于断言「它绝不出现在任何序列化结果里」。
// 用唯一可识别串，grep 友好。
function seedSecret(envVar: string): void {
  vi.stubEnv(envVar, SECRET_SENTINEL);
}

describe("PROVIDER_CREDENTIAL_HINTS 与运行时注册表一致", () => {
  // 这是最重要的护栏：side table 是无法从 Provider 反射出来的手写副本，
  // 一旦和运行时 provider 集合脱钩（新增 provider 忘了加 hint，或反过来），
  // 面板就会列错。用 hint 的 key 集合 == 运行时 getProviders() 的 id 集合钉死。
  it("hint 的 key 集合 == 运行时 provider id 集合", async () => {
    const { models } = await import("./index.ts");
    const runtimeIds = new Set(models.getProviders().map((p) => p.id));
    const hintIds = new Set(PROVIDER_CREDENTIAL_HINTS.keys());

    expect([...runtimeIds].sort()).toEqual([...hintIds].sort());
  });

  it("hint 恰好覆盖全部 11 个已知 provider", () => {
    const expected = [
      "deepseek",
      "siliconflow",
      "openai",
      "anthropic",
      "google",
      "moonshotai",
      "minimax",
      "zai",
      "qwen-token-plan",
      "ollama",
      "vllm",
    ];
    expect([...PROVIDER_CREDENTIAL_HINTS.keys()].sort()).toEqual(expected.sort());
  });

  it("每个 hint 的 envVars/note/probeModelId 都完整，探针模型属于对应 provider", async () => {
    const { models } = await import("./index.ts");
    for (const [id, hint] of PROVIDER_CREDENTIAL_HINTS) {
      expect(hint.envVars.length, `${id} 的 envVars 不应为空`).toBeGreaterThan(0);
      expect(hint.note.length, `${id} 的 note 不应为空`).toBeGreaterThan(0);
      expect(hint.probeModelId.length, `${id} 的 probeModelId 不应为空`).toBeGreaterThan(0);
      expect(
        models.getModel(id, hint.probeModelId),
        `${id} 的探针模型 ${hint.probeModelId} 必须属于其静态 catalog`,
      ).toBeDefined();
      for (const v of hint.envVars) {
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("listProviderStatuses", () => {
  it("返回 defaultProviderId / defaultModelId 与全部 provider（按注册顺序）", async () => {
    const { models } = await import("./index.ts");
    const result = await listProviderStatuses();

    expect(result.defaultProviderId).toBe(DEFAULT_PROVIDER_ID);
    expect(result.defaultModelId).toBe(DEFAULT_MODEL_ID);

    const runtimeOrder = models.getProviders().map((p) => p.id);
    expect(result.providers.map((p) => p.id)).toEqual(runtimeOrder);
  });

  it("恰好一个 provider 标 isDefault，且是默认 provider", async () => {
    const result = await listProviderStatuses();
    const defaults = result.providers.filter((p) => p.isDefault);

    expect(defaults.map((p) => p.id)).toEqual([DEFAULT_PROVIDER_ID]);
  });

  it("全部未配置时，所有 provider configured=false 且 runtimeStatus=ready", async () => {
    const result = await listProviderStatuses();

    for (const p of result.providers) {
      expect(p.configured, `${p.id} 应未配置`).toBe(false);
      expect(p.availableModelCount).toBe(0);
      expect(p.runtimeStatus).toBe("ready");
      expect(p.statusMessage).toBeNull();
    }
  });

  it("envVars / note 来自 side table（未配置也有值）", async () => {
    const result = await listProviderStatuses();
    const deepseek = result.providers.find((p) => p.id === "deepseek");

    expect(deepseek?.envVars).toEqual(["DEEPSEEK_API_KEY"]);
    expect(deepseek?.note).toContain("DeepSeek");
  });

  it("配了 DeepSeek key 后，只有它 configured=true", async () => {
    seedSecret("DEEPSEEK_API_KEY");
    const result = await listProviderStatuses();

    const deepseek = result.providers.find((p) => p.id === "deepseek");
    expect(deepseek?.configured).toBe(true);
    expect(deepseek?.availableModelCount).toBe(1); // deepseek 只注册了 1 个模型
    expect(deepseek?.runtimeStatus).toBe("ready");

    // 其他 provider 仍未配置
    const openai = result.providers.find((p) => p.id === "openai");
    expect(openai?.configured).toBe(false);
    expect(openai?.availableModelCount).toBe(0);
    expect(openai?.modelCount).toBeGreaterThan(0); // 注册了模型但未配置
  });

  // 三态的核心：解析失败（null）必须区别于「确实未配置」（false）。
  // 用 spy 让 checkAuth 抛错，模拟 pi 把 resolve() 的错包成 ModelsError("auth")。
  it("单个 provider checkAuth 抛错时：该项 configured=null + degraded，其他不受影响", async () => {
    const { models } = await import("./index.ts");
    seedSecret("DEEPSEEK_API_KEY");

    const spy = vi.spyOn(models, "checkAuth").mockImplementation(async (providerId: string) => {
      if (providerId === "openai") throw new Error("simulated auth resolution failure");
      return models.getProvider(providerId) ? { source: "STUB", type: "api_key" } : undefined;
    });

    const result = await listProviderStatuses();
    const openai = requireFound(
      result.providers.find((p) => p.id === "openai"),
      "openai",
    );
    const deepseek = requireFound(
      result.providers.find((p) => p.id === "deepseek"),
      "deepseek",
    );

    expect(openai.configured).toBeNull();
    expect(openai.availableModelCount).toBeNull();
    expect(openai.runtimeStatus).toBe("degraded");
    // 固定泛化文案，绝不放原始异常 message
    expect(openai.statusMessage).toBe("凭据状态暂时无法读取");
    expect(openai.statusMessage).not.toContain("simulated");

    // 其他 provider 不受影响
    expect(deepseek.configured).toBe(true);
    expect(deepseek.runtimeStatus).toBe("ready");

    spy.mockRestore();
  });

  // 两段 catch 的另一段：checkAuth 成功但 getAvailable 抛错 → configured 保留 true，
  // availableModelCount=null + degraded
  it("checkAuth 成功但 getAvailable 抛错时：configured=true，availableModelCount=null + degraded", async () => {
    const { models } = await import("./index.ts");
    seedSecret("DEEPSEEK_API_KEY");

    const spy = vi
      .spyOn(models, "getAvailable")
      .mockRejectedValue(new Error("simulated availability failure"));

    const result = await listProviderStatuses();
    const deepseek = requireFound(
      result.providers.find((p) => p.id === "deepseek"),
      "deepseek",
    );

    expect(deepseek.configured).toBe(true);
    expect(deepseek.availableModelCount).toBeNull();
    expect(deepseek.runtimeStatus).toBe("degraded");
    expect(deepseek.statusMessage).toBe("模型可用性暂时无法读取");

    spy.mockRestore();
  });

  // 安全：ProviderStatus 字段集合恰好是这些，没有 baseUrl/headers/auth/apiKey/cost
  it("ProviderStatus 字段集合精确，不含 pi 内部字段", async () => {
    const result = await listProviderStatuses();
    const sample = requireFound(result.providers[0], "providers[0]");
    const keys = Object.keys(sample).sort();
    expect(keys).toEqual(
      [
        "availableModelCount",
        "configured",
        "envVars",
        "id",
        "isDefault",
        "modelCount",
        "name",
        "note",
        "runtimeStatus",
        "statusMessage",
      ].sort(),
    );
  });

  // 安全：明文 key sentinel 绝不出现在序列化结果里
  it("配了 key 后，明文 key 不出现在响应 JSON 中", async () => {
    seedSecret("DEEPSEEK_API_KEY");
    const result = await listProviderStatuses();
    const json = JSON.stringify(result);

    expect(json).not.toContain(SECRET_SENTINEL);
  });
});

describe("listProviderModels", () => {
  it("未知 provider 返回 undefined（供路由层翻 404）", async () => {
    const result = await listProviderModels("does-not-exist");
    expect(result).toBeUndefined();
  });

  it("未配置 provider 仍返回目录，所有模型 available=false", async () => {
    const result = requireFound(await listProviderModels("openai"), "openai result");

    expect(result.configured).toBe(false);
    expect(result.runtimeStatus).toBe("ready");
    expect(result.models.length).toBeGreaterThan(0);
    for (const m of result.models) {
      expect(m.available).toBe(false);
    }
  });

  it("已配置 provider 的模型 available 正确", async () => {
    seedSecret("DEEPSEEK_API_KEY");
    const result = requireFound(await listProviderModels("deepseek"), "deepseek result");
    const model = requireFound(result.models[0], "deepseek models[0]");

    expect(result.configured).toBe(true);
    expect(result.models.length).toBe(1);
    expect(model.id).toBe(DEFAULT_MODEL_ID);
    expect(model.available).toBe(true);
    expect(model.isDefault).toBe(true);
  });

  it("provider 头带 isDefault，默认 provider 为 true", async () => {
    const deepseek = requireFound(await listProviderModels("deepseek"), "deepseek");
    const openai = requireFound(await listProviderModels("openai"), "openai");

    expect(deepseek.provider.isDefault).toBe(true);
    expect(openai.provider.isDefault).toBe(false);
  });

  // 回归：聚合平台代售同名模型，isDefault 必须同时判 provider+model，
  // 不能把 qwen-token-plan 下的 deepseek-v4-flash 也标默认
  it("聚合平台代售的同名模型不重复标 isDefault", async () => {
    const qwen = requireFound(await listProviderModels("qwen-token-plan"), "qwen");
    const defaults = qwen.models.filter((m) => m.isDefault);
    expect(defaults).toEqual([]);
  });

  // 安全：ProviderModelStatus 字段集合精确
  it("ProviderModelStatus 字段集合精确，不含 pi 内部字段", async () => {
    const result = requireFound(await listProviderModels("deepseek"), "deepseek result");
    const sample = requireFound(result.models[0], "deepseek models[0]");
    const keys = Object.keys(sample).sort();
    expect(keys).toEqual(["available", "id", "isDefault", "name"].sort());
  });

  // M2 回归：listProviderModels 的 checkAuth 抛错分支。configured=null（区别于 false），
  // 所有模型 available=null，固定泛化文案不含原异常 message。
  it("checkAuth 抛错时：configured=null，所有模型 available=null + degraded", async () => {
    const { models } = await import("./index.ts");
    const spy = vi.spyOn(models, "checkAuth").mockRejectedValue(new Error("simulated detail auth failure"));

    const result = requireFound(await listProviderModels("openai"), "openai result");

    expect(result.configured).toBeNull();
    expect(result.runtimeStatus).toBe("degraded");
    expect(result.statusMessage).toBe("凭据状态暂时无法读取");
    expect(result.statusMessage).not.toContain("simulated");
    expect(result.models.length).toBeGreaterThan(0);
    for (const m of result.models) expect(m.available).toBeNull();

    spy.mockRestore();
  });

  // M2 回归：checkAuth 成功但 getAvailable 抛错。configured 保留 true（已确认事实不被
  // availability 失败抹掉），availableModelCount 不确定 → 所有模型 available=null + degraded。
  it("checkAuth 成功但 getAvailable 抛错时：configured=true，模型 available=null + degraded", async () => {
    const { models } = await import("./index.ts");
    seedSecret("DEEPSEEK_API_KEY");
    const spy = vi
      .spyOn(models, "getAvailable")
      .mockRejectedValue(new Error("simulated detail availability failure"));

    const result = requireFound(await listProviderModels("deepseek"), "deepseek result");

    expect(result.configured).toBe(true);
    expect(result.runtimeStatus).toBe("degraded");
    expect(result.statusMessage).toBe("模型可用性暂时无法读取");
    expect(result.models[0]?.available).toBeNull();

    spy.mockRestore();
  });

  it("配了 key 后，明文 key 不出现在模型响应 JSON 中", async () => {
    seedSecret("DEEPSEEK_API_KEY");
    const result = await listProviderModels("deepseek");
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });
});

describe("env var 名正确性（每个声明变量真能让 checkAuth 判为已配置）", () => {
  // 防止 side table 与 pi 实际读取的变量漂移：用户按 hint 填了变量，
  // 但 pi 其实读的是另一个名字，就会永远显示未配置。这里对每个声明变量做行为校验。
  // 注意 anthropic 三个变量任一均可（依次尝试）。
  const cases: Array<{ id: string; envVar: string }> = [
    { id: "deepseek", envVar: "DEEPSEEK_API_KEY" },
    { id: "siliconflow", envVar: "SILICONFLOW_API_KEY" },
    { id: "openai", envVar: "OPENAI_API_KEY" },
    { id: "anthropic", envVar: "ANTHROPIC_AUTH_TOKEN" },
    { id: "anthropic", envVar: "ANTHROPIC_OAUTH_TOKEN" },
    { id: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    { id: "google", envVar: "GEMINI_API_KEY" },
    { id: "moonshotai", envVar: "MOONSHOT_API_KEY" },
    { id: "minimax", envVar: "MINIMAX_API_KEY" },
    { id: "zai", envVar: "ZAI_API_KEY" },
    { id: "qwen-token-plan", envVar: "QWEN_TOKEN_PLAN_API_KEY" },
    { id: "ollama", envVar: "OLLAMA_API_KEY" },
    { id: "vllm", envVar: "VLLM_API_KEY" },
  ];

  for (const { id, envVar } of cases) {
    it(`配 ${envVar} 后 ${id} configured=true`, async () => {
      seedSecret(envVar);
      const result = await listProviderStatuses();
      const provider = result.providers.find((p) => p.id === id);
      expect(provider?.configured, `${id} 配了 ${envVar} 应识别为已配置`).toBe(true);
    });
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_ID, findModel, listConfiguredModels, listModels } from "./index.ts";

describe("listModels", () => {
  it("列出所有已注册的模型", () => {
    const ids = listModels().map((model) => model.id);

    expect(ids).toContain(DEFAULT_MODEL_ID);
    expect(ids).toContain("deepseek-ai/DeepSeek-V3");
  });

  // HEU-9：补全其余 provider 后，七家内置厂商 + 两个本地推理 provider 至少各有一个模型
  it("包含全部应注册的 provider", () => {
    const providers = new Set(listModels().map((model) => model.provider));
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
    for (const provider of expected) {
      expect(providers, `缺少 provider: ${provider}`).toContain(provider);
    }
  });

  // 用 toEqual 而不是 toMatchObject：后者允许对象带额外字段，正好放过
  // 「意外多吐了 baseUrl / cost 等内部信息」这个本条要守的场景。
  // 摘要会被 HTTP 响应直接返回给前端，字段边界就是这里钉住的
  it("摘要恰好是这 5 个字段，不泄漏内部信息", () => {
    const model = listModels().find((item) => item.id === DEFAULT_MODEL_ID);

    expect(model).toEqual({
      id: DEFAULT_MODEL_ID,
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
      isDefault: true,
    });
  });

  // 前端靠这个标记显示「跟随系统默认」时到底用的哪个模型，
  // 否则偏好为 null 时输入框旁只能显示空
  it("恰好一个模型标着 isDefault，且是 DEFAULT_MODEL_ID", () => {
    const defaults = listModels().filter((model) => model.isDefault);

    expect(defaults.map((model) => model.id)).toEqual([DEFAULT_MODEL_ID]);
  });

  // 回归：聚合型平台（qwen-token-plan）会代售他厂模型，model id 与原厂重名——
  // 例如 "deepseek-v4-flash" 同时在 deepseek 官方与 qwen-token-plan 下。isDefault
  // 必须同时判 provider，否则会把两个 provider 的同名模型都标成默认。这条钉住该修法，
  // 谁将来再注册 openrouter 这类聚合 provider 时也能立刻发现。
  it("聚合平台代售的同名模型不重复标 isDefault", () => {
    const flashProviders = listModels()
      .filter((model) => model.id === DEFAULT_MODEL_ID)
      .map((model) => model.provider);
    // 同名模型确实出现在多个 provider 下（前提条件成立，否则这条回归失去意义）
    expect(flashProviders.length, "DEFAULT_MODEL_ID 应至少被聚合平台代售").toBeGreaterThan(1);
    // 但只有默认 provider 那一条标 isDefault
    const defaults = listModels().filter((model) => model.id === DEFAULT_MODEL_ID && model.isDefault);
    expect(defaults.map((model) => model.provider)).toEqual(["deepseek"]);
  });
});

describe("findModel", () => {
  it("按 id 查得到已注册的模型", () => {
    expect(findModel(DEFAULT_MODEL_ID)?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("未注册的 id 返回 undefined", () => {
    expect(findModel("gpt-does-not-exist")).toBeUndefined();
  });

  // listModels 与 findModel 必须同源，否则会出现「清单里有但查不到」的模型
  it("清单里的每一个 id 都查得到", () => {
    for (const summary of listModels()) {
      expect(findModel(summary.id)?.id).toBe(summary.id);
    }
  });
});

describe("listConfiguredModels", () => {
  // 清理本用例 stub 的 env，避免污染同进程后续用例
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 没配任何 API key 时，所有 provider 的 envApiKeyAuth 都 resolve 成 undefined，
  // 前端选择器应当是空的——而不是把一堆「选了就报错」的模型列出来
  it("未配置任何 API key 时返回空数组", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("SILICONFLOW_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("MOONSHOT_API_KEY", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", "");
    vi.stubEnv("OLLAMA_API_KEY", "");
    vi.stubEnv("VLLM_API_KEY", "");

    expect(await listConfiguredModels()).toEqual([]);
  });

  // 配了某一家之后，只有这一家出现在「已配置」清单里——这是 listConfiguredModels
  // 与 listModels 的核心差别：前者按 auth 可解析过滤，后者列全部
  it("只列出已配置 key 的 provider", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-stub");

    const configured = await listConfiguredModels();
    const providers = new Set(configured.map((model) => model.provider));

    expect(providers).toContain("openai");
    expect(providers, "未配 key 的 deepseek 不应出现").not.toContain("deepseek");
  });

  // listConfiguredModels 返回的摘要形状必须和 listModels 一致，
  // 否则前端选择器（消费前者）与校验/错误信息（消费后者）会拿到不同结构
  it("摘要形状与 listModels 一致", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-stub");

    const configured = await listConfiguredModels();
    const sample = configured[0];
    expect(sample).toBeDefined();
    // 直接断言字段集合，避免 Biome 禁止的非空断言（sample!）
    expect(sample && Object.keys(sample).sort()).toEqual(
      ["id", "isDefault", "name", "provider", "providerName"].sort(),
    );
  });
});

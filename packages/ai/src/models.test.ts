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

  // 没配任何 API key 时，所有 provider 的 getAvailable 都因 auth 不完整被过滤，
  // 前端选择器应当是空的——而不是把一堆「选了就报错」的模型列出来。
  //
  // 注意：部分 provider 还认额外的 env 变体（如 Anthropic 还认 ANTHROPIC_AUTH_TOKEN /
  // ANTHROPIC_OAUTH_TOKEN）。开发机上设了这些（用代理网关的人常见）会让这条红，且失败信息
  // 不指向根因。这里把已知的变体也一并清掉。根本解法是改注入式测试（独立 createModels 实例），
  // 但那需要把 listConfiguredModels 改成接受 models 参数，超出本 PR 范围，留作 follow-up。
  it("未配置任何 API key 时返回空数组", async () => {
    const empty = "";
    vi.stubEnv("DEEPSEEK_API_KEY", empty);
    vi.stubEnv("SILICONFLOW_API_KEY", empty);
    vi.stubEnv("OPENAI_API_KEY", empty);
    vi.stubEnv("ANTHROPIC_API_KEY", empty);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", empty);
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", empty);
    vi.stubEnv("GEMINI_API_KEY", empty);
    vi.stubEnv("MOONSHOT_API_KEY", empty);
    vi.stubEnv("MINIMAX_API_KEY", empty);
    vi.stubEnv("ZAI_API_KEY", empty);
    vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", empty);
    vi.stubEnv("OLLAMA_API_KEY", empty);
    vi.stubEnv("VLLM_API_KEY", empty);

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

  // 不变式：选择器里的每个 id，findModel 解析出的 provider 必须等于摘要里的 provider。
  // 否则会出现「用户选了 A provider 的模型，运行时 findModel 却解析到没配 key 的
  // B provider」的故障（聚合平台代售同名模型时）。这条是 findModel 重名去重的回归锁。
  it("每个已配置模型的 provider 与 findModel 解析结果一致", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-stub");

    const configured = await listConfiguredModels();
    for (const summary of configured) {
      const resolved = findModel(summary.id);
      expect(
        resolved?.provider,
        `模型 ${summary.id}：选择器显示 provider=${summary.provider}，` +
          `但 findModel 解析到 ${resolved?.provider ?? "undefined"}，二者必须一致`,
      ).toBe(summary.provider);
    }
  });

  // 重名去重的核心故障链（review 🔴#2）：只配了聚合平台 QWEN_TOKEN_PLAN_API_KEY、
  // 没配原厂 MOONSHOT_API_KEY 时，kimi-k2.6 同时挂在 moonshotai 与 qwen-token-plan 下。
  // findModel 按注册顺序解析到 moonshotai（没配 key），若 listConfiguredModels 把
  // qwen 那条也列出来，用户选中即运行报错。去重后这条不应出现。
  it("只配聚合平台 key 时，重名模型不暴露解析不到的 provider", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("MOONSHOT_API_KEY", "");
    vi.stubEnv("QWEN_TOKEN_PLAN_API_KEY", "qwen-test-stub");

    const configured = await listConfiguredModels();
    // kimi-k2.6 被聚合平台代售，findModel 解析到没配 key 的 moonshotai——
    // 去重后选择器不应出现它，否则用户选了必然运行时报错
    const kimi = configured.filter((model) => model.id === "kimi-k2.6");
    expect(kimi, "kimi-k2.6 应被去重（findModel 解析到未配置的 moonshotai）").toEqual([]);
  });
});

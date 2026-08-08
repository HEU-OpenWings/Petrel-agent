import { type AgentHarnessEvent, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, resolveModel } from "./harness.ts";
import { DEFAULT_MODEL_ID, models as globalModels } from "./models/index.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 用 pi 自带的 faux provider + 内存 session 跑真实 harness，无需模型凭据也无需数据库 */
async function fauxHarness(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({ session, models, model: faux.getModel() });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, session, events };
}

/** session 里所有 message 条目的 role 序列 */
async function storedRoles(session: Awaited<ReturnType<typeof fauxHarness>>["session"]) {
  const entries = await session.getEntries();
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: { role: string } }).message.role);
}

describe("createHarness", () => {
  it("一轮对话后 user 与 assistant 都进了 session", async () => {
    const { faux, harness, session } = await fauxHarness();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel。")])]);

    await harness.prompt("你好");

    // 落库由 harness 自己完成，没有任何事件订阅落库代码参与
    expect(await storedRoles(session)).toEqual(["user", "assistant"]);
    const entries = await session.getEntries();
    expect(JSON.stringify(entries)).toContain("你好，我是 Petrel。");
  });

  it("工具循环：toolResult 也落进 session", async () => {
    const { faux, harness, session, events } = await fauxHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_current_time", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("现在已经查到时间了。")]),
    ]);

    await harness.prompt("现在几点");

    expect(await storedRoles(session)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(events.map((e) => e.type)).toContain("tool_execution_end");
  });

  it("followUp 的消息在同一个 run 内被消化，agent_end 只发一次", async () => {
    const { faux, harness, session, events } = await fauxHarness({ tokensPerSecond: 50 });
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一轮回答")]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const running = harness.prompt("第一个问题");
    // 等第一轮真的开跑（phase 是私有的，只能靠事件判断）
    await new Promise<void>((resolve) => {
      const stop = harness.subscribe((event) => {
        if (event.type === "agent_start") {
          stop();
          resolve();
        }
      });
    });
    await harness.followUp("第二个问题");
    await running;
    await harness.waitForIdle();

    expect(await storedRoles(session)).toEqual(["user", "assistant", "user", "assistant"]);
    // 这是 SSE 能用「收到 settled 就收尾」的依据：整个 run 只发一次
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "settled")).toHaveLength(1);
  });

  it("systemPrompt 传给模型", async () => {
    const { faux, harness } = await fauxHarness();
    let seenSystem: string | undefined;
    faux.setResponses([
      (context) => {
        seenSystem = context.systemPrompt;
        return fauxAssistantMessage([fauxText("好")]);
      },
    ]);

    await harness.prompt("你好");

    expect(seenSystem).toContain("Petrel");
  });
});

/**
 * 这一组从被删除的 agent.test.ts 移植过来（createAgent 已随本轮内核替换退役）。
 * 守的是同一件事：按 id 选模型的解析优先级。
 */
describe("createHarness 的模型解析", () => {
  async function memorySession() {
    return new InMemorySessionRepo().create({ id: SESSION_ID });
  }

  it("未注册的 modelId 抛错，而不是静默用默认模型", async () => {
    const session = await memorySession();

    // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
    expect(() => createHarness({ session, modelId: "gpt-does-not-exist" })).toThrow("模型未注册");
  });

  it("modelId 传 undefined 时用系统默认模型", async () => {
    const harness = createHarness({ session: await memorySession() });

    expect(harness.getModel().id).toBe(DEFAULT_MODEL_ID);
  });

  it("modelId 命中注册表时用该模型", async () => {
    const harness = createHarness({
      session: await memorySession(),
      modelId: "deepseek-ai/DeepSeek-V3",
    });

    expect(harness.getModel().id).toBe("deepseek-ai/DeepSeek-V3");
  });

  // chat.test.ts / isolation.test.ts 的 faux provider 注入靠这条优先级：
  // 它们把 model 铺在 options 之上，此时 modelId 必须让位
  it("显式的 model 优先于 modelId", async () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);

    const harness = createHarness({
      session: await memorySession(),
      modelId: DEFAULT_MODEL_ID,
      models,
      model: faux.getModel(),
    });

    expect(harness.getModel().id).toBe(faux.getModel().id);
  });

  // harness 常驻，所以模型要能在复用实例时换掉，harness-registry 的 acquire 依赖这条
  it("setModel 能换掉已装配实例的模型", async () => {
    const harness = createHarness({ session: await memorySession() });
    expect(harness.getModel().id).toBe(DEFAULT_MODEL_ID);

    await harness.setModel(resolveModel({ modelId: "deepseek-ai/DeepSeek-V3" }));

    expect(harness.getModel().id).toBe("deepseek-ai/DeepSeek-V3");
  });
});

/**
 * HEU-54 R1 per-session Models 的约束合同。
 *
 * per-user 凭据方案依赖：AgentHarness 在构造时绑定 models，且**没有 setModels()**。
 * 因此 per-session Models 必须在 createHarness 时注入，不能在复用实例时换。
 *
 * 下方的类型断言用 @ts-expect-error 钉死 setModels 在类型层不存在：
 * 若未来 pi 新增了 setModels，这行会编译失败（"Unused @ts-expect-error"），
 * 强制重新审查「是否可以复用 Entry + setModels 简化装配」——而不是静默沿用旧设计。
 */
describe("AgentHarness 的 models 绑定合同（HEU-54 R1）", () => {
  it("models 是构造时绑定的实例（注入的 models 等于 harness.models）", async () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);

    const harness = createHarness({
      session: await new InMemorySessionRepo().create({ id: SESSION_ID }),
      models,
      model: faux.getModel(),
    });

    // harness.models 必须是构造时传入的那个实例——per-session Models 装配后跟随实例
    expect(harness.models).toBe(models);
  });

  it("setModel（单数）存在，setModels（复数）不存在", async () => {
    const harness = createHarness({ session: await new InMemorySessionRepo().create({ id: SESSION_ID }) });

    // 运行时确认：setModel（单数）是函数；setModels（复数）不是 harness 的属性
    expect(typeof harness.setModel).toBe("function");
    const anyHarness = harness as unknown as Record<string, unknown>;
    expect(anyHarness.setModels).toBeUndefined();

    // 类型层合同：下面两行访问 harness.setModels，TS 应报「Property 'setModels' does not exist」。
    // @ts-expect-error — setModels 不存在；若 pi 新增它，此注释变成未使用，typecheck 失败
    harness.setModels;
  });
});

/**
 * B7 回归：resolveModel 传了 scoped models 时不回落 global catalog。
 * per-session Models 的 harness 必须只用自己的 catalog，否则会把 global model 塞进 user harness。
 */
describe("resolveModel 的 scoped 隔离（B7）", () => {
  it("scoped 里查不到的 modelId 抛错，不回落 global findModel", () => {
    // scoped 只注册 deepseek（从 global 取 provider 对象）
    const scoped = createModels();
    const deepseekProvider = globalModels.getProvider("deepseek");
    if (!deepseekProvider) throw new Error("测试前提：global 应有 deepseek provider");
    scoped.setProvider(deepseekProvider);

    // "deepseek-ai/DeepSeek-V3" 在 global(siliconflow)有，但 scoped 没有 → 必须抛错
    expect(() => resolveModel({ modelId: "deepseek-ai/DeepSeek-V3", models: scoped })).toThrow("模型未注册");
    // 错误信息只列 scoped catalog，不泄露 global-only 的 model。
    // 注意：错误必含请求的 modelId 本身（deepseek-ai/DeepSeek-V3），但「可选值为」之后
    // 只能是 scoped catalog，不能把 global-only 的 DeepSeek-V3 列为可选。
    try {
      resolveModel({ modelId: "deepseek-ai/DeepSeek-V3", models: scoped });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const afterOptions = msg.split("可选值为")[1] ?? "";
      expect(afterOptions).toContain("deepseek-v4-flash"); // scoped 有的
      expect(afterOptions).not.toContain("deepseek-ai/DeepSeek-V3"); // global-only 不该列为可选
    }
  });

  it("scoped 有该 modelId 时正常返回（不误拒）", () => {
    const scoped = createModels();
    const deepseekProvider = globalModels.getProvider("deepseek");
    if (!deepseekProvider) throw new Error("测试前提");
    scoped.setProvider(deepseekProvider);

    const model = resolveModel({ modelId: "deepseek-v4-flash", models: scoped });
    expect(model.id).toBe("deepseek-v4-flash");
    expect(model.provider).toBe("deepseek");
  });

  it("未传 models 时仍走 global（R0 调用方向后兼容）", () => {
    const model = resolveModel({ modelId: "deepseek-ai/DeepSeek-V3" });
    expect(model.id).toBe("deepseek-ai/DeepSeek-V3");
  });
});

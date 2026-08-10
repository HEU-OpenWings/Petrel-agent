import {
  type AgentHarnessEvent,
  type AgentHarnessTool,
  InMemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, resolveModel, type ToolContext } from "./harness.ts";
import { DEFAULT_MODEL_ID } from "./models/index.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const TEST_CONTEXT = () => ({ userId: "test-user", sessionId: SESSION_ID });

/** 用 pi 自带的 faux provider + 内存 session 跑真实 harness，无需模型凭据也无需数据库 */
async function fauxHarness(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({
    session,
    models,
    model: faux.getModel(),
    toolContext: () => ({ userId: "test-user", sessionId: SESSION_ID }),
  });
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
    expect(() =>
      createHarness({ session, modelId: "gpt-does-not-exist", toolContext: TEST_CONTEXT }),
    ).toThrow("模型未注册");
  });

  it("modelId 传 undefined 时用系统默认模型", async () => {
    const harness = createHarness({ session: await memorySession(), toolContext: TEST_CONTEXT });

    expect(harness.getModel().id).toBe(DEFAULT_MODEL_ID);
  });

  it("modelId 命中注册表时用该模型", async () => {
    const harness = createHarness({
      session: await memorySession(),
      modelId: "deepseek-ai/DeepSeek-V3",
      toolContext: TEST_CONTEXT,
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
      toolContext: TEST_CONTEXT,
    });

    expect(harness.getModel().id).toBe(faux.getModel().id);
  });

  // harness 常驻，所以模型要能在复用实例时换掉，harness-registry 的 acquire 依赖这条
  it("setModel 能换掉已装配实例的模型", async () => {
    const harness = createHarness({ session: await memorySession(), toolContext: TEST_CONTEXT });
    expect(harness.getModel().id).toBe(DEFAULT_MODEL_ID);

    await harness.setModel(resolveModel({ modelId: "deepseek-ai/DeepSeek-V3" }));

    expect(harness.getModel().id).toBe("deepseek-ai/DeepSeek-V3");
  });
});

describe("工具上下文（TContext）", () => {
  /**
   * 这个用例守的是「函数形式而不是静态值」这条红线。
   *
   * 常驻 harness 下，toolContext 如果是静态对象
   *   toolContext: { userId, sessionId }
   * 它会在 new AgentHarness(...) 时被冻住，之后每次工具执行拿到的都是装配那一刻的值。
   * 而函数形式
   *   toolContext: () => ({ userId, sessionId })
   * pi 会在每次工具执行时调用它，拿到的是当前值。
   *
   * 验证方式：同一个 harness 实例，用闭包里的可变变量模拟两次不同的 userId，
   * 断言两次工具调用各自拿到当时的值。静态值会让两次都返回第一次的值。
   */
  it("函数形式每次工具执行时重新求值，不是冻住装配快照", async () => {
    let currentUserId = "user-initial";

    let capturedUserId: string | undefined;
    const echoUserId: AgentHarnessTool<ToolContext> = {
      name: "echo_user_id",
      label: "回显用户ID",
      description: "返回 context.userId，用来验证上下文是 per-call 求值",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
        capturedUserId = context.userId;
        return {
          content: [{ type: "text", text: context.userId }],
          details: { userId: context.userId },
        };
      },
    };

    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
    // 两轮 prompt，每轮 toolUse → toolResult → assistant text。
    // setResponses 一次性预排全部：prompt("echo A") 消费前两根，"echo B" 消费后两根。
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo_user_id", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("A 完成")]),
      fauxAssistantMessage([fauxToolCall("echo_user_id", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("B 完成")]),
    ]);

    const harness = createHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [echoUserId],
      // 闭包内引用可变变量：函数形式每次工具执行时重新求值
      toolContext: () => ({ userId: currentUserId, sessionId: SESSION_ID }),
    });

    // 第一次调用前切换到用户 A
    currentUserId = "user-A";
    await harness.prompt("echo A");
    expect(capturedUserId).toBe("user-A");

    // 第二次调用前切换到用户 B —— 同一个 harness 实例，同一个闭包
    currentUserId = "user-B";
    await harness.prompt("echo B");
    expect(capturedUserId).toBe("user-B");
  });
});

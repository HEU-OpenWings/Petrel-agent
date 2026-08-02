import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgent } from "@petrel/agent-core";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachPersistence, createSessionService } from "./session.ts";

let db: TestDb;
let service: ReturnType<typeof createSessionService>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  service = createSessionService(db);
});

beforeEach(() => reset());

afterAll(() => close());

describe("buildTitle", () => {
  it("短消息原样作标题", () => {
    expect(service.buildTitle("现在几点")).toBe("现在几点");
  });

  it("超过 30 字截断并加省略号", () => {
    const long = "一".repeat(40);
    const title = service.buildTitle(long);

    expect(title).toHaveLength(31);
    expect(title.endsWith("…")).toBe(true);
  });

  it("首尾空白不计入", () => {
    expect(service.buildTitle("  现在几点  ")).toBe("现在几点");
  });

  it("空消息回落到默认标题", () => {
    expect(service.buildTitle("   ")).toBe("新对话");
  });
});

describe("ensureSession", () => {
  it("首次调用建出会话并用首句作标题", async () => {
    await service.ensureSession(SESSION_ID, "帮我查一下时间");

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("帮我查一下时间");
  });

  it("再次调用不覆盖已改过的标题", async () => {
    await service.ensureSession(SESSION_ID, "第一条消息");
    await service.rename(SESSION_ID, "我改的名字");
    await service.ensureSession(SESSION_ID, "第二条消息");

    const list = await service.list();
    expect(list[0]?.title).toBe("我改的名字");
  });
});

describe("loadHistory 与 appendMessage", () => {
  it("空会话返回空历史，下一个序号是 1", async () => {
    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([]);
    expect(history.nextSeq).toBe(1);
  });

  it("按写入顺序读回消息，nextSeq 递增", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, 2, { role: "assistant", content: "你也好" });

    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toHaveLength(2);
    expect(history.nextSeq).toBe(3);
  });

  it("role 从 message 里自动取出", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "toolResult", content: [] });

    const history = await service.loadHistory(SESSION_ID);
    expect((history.messages[0] as { role: string }).role).toBe("toolResult");
  });

  it("中断的消息在 interruptedSeqs 里", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, 2, { role: "assistant", content: "半截" }, true);

    const history = await service.loadHistory(SESSION_ID);
    expect(history.interruptedSeqs).toEqual([2]);
  });
});

describe("CRUD", () => {
  it("rename 命中返回 true，不存在返回 false", async () => {
    await service.ensureSession(SESSION_ID, "会话");

    expect(await service.rename(SESSION_ID, "新名")).toBe(true);
    expect(await service.rename("22222222-2222-2222-2222-222222222222", "新名")).toBe(false);
  });

  it("remove 删掉会话及其消息", async () => {
    await service.ensureSession(SESSION_ID, "会话");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });

    expect(await service.remove(SESSION_ID)).toBe(true);
    expect(await service.list()).toHaveLength(0);
  });
});

/**
 * 用 pi 自带的 faux provider 跑真实 agent loop，不需要模型凭据也不 mock 内部。
 * 这个装配方式与 packages/agent-core/src/agent.test.ts 里的一致。
 */
function fauxAgent(fauxOptions: Parameters<typeof fauxProvider>[0] = { tokensPerSecond: 10_000 }) {
  const faux = fauxProvider(fauxOptions);
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = createAgent({ models, model: faux.getModel() });
  return { faux, agent };
}

/** faux 每块吐 4 个字符，配上低 tokensPerSecond 就能让一段回答分成多块流出来 */
const CHUNKED = { tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } };
/** 一次中断只保留前几块，所以回答要够长，才能断言「存下来的比完整回答短」 */
const LONG_ANSWER = "一".repeat(40);

/**
 * 造一个必定在流式中途被打断的 agent：收到第一块非空内容就 abort。
 * 出字快时整段会在一次 message_update 里到齐，abort 就只能打在流结束之后，
 * 所以这里必须用分块出字，中断点才稳定落在 message_end 之前。
 */
function interruptingAgent() {
  const { faux, agent } = fauxAgent(CHUNKED);
  let requested = false;

  agent.subscribe((event) => {
    if (requested || event.type !== "message_update" || event.message.role !== "assistant") return;
    if (!event.message.content.some((block) => block.type === "text" && block.text.length > 0)) {
      return;
    }
    requested = true;
    agent.abort();
  });

  return { faux, agent };
}

/** 取一条落库消息里的纯文本，用来判断存的是半截还是全文 */
function textOf(message: unknown): string {
  const content = (message as { content?: { text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("");
}

describe("attachPersistence", () => {
  it("用户消息与助手回复都会落库", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel")])]);
    attachPersistence(service, agent, SESSION_ID, 1);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // pi 的事件序列里用户消息同样走 message_end，所以订阅一处就能把两条都收下
    expect(history.messages).toHaveLength(2);
    expect((history.messages[0] as { role: string }).role).toBe("user");
    expect((history.messages[1] as { role: string }).role).toBe("assistant");
  });

  it("seq 从传入的起点连续递增", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "上一轮" });

    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    attachPersistence(service, agent, SESSION_ID, 2);

    await agent.prompt("这一轮");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 1 是上一轮已有的，2 是本轮用户消息，3 是助手回复
    expect(history.nextSeq).toBe(4);
  });

  it("落库失败不会让 agent 运行抛异常", async () => {
    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    // 不建 session，外键约束必然让每次写入都失败
    attachPersistence(service, agent, "44444444-4444-4444-4444-444444444444", 1);

    await expect(agent.prompt("你好")).resolves.toBeUndefined();
  });

  it("中断后半截助手消息落库并标记 interrupted", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = interruptingAgent();
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    attachPersistence(service, agent, SESSION_ID, 1);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 1 是用户消息，2 是被打断的半截助手消息
    expect(history.interruptedSeqs).toEqual([2]);
    expect((history.messages[1] as { role: string }).role).toBe("assistant");

    // 存的是中断瞬间已经出的那部分：非空，但短于完整回答
    const persisted = textOf(history.messages[1]);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.length).toBeLessThan(LONG_ANSWER.length);
  });

  it("中断时那条 aborted 空消息不会被额外写进去", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = interruptingAgent();
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    attachPersistence(service, agent, SESSION_ID, 1);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 只有用户消息 + 半截助手消息；aborted 的空 message_end 被跳过了
    expect(history.messages).toHaveLength(2);
    expect(history.messages.map(textOf).filter((text) => text === "")).toEqual([]);
  });

  it("正常完成的一轮不会被 agent_end 重复补写", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    // 同样分块出字，确保 partial 确实被 message_update 记下过，
    // 但这一轮不中断，agent_end 就不该拿它再补一条
    const { faux, agent } = fauxAgent(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText("一二三四")])]);
    attachPersistence(service, agent, SESSION_ID, 1);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages).toHaveLength(2);
    expect(history.interruptedSeqs).toEqual([]);
    expect(textOf(history.messages[1])).toBe("一二三四");
  });
});

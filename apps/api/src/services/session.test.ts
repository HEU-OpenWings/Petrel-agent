import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgent } from "@petrel/agent-core";
import { createMessageRepository, DEFAULT_USER_ID, DEFAULT_USERNAME, users } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { logger } from "@petrel/logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPersistence, createSessionService } from "./session.ts";

let db: TestDb;
let service: ReturnType<typeof createSessionService>;
let messageRepo: ReturnType<typeof createMessageRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  service = createSessionService(db);
  // seq 已经不由 service 暴露了，要断言它只能下探到 repository
  messageRepo = createMessageRepository(db);
});

async function seqsOf(sessionId: string): Promise<number[]> {
  return (await messageRepo.listBySession(sessionId)).map((row) => row.seq);
}

/** 拿一个真实的驱动错误对象，用来验证错误分类读的是真实形状而不是手搓的 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the query to fail");
}

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

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
  it("空会话返回空历史", async () => {
    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([]);
  });

  it("按写入顺序读回消息", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, { role: "assistant", content: "你也好" });

    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你也好" },
    ]);
  });

  it("role 从 message 里自动取出", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, { role: "toolResult", content: [] });

    const history = await service.loadHistory(SESSION_ID);
    expect((history.messages[0] as { role: string }).role).toBe("toolResult");
  });

  it("中断的消息在 interruptedSeqs 里", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, { role: "assistant", content: "半截" }, true);

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
    await service.appendMessage(SESSION_ID, { role: "user", content: "你好" });

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

/**
 * 分块由 tokenSize 决定：faux 每块吐 tokenSize * 4 个字符，
 * 所以 min/max 都取 1 就是每块 4 字，一段 40 字的回答会切成 10 块。
 * tokensPerSecond 不影响怎么切，只决定块与块之间隔多久；取 20 是为了留时间余量
 * （整段约 450ms，够 abort 从容落在中途），不是中断能成立的前提。
 */
const CHUNKED = { tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } };
/** 一次中断只保留前几块，所以回答要够长，才能断言「存下来的比完整回答短」 */
const LONG_ANSWER = "一".repeat(40);

/**
 * 造一个必定在流式中途被打断的 agent：收到第一块非空内容就 abort。
 *
 * 之所以稳定：faux 每吐一块都会先 await 再检查 signal.aborted，一旦发现已中断
 * 就立刻收尾，所以 abort() 之后最多再走到下一个块边界。只要回答被切成多块
 * （见 CHUNKED），中断点就必然落在 message_end 之前。
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
    attachPersistence(service, agent, SESSION_ID);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // pi 的事件序列里用户消息同样走 message_end，所以订阅一处就能把两条都收下
    expect(history.messages).toHaveLength(2);
    expect((history.messages[0] as { role: string }).role).toBe("user");
    expect((history.messages[1] as { role: string }).role).toBe("assistant");
  });

  it("seq 接在已有历史之后，不从 1 重来", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, { role: "user", content: "上一轮" });

    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    attachPersistence(service, agent, SESSION_ID);

    await agent.prompt("这一轮");
    await agent.waitForIdle();

    // 1 是上一轮已有的，2 是本轮用户消息，3 是助手回复
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2, 3]);
  });

  /**
   * 这一条守的是 startSeq 时代的 bug：调用方在请求开始时算出下一个序号，
   * 而上一轮的落库可能还没结束，两轮就会撞在同一个号上，后一轮整轮丢失。
   * 现在 seq 由数据库分配，两个 attachPersistence 交错跑也不该丢消息。
   */
  it("两轮交错跑（并发同一会话）时两轮都完整落库，seq 连续无洞", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const first = fauxAgent();
    first.faux.setResponses([fauxAssistantMessage([fauxText("回答 A")])]);
    attachPersistence(service, first.agent, SESSION_ID);

    const second = fauxAgent();
    second.faux.setResponses([fauxAssistantMessage([fauxText("回答 B")])]);
    attachPersistence(service, second.agent, SESSION_ID);

    await Promise.all([first.agent.prompt("并发 A"), second.agent.prompt("并发 B")]);
    await Promise.all([first.agent.waitForIdle(), second.agent.waitForIdle()]);

    const history = await service.loadHistory(SESSION_ID);
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2, 3, 4]);
    // 两轮的四条消息一条不少（顺序取决于调度，所以两边都排序后再比）
    expect(history.messages.map(textOf).sort()).toEqual(["并发 A", "并发 B", "回答 A", "回答 B"].sort());
  });

  it("落库失败不会让 agent 运行抛异常", async () => {
    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    // 不建 session，外键约束必然让每次写入都失败
    attachPersistence(service, agent, "44444444-4444-4444-4444-444444444444");

    await expect(agent.prompt("你好")).resolves.toBeUndefined();
  });

  /**
   * seq 撞车是「服务看着健康、数据却在丢」，和数据库整体挂掉必须在日志里分得开。
   *
   * 这里用真实驱动造一个 23505（重复插默认用户），而不是手搓一个假错误对象：
   * 判定读的是 drizzle 包装后的 cause.code，手搓的形状一旦和实际脱节就白测了。
   */
  it("唯一约束冲突单独打一条日志，与普通落库失败区分开", async () => {
    const uniqueViolation = await captureError(() =>
      db.insert(users).values({ id: DEFAULT_USER_ID, username: DEFAULT_USERNAME }),
    );
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});

    try {
      for (const failure of [uniqueViolation, new Error("connection terminated")]) {
        const { faux, agent } = fauxAgent();
        faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
        const broken = {
          ...service,
          appendMessage: () => Promise.reject(failure),
        };
        attachPersistence(broken, agent, SESSION_ID);
        await agent.prompt("你好");
        await agent.waitForIdle();
      }

      const logged = errors.mock.calls.map((call) => call[1]);
      expect(logged).toContain("message seq collision, message dropped");
      expect(logged).toContain("failed to persist agent message");
    } finally {
      errors.mockRestore();
    }
  });

  it("中断后半截助手消息落库并标记 interrupted", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = interruptingAgent();
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    attachPersistence(service, agent, SESSION_ID);

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

  it("中断时那条 aborted 消息不会被额外写进去", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = interruptingAgent();
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    attachPersistence(service, agent, SESSION_ID);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 只有用户消息 + 半截助手消息：message_end 那条 aborted 消息被跳过了。
    // 它的内容与 partial 相同（faux 的 aborted 消息是 partial 加个 stopReason，
    // 不是空消息），所以真落进去会是一条内容重复的助手消息
    expect(history.messages).toHaveLength(2);
    // partial 是从 message_update 抓的，stopReason 停在 "pending"；
    // 只有走漏了 message_end 那条，库里才会出现 "aborted"
    const stopReasons = history.messages.map((m) => (m as { stopReason?: string }).stopReason);
    expect(stopReasons).not.toContain("aborted");
  });

  /**
   * 模型调用失败时 pi 不抛异常也不发 error 事件，而是发一条
   * stopReason: "error" 的助手消息（见 CLAUDE.md 的硬约束 3）。
   * 这条消息 message_end 已经落库，agent_end 不能再把 partial 补写一遍。
   *
   * 这是 2026-08-03 端到端验收时发现的真 bug：SiliconFlow 返回 429，
   * 库里出现两行逐字节相同的助手消息，第二行还被标成 interrupted。
   */
  it("模型报错时只落一条助手消息，且不标 interrupted", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = fauxAgent(CHUNKED);
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 status code (no body)" }),
    ]);
    attachPersistence(service, agent, SESSION_ID);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 用户消息 + 报错的助手消息，不多不少
    expect(history.messages).toHaveLength(2);
    expect(history.interruptedSeqs).toEqual([]);
    // 报错原因要留在库里，否则恢复历史时会显示一条没有任何解释的空助手消息
    expect((history.messages[1] as { errorMessage?: string }).errorMessage).toBe("429 status code (no body)");
  });

  it("正常完成的一轮不会被 agent_end 重复补写", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    // 走同一套流式配置，确保 partial 确实被 message_update 记下过
    //（回答只有 4 字，正好一块，但 delta 照样会发出来），
    // 而这一轮不中断，agent_end 就不该拿它再补一条
    const { faux, agent } = fauxAgent(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText("一二三四")])]);
    attachPersistence(service, agent, SESSION_ID);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages).toHaveLength(2);
    expect(history.interruptedSeqs).toEqual([]);
    expect(textOf(history.messages[1])).toBe("一二三四");
  });
});

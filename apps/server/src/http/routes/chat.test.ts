import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { type CreateAgentOptions, DEFAULT_SYSTEM_PROMPT } from "@petrel/agent";
import { createMessageRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../services/session.ts";
import { app } from "../app.ts";

/**
 * state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通的顶层变量。
 * 类型标注不受影响（编译期就擦掉了）。
 */
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  /** 打开后 getDb() 直接抛，用来模拟整库不可用（连鉴权都查不出身份） */
  dbBroken: false,
  /** 打开后只有会话仓储的查询失败，鉴权用的用户查询照常，用来模拟「已登录但会话表读写不了」 */
  sessionRepoBroken: false,
  agentOptions: undefined as CreateAgentOptions | undefined,
  /** 记录路由实际传给 createAgent 的选项，用来断言 model 有没有透传 */
  seenAgentOptions: undefined as CreateAgentOptions | undefined,
}));

/**
 * 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，
 * 所以整个模块替身一次，把它换成测试库（同 routes/sessions.test.ts）。
 */
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return {
    ...actual,
    getDb: () => {
      if (state.dbBroken) {
        throw new Error("database unavailable");
      }
      // getDb 的签名只认 NodePgDatabase，断言一次把 PGlite 实例塞进去
      return state.db as unknown as ReturnType<typeof actual.getDb>;
    },
    /**
     * 故障粒度要比 getDb 更细：鉴权（createUserRepository）与会话/消息仓储走的是
     * 同一个 db，整个 getDb 抛掉就只能覆盖「身份都验不出来」那条路径，
     * prepareSession 的 catch-and-degrade 分支（已登录、但会话仓储查不动）就没人覆盖了。
     * 这里只让会话仓储失败，且失败发生在查询时而不是建仓储时——真实故障就是这个形态。
     */
    createSessionRepository: (...args: Parameters<typeof actual.createSessionRepository>) => {
      const repo = actual.createSessionRepository(...args);
      if (!state.sessionRepoBroken) return repo;
      return { ...repo, upsert: () => Promise.reject(new Error("database unavailable")) };
    },
  };
});

/**
 * chat 路由里的 createAgent() 是直接调的，测试得让它走 faux provider 而不是真实模型
 * （仓库里没有 SILICONFLOW_API_KEY）。
 *
 * 没有给生产代码开注入口子：路由要保持薄，而且那个口子只有测试会用。
 * 改成在模块边界包一层——底下调的仍是真的 createAgent，只是补上 faux 的 models/model，
 * 所以 agent loop、事件序列、attachPersistence 都是真在跑，没有 mock agent 内部。
 */
vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    createAgent: (options: CreateAgentOptions = {}) => {
      state.seenAgentOptions = options;
      return actual.createAgent({ ...options, ...state.agentOptions });
    },
  };
});

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/**
 * 分块由 tokenSize 决定：faux 每块吐 tokenSize * 4 个字符，min/max 都取 1 就是每块 4 字。
 * 中断用例要靠这个把回答切成多块，才有「流到一半」这个时刻。
 *(同 services/session.test.ts)
 */
const CHUNKED = { tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } };
const LONG_ANSWER = "一".repeat(40);

let service: ReturnType<typeof createSessionService>;
let messageRepo: ReturnType<typeof createMessageRepository>;
let faux: ReturnType<typeof fauxProvider>;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let cookie: string;

/** 注册一个用户并返回它的 cookie（同 admin.test.ts 的 registerUser） */
async function registerUser(email: string): Promise<{ cookie: string; id: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  return { cookie: (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "", id: body.user.id };
}

/** 换一套 faux provider 并让后续请求的 createAgent 用它；默认是不分块的快回答 */
function useFaux(options: Parameters<typeof fauxProvider>[0] = { tokensPerSecond: 10_000 }) {
  faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  state.agentOptions = { models, model: faux.getModel() };
}

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  // seq 不由 service 暴露，要断言它只能下探到 repository
  messageRepo = createMessageRepository(testDb.db);
});

beforeEach(async () => {
  state.dbBroken = false;
  state.sessionRepoBroken = false;
  useFaux();
  await reset();
  const user = await registerUser("a@x.io");
  cookie = user.cookie;
  service = createSessionService(state.db!, user.id);
  state.seenAgentOptions = undefined;
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

function post(body: string, init: RequestInit = {}) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body,
    ...init,
  });
}

/** 跑完一轮对话，返回读干净的 SSE 文本。流读完就意味着 handler（含落库）已结束 */
async function chatTurn(body: Record<string, unknown>) {
  const response = await post(JSON.stringify(body));
  const text = await response.text();
  return { response, text };
}

/** 把 SSE 文本还原成 (event, data) 对，用来断言协议没变 */
function parseSse(text: string): { event: string; data: unknown }[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      return { event, data: JSON.parse(data) as unknown };
    });
}

/** 取一条消息里的纯文本，pi 的 user/assistant 消息 content 都是内容块数组 */
function textOf(message: unknown): string {
  const content = (message as { content?: { text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? "").join("");
}

function roleOf(message: unknown): string {
  return (message as { role?: string }).role ?? "";
}

async function seqsOf(sessionId: string): Promise<number[]> {
  return (await messageRepo.listBySession(sessionId)).map((row) => row.seq);
}

/** 中断之后的落库发生在 HTTP 响应之外，只能轮询等它落定 */
async function waitFor(label: string, check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

/** 这一帧是不是「助手已经吐出至少一个字」 */
function hasAssistantText(event: unknown): boolean {
  const frame = event as { type?: string; message?: { role?: string; content?: { text?: string }[] } };
  if (frame.type !== "message_update" || frame.message?.role !== "assistant") return false;
  return (frame.message.content ?? []).some((block) => (block.text ?? "").length > 0);
}

/**
 * 等助手吐出第一段文本再中断，模拟用户点「停止」——
 * ChatView 的 onSendOrStop() 走的就是 useAgentStream.abort() → AbortController.abort()。
 *
 * 不能只读固定帧数就断：前几帧是 agent_start / turn_start / 用户消息，
 * 那时候断掉的半截消息是空的，「存下来的比完整回答短且非空」这个断言就没了区分力。
 */
async function abortMidStream(response: Response, controller: AbortController) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE 响应没有 body");
  const decoder = new TextDecoder();
  let buffer = "";
  let streaming = false;

  while (!streaming) {
    const { done, value } = await reader.read();
    if (done) throw new Error("流已经结束，没能在中途中断");
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    // 最后一段可能只收了一半，留到下一轮再拼
    buffer = blocks.pop() ?? "";
    streaming = parseSse(blocks.join("\n\n")).some((entry) => hasAssistantText(entry.data));
  }

  controller.abort();
  await reader.cancel().catch(() => undefined);
}

describe("POST /api/chat 请求体校验", () => {
  // 这些请求体都能让「先当成 { message: string } 用」的写法抛 TypeError，
  // 被 error 中间件兜成 500——客户端错误却报服务端错误，还白打一条 stack 日志
  it.each([
    { name: "body 是 null", body: "null" },
    { name: "body 是数组", body: "[]" },
    { name: "body 是字符串", body: '"abc"' },
    { name: "body 是数字", body: "123" },
    { name: "没有 message", body: "{}" },
    { name: "message 是 null", body: '{"message":null}' },
    { name: "message 是数字", body: '{"message":123}' },
    { name: "message 是对象", body: '{"message":{}}' },
    { name: "message 是数组", body: '{"message":[]}' },
    { name: "message 只有空白", body: '{"message":"   "}' },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "message 必须是非空字符串" },
    });
  });

  it("请求体不是 JSON 返回 400", async () => {
    const response = await post("not json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "请求体必须是 JSON" } });
  });

  it.each([
    { name: "缺 sessionId", body: { message: "你好" } },
    { name: "sessionId 不是 UUID", body: { message: "你好", sessionId: "not-a-uuid" } },
    { name: "sessionId 是数字", body: { message: "你好", sessionId: 123 } },
    { name: "sessionId 是 null", body: { message: "你好", sessionId: null } },
  ])("$name 返回 400，且不碰数据库", async ({ body }) => {
    const response = await post(JSON.stringify(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "sessionId 必须是 UUID" } });
    // 校验在 prepareSession 之前，所以既没有建会话也没有写消息
    expect(await service.list()).toEqual([]);
  });
});

describe("POST /api/chat 会话持久化", () => {
  it("一轮对话后 user 与 assistant 都落库，seq 从 1 连续", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel")])]);

    const { response } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.status).toBe(200);

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages.map(roleOf)).toEqual(["user", "assistant"]);
    expect(textOf(history.messages[0])).toBe("你好");
    expect(textOf(history.messages[1])).toBe("你好，我是 Petrel");
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2]);
    expect(history.interruptedSeqs).toEqual([]);
  });

  it("会话不存在时自动建出来，标题取首条消息前 30 字", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好的")])]);

    await chatTurn({ message: "一".repeat(40), sessionId: SESSION_ID });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(SESSION_ID);
    expect(list[0]?.title).toBe(`${"一".repeat(30)}…`);
  });

  it("第二轮把上一轮的历史回灌给模型，seq 接着往下排", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("第一轮回答")])]);
    await chatTurn({ message: "第一轮提问", sessionId: SESSION_ID });

    // 用工厂形态的响应把 provider 实际收到的上下文录下来，
    // 这样断言的是「模型真看见了历史」，而不只是库里的行数对得上
    const seen: { messages: unknown[]; sessionId?: string }[] = [];
    faux.setResponses([
      (context, options) => {
        seen.push({ messages: context.messages, sessionId: options?.sessionId });
        return fauxAssistantMessage([fauxText("第二轮回答")]);
      },
    ]);
    await chatTurn({ message: "第二轮提问", sessionId: SESSION_ID });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.map(roleOf)).toEqual(["user", "assistant", "user"]);
    expect(seen[0]?.messages.map(textOf)).toEqual(["第一轮提问", "第一轮回答", "第二轮提问"]);
    // pi 的 Agent 顶层 sessionId 会随每次请求下发给 provider（agent-loop 把 config 整个摊给 streamFn）
    expect(seen[0]?.sessionId).toBe(SESSION_ID);

    const history = await service.loadHistory(SESSION_ID);
    // 1、2 是上一轮，3、4 是这一轮：没有从 1 重来，也没有把回灌的历史重复写一遍
    expect(history.messages).toHaveLength(4);
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2, 3, 4]);
  });

  /**
   * Critical 回归之一：两个客户端（多标签页 / 多设备）同时往一个会话发消息。
   * seq 曾经由路由在请求开始时算出，两个请求会算出同一个起点，后一轮整轮被吞掉。
   */
  it("并发打同一个 sessionId，两轮都完整落库且 seq 连续无洞", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText("回答 A")]),
      fauxAssistantMessage([fauxText("回答 B")]),
    ]);

    const [first, second] = await Promise.all([
      chatTurn({ message: "并发 A", sessionId: SESSION_ID }),
      chatTurn({ message: "并发 B", sessionId: SESSION_ID }),
    ]);

    expect([first.response.status, second.response.status]).toEqual([200, 200]);

    const history = await service.loadHistory(SESSION_ID);
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2, 3, 4]);
    // 四条一条不少（落库顺序取决于调度，所以两边都排序后再比）
    expect(history.messages.map(textOf).sort()).toEqual(["并发 A", "并发 B", "回答 A", "回答 B"].sort());
  });

  /**
   * Critical 回归之二，也是真正会天天发生的那个：中断后立刻重发。
   *
   * ChatView 的 onSendOrStop() 是一键停止，useAgentStream 的 finally 让 running 立刻变 false，
   * 用户马上就能再发。但上一轮 agent_end 的半截消息落库发生在 HTTP 响应关闭之后，
   * 第二个请求这时读到的序号是过期的——第二轮曾经整轮消失。
   */
  it("中断后立刻重发，两轮消息都在，seq 连续无洞", async () => {
    useFaux(CHUNKED);
    faux.setResponses([
      fauxAssistantMessage([fauxText(LONG_ANSWER)]),
      fauxAssistantMessage([fauxText("第二次回答")]),
    ]);

    const controller = new AbortController();
    const aborted = await post(JSON.stringify({ message: "第一次提问", sessionId: SESSION_ID }), {
      signal: controller.signal,
    });
    await abortMidStream(aborted, controller);

    // 不等上一轮落库，立刻重发——这正是竞态窗口
    await chatTurn({ message: "第二次提问", sessionId: SESSION_ID });

    await waitFor("两轮消息全部落库", async () => (await seqsOf(SESSION_ID)).length === 4);

    const history = await service.loadHistory(SESSION_ID);
    expect(await seqsOf(SESSION_ID)).toEqual([1, 2, 3, 4]);
    // 第二轮的提问与回答都还在（曾经整轮丢失）
    const texts = history.messages.map(textOf);
    expect(texts).toContain("第二次提问");
    expect(texts).toContain("第二次回答");
    // 被打断的那条半截助手消息也在，且带了中断标记
    expect(history.interruptedSeqs).toHaveLength(1);
  });

  /**
   * 已知问题（I1）：中断后重发会让 transcript 的顺序与对话的逻辑顺序不一致。
   *
   * seq 反映的是「写入时刻」，而对话的逻辑顺序是「轮次」。被打断的半截助手消息
   * 在 agent_end 才落库，那时 HTTP 响应早就关了，于是它必然排到下一轮用户消息**后面**：
   * 落库顺序变成 user → user → assistant(半截) → assistant，出现两条连续的 user。
   *
   * 这不是 seq 改由数据库分配带来的退化——改之前这一轮是整个丢掉的，比顺序错更糟。
   * 但它是修好丢消息之后才浮出来的，所以这条用例把当前（错误的）行为钉住：
   * 谁改动了半截消息的落库时机，这里会立刻变红，逼着人正面处理顺序问题。
   *
   * 为什么现在不修：可行的修法是把半截消息的落库从 agent_end 提前到 message_end 里
   * 那条 aborted 消息，但这要先在**真实模型**上确认 aborted 消息的内容确实等于 partial。
   * 仓库里没有 SILICONFLOW_API_KEY，faux 的行为不能直接外推到真实 provider。
   *
   * 影响面：SiliconFlow 走 OpenAI 兼容接口，容忍连续同角色消息，所以今天不炸；
   * 但 Anthropic Messages API 严格要求 user/assistant 交替，换 provider 会直接 400。
   */
  it("【已知问题】中断后重发，半截消息排到了下一轮用户消息之后", async () => {
    useFaux(CHUNKED);
    faux.setResponses([
      fauxAssistantMessage([fauxText(LONG_ANSWER)]),
      fauxAssistantMessage([fauxText("第二次回答")]),
    ]);

    const controller = new AbortController();
    const aborted = await post(JSON.stringify({ message: "第一次提问", sessionId: SESSION_ID }), {
      signal: controller.signal,
    });
    await abortMidStream(aborted, controller);
    await chatTurn({ message: "第二次提问", sessionId: SESSION_ID });
    await waitFor("两轮消息全部落库", async () => (await seqsOf(SESSION_ID)).length === 4);

    // 落库顺序：两条 user 连在一起，半截回答被挤到了第三位
    const stored = await messageRepo.listBySession(SESSION_ID);
    expect(stored.map((row) => [row.seq, row.role, row.interrupted])).toEqual([
      [1, "user", false],
      [2, "user", false],
      [3, "assistant", true],
      [4, "assistant", false],
    ]);
    expect(stored.map((row) => textOf(row.message))).toEqual([
      "第一次提问",
      "第二次提问",
      expect.stringMatching(/^一+$/),
      "第二次回答",
    ]);

    // 而回灌给模型的就是这个顺序：第三轮开头是两条连续的 user
    const seen: string[][] = [];
    faux.setResponses([
      (context) => {
        seen.push(context.messages.map((item) => `${roleOf(item)}:${textOf(item)}`));
        return fauxAssistantMessage([fauxText("第三次回答")]);
      },
    ]);
    await chatTurn({ message: "第三次提问", sessionId: SESSION_ID });

    expect(seen[0]?.slice(0, 2)).toEqual(["user:第一次提问", "user:第二次提问"]);
  });

  /**
   * 客户端断开连接 → streamSSE 的 onAbort → agent.abort()。
   * 没有这条接线，模型会在客户端已经走了之后继续把整段生成完，白烧 token。
   */
  it("客户端中断时 agent 跟着停，落库的是半截回答", async () => {
    useFaux(CHUNKED);
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);

    const controller = new AbortController();
    const response = await post(JSON.stringify({ message: "你好", sessionId: SESSION_ID }), {
      signal: controller.signal,
    });
    await abortMidStream(response, controller);

    await waitFor("半截消息落库", async () => (await seqsOf(SESSION_ID)).length === 2);

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages.map(roleOf)).toEqual(["user", "assistant"]);
    expect(history.interruptedSeqs).toEqual([2]);
    // 存下来的是中断瞬间已经出的那部分：非空，但短于完整回答
    const persisted = textOf(history.messages[1]);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.length).toBeLessThan(LONG_ANSWER.length);
  });

  /**
   * Task 10 之前这里断言的是「数据库不可用时照常流式输出，只是这一轮不落库」——
   * 那时 chat 没有认证，prepareSession 的 try/catch 是数据库唯一会被摸到的地方。
   * 挂上 requireAuth 之后，鉴权本身也要查库（resolveUser 用 cookie 里的 sub 查用户），
   * 库不可用时连身份都验不出来，请求进不到 handler 就已经失败——这是 fail-closed，
   * 不是回归：宁可拒绝服务，也不能在验不出身份时还把请求当成已登录处理。
   */
  it("数据库不可用时鉴权本身就会失败，请求进不到 chat handler", async () => {
    state.dbBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("照常回答")])]);

    const { response, text } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.status).toBe(500);
    expect(text).not.toContain("照常回答");

    state.dbBroken = false;
    expect(await service.list()).toEqual([]);
    expect((await service.loadHistory(SESSION_ID)).messages).toEqual([]);
  });

  /**
   * 上面那条覆盖的是「身份都验不出来」，这条才是 prepareSession 的降级分支：
   * 用户已经登录（鉴权的用户查询正常），但会话仓储查不动。
   * 这时对话必须照常进行，只是这一轮不落库——能用但记不住，好过直接不能用。
   */
  it("已登录但会话仓储查库失败时照常流式输出，只是这一轮不落库", async () => {
    state.sessionRepoBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("照常回答")])]);

    const { response, text } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.status).toBe(200);
    expect(text).toContain("照常回答");

    expect(await service.list()).toEqual([]);
    expect(await seqsOf(SESSION_ID)).toEqual([]);
  });
});

describe("POST /api/chat systemPrompt", () => {
  /** 录下 provider 实际收到的 systemPrompt */
  function recordSystemPrompt() {
    const seen: (string | undefined)[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("回答")]);
      },
    ]);
    return seen;
  }

  it("合法的 systemPrompt 会传给模型", async () => {
    const seen = recordSystemPrompt();

    await chatTurn({ message: "你好", sessionId: SESSION_ID, systemPrompt: "你是测试助手" });

    expect(seen).toEqual(["你是测试助手"]);
  });

  // 断言式泛型时代这些值会被原样塞进 initialState.systemPrompt 发给模型
  it.each([
    { name: "数字", value: 123 },
    { name: "对象", value: {} },
    { name: "null", value: null },
  ])("systemPrompt 是$name 时被丢弃，回落到默认提示词", async ({ value }) => {
    const seen = recordSystemPrompt();

    await chatTurn({ message: "你好", sessionId: SESSION_ID, systemPrompt: value });

    expect(seen).toEqual([DEFAULT_SYSTEM_PROMPT]);
  });
});

describe("POST /api/chat SSE 协议", () => {
  it("仍然只发 event: agent，data 是 pi 的 AgentEvent 原文", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);

    const { response, text } = await chatTurn({ message: "你好", sessionId: SESSION_ID });

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = parseSse(text);
    expect(events.every((entry) => entry.event === "agent")).toBe(true);

    // 前端 useAgentStream.js 就是按这些 type 归约消息状态的，顺序和名字都不能变
    const types = events.map((entry) => (entry.data as { type: string }).type);
    expect(types.filter((type) => type !== "message_update")).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });
});

describe("模型选择", () => {
  it("合法的 model 透传给 createAgent", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "deepseek-ai/DeepSeek-V3",
      }),
    });
    // SSE 响应读干净才意味着 handler 已经跑完
    await response.text();

    expect(response.status).toBe(200);
    expect(state.seenAgentOptions?.modelId).toBe("deepseek-ai/DeepSeek-V3");
  });

  // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
  it("未注册的 model 返回 400，且压根不进 agent", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "gpt-does-not-exist",
      }),
    });

    expect(response.status).toBe(400);
    expect(state.seenAgentOptions).toBeUndefined();
  });

  /**
   * 守的是「兜默认值是 createAgent 的职责，路由不许注入默认模型」。
   *
   * 注意这条不由 TDD 驱动——实现之前它就是绿的（那时压根不解析 model）。
   * 它的价值在于能被有意义的变异打红：若有人把 parseChatRequest 改成
   * `model = rawModel ?? DEFAULT_MODEL_ID` 之类，这里就会拿到一个非 undefined 的
   * modelId 而变红。路由一旦自己兜默认，createAgent 里
   * 「modelId === undefined → defaultModel()」那条分支就永远走不到，
   * 将来改 @petrel/ai 的 DEFAULT_MODEL_ID 会出现「改了却不生效」的怪问题。
   * 别因为它「看起来是恒真的」就删掉。
   */
  it("不传 model 时路由不注入 modelId，默认值交给 createAgent 兜", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "你好", sessionId: SESSION_ID }),
    });
    await response.text();

    expect(state.seenAgentOptions?.modelId).toBeUndefined();
  });
});

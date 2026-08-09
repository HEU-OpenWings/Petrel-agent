import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHarness, createMemorySession, resolveModel } from "@petrel/agent";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// HarnessNotice 定义在 registry 自己这里（它是 registry 与 route 之间的契约，
// 不是 agent 包的概念），所以从本地模块导入，不是从 @petrel/agent
import { createHarnessRegistry, type HarnessNotice, HarnessRegistryError } from "./harness-registry.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000ff";

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(() => reset());

/** 可控时钟，用来测 idle 回收而不用真的等 5 分钟 */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/**
 * 用内存 session + faux provider 造 harness，避免测试触碰真实模型。
 *
 * @param chunked 打开后回答被切成小块慢慢吐，用来制造「第一轮还在跑」这个时刻
 */
function fauxFactory(chunked = false) {
  const faux = chunked
    ? fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } })
    : fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxText("答")]),
    fauxAssistantMessage([fauxText("答")]),
    fauxAssistantMessage([fauxText("答")]),
  ]);
  let created = 0;
  return {
    faux,
    get created() {
      return created;
    },
    /** 返回 { harness, session } 两者：registry 需要 session 来读 transcript，
     *  而 harness 不对外暴露它自己的 session */
    async create(sessionId: string) {
      created += 1;
      const session = await createMemorySession(sessionId);
      return { harness: createHarness({ session, models, model: faux.getModel() }), session };
    },
  };
}

describe("createHarnessRegistry", () => {
  it("同一会话第二次 acquire 复用同一个实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(second.harness).toBe(first.harness);
    expect(factory.created).toBe(1);
  });

  it("清空显式模型偏好后恢复系统默认模型", async () => {
    const registry = createHarnessRegistry({ db });
    const selected = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好", {
      modelId: "deepseek-ai/DeepSeek-V3",
    });
    expect(selected.harness.getModel().id).toBe("deepseek-ai/DeepSeek-V3");
    selected.release();

    const restored = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    expect(restored.harness.getModel().id).toBe(resolveModel({}).id);
    restored.release();
  });

  it("并发 acquire 同一个新会话时只装配一次，两者拿到同一个实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    // 同一个尚未缓存的 sessionId 被并发两次 acquire（模拟浏览器重试 / 多标签页）：
    // entries.get 判空 → findById → build() 之间都有 await 点，去重前两者都会
    // 各自 build 一个 harness，entries.set 只留下后者，前者成为孤儿实例但仍
    // 持有 session 引用继续写——这是「会话意外分叉」。去重后两次应拿到同一实例。
    const [first, second] = await Promise.all([
      registry.acquire(SESSION_ID, TEST_USER_ID, "你好"),
      registry.acquire(SESSION_ID, TEST_USER_ID, "你好"),
    ]);
    first.release();
    second.release();

    expect(second.harness).toBe(first.harness);
    expect(factory.created).toBe(1);
  });

  it("会话 id 属于别人时拒绝，且不装配实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const owned = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    owned.release();

    const rejection = registry.acquire(SESSION_ID, OTHER_USER_ID, "偷看");
    await expect(rejection).rejects.toThrow(/不存在或无权访问/);
    await expect(rejection).rejects.toBeInstanceOf(HarnessRegistryError);
    await expect(rejection).rejects.toMatchObject({ kind: "forbidden" });
    // 关键断言：越权请求不能拿到别人的活实例
    expect(factory.created).toBe(1);
  });

  it("idle 超过 TTL 后被回收，下次 acquire 重新装配", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    time.advance(1001);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(factory.created).toBe(2);
    expect(second.harness).not.toBe(first.harness);
  });

  it("还有活连接（refCount > 0）时不回收", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });

    const held = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    time.advance(10_000);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();
    held.release();

    expect(factory.created).toBe(1);
  });

  it("容量到顶且没有可淘汰的实例时抛容量错误", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      maxSessions: 1,
    });
    const sessionRepo = (await import("@petrel/database")).createSessionRepository(db);
    await sessionRepo.upsert({ id: SESSION_ID, userId: TEST_USER_ID, title: "a" });
    const second = "22222222-2222-2222-2222-222222222222";
    await sessionRepo.upsert({ id: second, userId: TEST_USER_ID, title: "b" });

    // 第一个不释放，占满容量
    await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");

    const rejection = registry.acquire(second, TEST_USER_ID, "另一个会话");
    await expect(rejection).rejects.toThrow(/容量/);
    await expect(rejection).rejects.toBeInstanceOf(HarnessRegistryError);
    await expect(rejection).rejects.toMatchObject({ kind: "capacity" });
  });

  it("并发装配不同会话时仍然守住容量上限", async () => {
    const factory = fauxFactory();
    let notifyBuildStarted: () => void = () => undefined;
    let unblockBuild: () => void = () => undefined;
    const buildStarted = new Promise<void>((resolve) => {
      notifyBuildStarted = resolve;
    });
    const buildGate = new Promise<void>((resolve) => {
      unblockBuild = resolve;
    });
    const registry = createHarnessRegistry({
      db,
      maxSessions: 1,
      createHarness: async (sessionId) => {
        notifyBuildStarted();
        await buildGate;
        return factory.create(sessionId);
      },
    });
    const second = "22222222-2222-2222-2222-222222222222";

    const firstPromise = registry.acquire(SESSION_ID, TEST_USER_ID, "第一个会话");
    await buildStarted;
    const secondPromise = registry.acquire(second, TEST_USER_ID, "第二个会话");
    try {
      await expect(secondPromise).rejects.toMatchObject({ kind: "capacity" });
    } finally {
      unblockBuild();
    }

    const first = await firstPromise;
    first.release();
    expect(registry.size()).toBe(1);
    expect(factory.created).toBe(1);
  });

  it("容量到顶但有 idle 实例时，淘汰最旧的那个", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      maxSessions: 1,
    });
    const second = "22222222-2222-2222-2222-222222222222";

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    time.advance(10);

    const other = await registry.acquire(second, TEST_USER_ID, "另一个会话");
    other.release();

    expect(factory.created).toBe(2);
    // 第一个已被淘汰，再要就是第三次装配
    const again = await registry.acquire(SESSION_ID, TEST_USER_ID, "回来了");
    again.release();
    expect(factory.created).toBe(3);
  });

  it("evict 后实例不再被复用", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    await registry.evict(SESSION_ID);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(factory.created).toBe(2);
  });

  it("运行中的后续消息进我们自己的队列，各自独立 run 消化且全部落库", async () => {
    // 慢速吐字，保证后续 send 进临界区时第一轮真的还在跑
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const prompt = vi.spyOn(handle.harness, "prompt");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    const third = handle.send("第三个问题");
    // send() 会等到这条消息自己的独立 run 真正结束才 resolve
    await Promise.all([first, second, third]);
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    expect(text).toContain("第三个问题");
    expect(prompt.mock.calls.map(([message]) => message)).toEqual(["第一个问题", "第二个问题", "第三个问题"]);
    // HEU-37：不再用 harness.followUp()（error/aborted 收尾会绕过它的抽干点），
    // 每个排队消息各占一轮 run，所以是三次 agent_end——顺序仍然保持
    expect(types.filter((type) => type === "agent_end")).toHaveLength(3);
  });

  it("首轮以 error 收尾时，排队中的第二条消息仍被回答并落库", async () => {
    const factory = fauxFactory(true);
    // 第一轮返回 stopReason: "error"，第二轮正常回答
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("答")], { stopReason: "error" }),
      fauxAssistantMessage([fauxText("答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await Promise.all([first, second]);
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    // 两轮 run：首轮 error 收尾、第二轮消化排队消息
    expect(types.filter((type) => type === "agent_end")).toHaveLength(2);
  });

  it("排队消息的 prompt 抛异常时 send 会 reject，而不是静默成功", async () => {
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const originalPrompt = handle.harness.prompt.bind(handle.harness);
    vi.spyOn(handle.harness, "prompt")
      .mockImplementationOnce((message, options) => originalPrompt(message, options))
      .mockRejectedValueOnce(new Error("transport unavailable"));

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("transport unavailable");
    handle.release();
  });

  it("abort 只停当前轮，排队中的消息照常被回答并落库", async () => {
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await registry.abort(SESSION_ID, TEST_USER_ID);
    await Promise.all([first, second]);
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    // abort 的首轮 + 排队消息的第二轮
    expect(types.filter((type) => type === "agent_end")).toHaveLength(2);
  });

  it("evict 时排队中的消息被 reject，不挂住连接（HEU-37）", async () => {
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });
    const first = handle.send("第一个问题");
    // 等首轮真正开始（避免 evict 落在 send 的装配阶段，那条路径的语义不同）
    await vi.waitFor(() => expect(types).toContain("agent_start"));
    const second = handle.send("第二个问题");
    // 预挂 handler：evict 会同步 reject 排队条目，断言要等 evict 结束后才 attach，
    // 不预挂的话这个拒绝在 attach 之前被判 unhandled
    second.catch(() => undefined);

    // evict 会 abort 正在跑的首轮（首轮 resolve），并 reject 排队中的消息
    await registry.evict(SESSION_ID);
    handle.release();

    await expect(first).resolves.toBeUndefined();
    // reject 让对应 SSE 流收到 event:error，而不是永远挂住
    await expect(second).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("abort 只对属于自己的会话生效", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    handle.release();

    const rejection = registry.abort(SESSION_ID, OTHER_USER_ID);
    await expect(rejection).rejects.toThrow(/不存在或无权访问/);
    await expect(rejection).rejects.toBeInstanceOf(HarnessRegistryError);
    await expect(rejection).rejects.toMatchObject({ kind: "forbidden" });
    // 属于自己时幂等成功，即使当前没在跑
    await expect(registry.abort(SESSION_ID, TEST_USER_ID)).resolves.toBeUndefined();
  });

  it("会话表读写失败时降级成内存会话，对话仍然能跑且不进缓存", async () => {
    const factory = fauxFactory();
    // 传一个不可用的 db：sessionRepo.upsert 会抛（db.insert 不是函数），触发降级分支
    const registry = createHarnessRegistry({
      db: {} as unknown as TestDb,
      createHarness: factory.create,
    });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    await handle.send("你好");
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).toContain("你好");
    // 降级实例不缓存，否则后面的请求会拿到一个没验过归属的实例
    expect(registry.size()).toBe(0);
  });
});

/**
 * 造一个「窗口很小、且会话已经超阈值」的实例，用来触发压缩。
 *
 * 窗口取 48000（阈值 38400）而不是更小：pi 硬编码 keepRecentTokens = 20000，
 * 阈值离它太近的话压缩几乎切不掉东西。见 spec §10.1。
 *
 * 48000 而不是最初的 40000：原来的数字让 fixture 处在「阈值 32000 < 内容 40000 =
 * 窗口 40000」这种不真实的状态——内容恰好等于窗口，压缩失败/被守卫挡住时，模型
 * 依然「成功」应答，但 usage.input(40145，含 system prompt 等固定开销) 已经比
 * 窗口大，会被 pi-ai 的静默溢出检测（case 2）正确地判定为溢出（这不是误报，是
 * fixture 本身处在不该出现的区间）。改成 48000 后是「阈值 38400 < 内容 40000 <
 * 窗口 48000」，内容真的落在阈值以上、窗口以下这个合理区间：该触发压缩的地方
 * 照常触发（40000 > 38400），压缩失败/被挡住时也不会连带被判定成真实溢出——
 * 那是 (d) 兜底该管的另一件事，不该被这两条 Task 7 测试意外撞见。
 */
function compactionFactory() {
  const faux = fauxProvider({
    tokensPerSecond: 10_000,
    models: [{ id: "faux-compaction", contextWindow: 48_000, maxTokens: 8192 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const chunk = "一".repeat(4000);
  return {
    faux,
    async create(sessionId: string) {
      const session = await createMemorySession(sessionId);
      for (let i = 0; i < 20; i++) {
        await session.appendMessage({
          role: "user",
          content: [{ type: "text", text: chunk }],
          timestamp: Date.now(),
        });
        await session.appendMessage(fauxAssistantMessage([fauxText(chunk)]));
      }
      return { harness: createHarness({ session, models, model: faux.getModel() }), session };
    },
  };
}

describe("createHarnessRegistry 的自动压缩", () => {
  it("超阈值时先压缩再 prompt，并发出 start/end 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices.map((n) => n.phase)).toEqual(["start", "end"]);
    expect(notices[1]).toMatchObject({ phase: "end", outcome: { kind: "compacted" } });
    const entries = await handle.session.buildContextEntries();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
  });

  it("低于阈值的普通请求不产生任何通知", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    const notices: HarnessNotice[] = [];

    await handle.send("你好", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices).toEqual([]);
  });

  /**
   * 这条是本设计最贵的一条不变量。压缩期间 phase === "compaction"：
   * prompt() 会抛 busy，而 followUp() 不抛却会把消息 push 进一个没人消费的队列
   * （waitForIdle 立刻返回），表现为「消息永久消失且没有任何报错」。
   * 所以第二个请求必须被挡在临界区外等压缩结束。
   */
  it("压缩期间的第二个请求排队等待，消息不丢也不抛 busy", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
  });

  it("压缩期间不被 idle 回收", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    factory.faux.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    handle.release(); // refCount 归零，只剩 compaction 标记护着
    time.advance(10_000);
    // 压缩期间 running 是 false（compact() 不发 agent_start），
    // 只看 running 的话这个实例会被 sweep 掉，而压缩还在往它的树上写
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    releaseSummary();
    await sending;
    second.release();

    expect(second.harness).toBe(handle.harness);
  });

  it("两个 send 几乎同时发起时，等待者也收到 start 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const waiterNotices: HarnessNotice[] = [];

    // 第二个 send 同步紧跟第一个：此时第一个还没进到「设置 held.compaction」那一步，
    // 所以 send() 开头那次同步读拿不到标记，必须靠临界区里的补发
    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题", {
      onNotice: (notice) => waiterNotices.push(notice),
    });
    await Promise.all([first, second]);
    handle.release();

    expect(waiterNotices.map((notice) => notice.phase)).toEqual(["start", "end"]);
  });

  it("压缩期间的新 acquire 不会改写已排队请求的 systemPrompt 与模型", async () => {
    const factory = compactionFactory();
    let summaryStarted = false;
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let seenSystem: string | undefined;
    factory.faux.setResponses([
      async () => {
        summaryStarted = true;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      (context) => {
        seenSystem = context.systemPrompt;
        return fauxAssistantMessage([fauxText("回答")]);
      },
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题", {
      systemPrompt: "第一个提示",
    });
    const sending = first.send("第一个问题");
    await new Promise<void>((resolve) => {
      const tick = () => (summaryStarted ? resolve() : setTimeout(tick, 5));
      tick();
    });

    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "第二个问题", {
      systemPrompt: "第二个提示",
      modelId: "deepseek-ai/DeepSeek-V3",
    });
    expect(first.harness.getModel().id).toBe("faux-compaction");
    releaseSummary();
    await sending;
    first.release();
    second.release();

    expect(seenSystem).toBe("第一个提示");
  });

  it("运行中 acquire 的配置会在它自己的排队 run 开始前应用", async () => {
    const factory = fauxFactory();
    let firstStarted = false;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let queuedSystemPrompt: string | undefined;
    factory.faux.setResponses([
      async () => {
        firstStarted = true;
        await firstGate;
        return fauxAssistantMessage([fauxText("第一轮回答")]);
      },
      (context) => {
        queuedSystemPrompt = context.systemPrompt;
        return fauxAssistantMessage([fauxText("第二轮回答")]);
      },
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const firstHandle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题", {
      systemPrompt: "第一个提示",
    });
    const first = firstHandle.send("第一个问题");
    await vi.waitFor(() => expect(firstStarted).toBe(true));

    const setModel = vi.spyOn(firstHandle.harness, "setModel").mockResolvedValue(undefined);
    const secondHandle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第二个问题", {
      systemPrompt: "第二个提示",
      modelId: "deepseek-ai/DeepSeek-V3",
    });
    const second = secondHandle.send("第二个问题");
    releaseFirst();
    await Promise.all([first, second]);
    firstHandle.release();
    secondHandle.release();

    expect(queuedSystemPrompt).toBe("第二个提示");
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "deepseek-ai/DeepSeek-V3" }));
  });

  it("压缩失败不阻断本轮，照常 prompt", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      // 摘要请求失败
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
      // 本轮的正常回答仍要发生
      fauxAssistantMessage([fauxText("尽管压缩失败了，这句回答还是要有")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices.at(-1)).toMatchObject({ phase: "end", outcome: { kind: "failed" } });
    // 阈值是 80%，压不成也还有余量；真超了会落到 (d)。绝不能因为压缩失败就丢用户消息
    expect(JSON.stringify(await handle.session.getEntries())).toContain("尽管压缩失败了，这句回答还是要有");
  });

  it("守卫挡住但确实超阈值时发 blocked 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    // 直接把实例的抗抖动状态推到「连续两次无效」。没有别的入口能拿到 Entry，
    // 但 send() 之后 handle 上的 harness 与 registry 里的是同一个实例，
    // 所以这里改的是同一份状态——registry 需要暴露一个只给测试用的取状态方法：
    // 见实现步骤里 __stateForTest 的说明
    const state = registry.__stateForTest(SESSION_ID);
    if (!state) throw new Error("测试前置条件不成立：实例应当已在 registry 里");
    state.ineffectiveStreak = 2;
    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    // 没有 start：onPhase 在 maybeCompact 里、三道守卫**之后**才回调，
    // 被挡住的那次压缩压根没开始，不该让前端闪一下「正在压缩」
    expect(notices).toEqual([{ phase: "blocked", reason: "ineffective" }]);
    expect(JSON.stringify(await handle.session.getEntries())).toContain("回答");
  });

  it("压缩期间 abort 后不再发起 prompt", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    factory.faux.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("不该出现的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    // pi 的 compact() 内部 signal 永远不会被 abort，所以压缩本身停不下来；
    // abort 能保证的只有「压完不再跑新一轮」
    await registry.abort(SESSION_ID, TEST_USER_ID);
    releaseSummary();
    await sending;
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).not.toContain("不该出现的回答");
  });

  /**
   * DELETE /api/sessions/:id 是「先删库、再 evict」，而 session_entries.session_id
   * 是 onDelete: "cascade"。压缩期间删会话：abort 立刻返回（压缩停不下来），
   * 摘要跑完 appendCompaction 撞外键约束，接着还会对着一个已删的会话发起 prompt。
   */
  it("压缩期间 evict 后不再发起 prompt，且 evict 本身不抛", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryCalls = 0;
    factory.faux.setResponses([
      async () => {
        summaryCalls += 1;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("不该出现的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    // send() 与 evict() 之间没有 await：send() 只是把回调挂到 held.chain（微任务，
    // 还没执行），若这里同步紧跟着调 evict()，evict() 会在压缩真正开始之前就跑完
    // entry.retired=true 那几行，届时 send() 的回调看到的是 held.compaction
    // 仍为 undefined、held.retired 已为真，直接从 retired 门禁那里退出——
    // 压缩从未开始，evict() 里「等待进行中的压缩」那条分支也从未被走到，测试对
    // 互斥逻辑形同空转。所以必须等 summaryCalls > 0（压缩已经真正调用了模型）
    // 才发起 evict()，让它撞上「compaction 正在进行」这个真实状态。
    await new Promise<void>((resolve) => {
      const tick = () => (summaryCalls > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    const evicting = registry.evict(SESSION_ID);
    // 光看「不该出现的回答」不在树里，测不出 evict() 有没有真的等 entry.compaction
    // 落定：held.retired 这道门禁本来就会独立挡住 prompt()，跟 evict() 是否 await
    // 压缩无关。真正只属于「evict() 要不要等」这条逻辑的可观察量是时序本身——
    // summaryGate 没释放之前 compaction 不可能落定，只要 evicting 在这之前就
    // resolve，就说明 evict() 没等，直接证明了 Task 8 那段 await 被跳过。
    // 只 flush 微任务不够：entry.harness.abort() 内部会经过几轮真实的定时器/IO
    // （实测跨进程调度约几毫秒），光看两次 Promise.resolve() 测不出差别——删掉
    // await entry.compaction 后 evict() 一样「暂时」还没 resolve，只是恰好也没在
    // 两次微任务内完成，而不是真的在等压缩。改成等一段明确超过那个偶然窗口、
    // 但仍然远小于 summaryGate 会被释放的时间的间隔（这里 summaryGate 由测试
    // 手动控制，不释放就永远不会 resolve，等多久都不构成竞态）。
    let evictSettled = false;
    evicting.then(() => {
      evictSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(evictSettled).toBe(false);
    releaseSummary();
    await expect(evicting).resolves.toBeUndefined();
    expect(evictSettled).toBe(true);
    await sending.catch(() => undefined);
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).not.toContain("不该出现的回答");
    expect(registry.size()).toBe(0);
  });

  /**
   * evict 之后，**排队中的那个请求**该看到什么。
   *
   * 上一条用例里发起压缩的是第一个请求，它压完从 `abortRequested || retired`
   * 分支静默返回，走不到 retired 门禁；只有排在临界区里等压缩的第二个请求才会
   * 撞上那道门禁。这是「会话被删掉时，还挂在上面的那个连接得到什么」的唯一定义，
   * 而它原先被 `.catch(() => undefined)` 吞掉——改成 resolve 或抛别的类型都不会红。
   */
  it("压缩期间 evict 后，排队中的第二个请求收到 forbidden", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryCalls = 0;
    factory.faux.setResponses([
      async () => {
        summaryCalls += 1;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("不该出现的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await new Promise<void>((resolve) => {
      const tick = () => (summaryCalls > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    const evicting = registry.evict(SESSION_ID);
    releaseSummary();

    await expect(second).rejects.toMatchObject({ kind: "forbidden" });
    await evicting;
    await first.catch(() => undefined);
    handle.release();
  });

  it("evict 之后同一会话的新请求拿到新实例", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    first.release();
    await registry.evict(SESSION_ID);

    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(second.harness).not.toBe(first.harness);
  });
});

/**
 * (d) overflow 兜底专用的会话构造。
 *
 * 与 compactionFactory() 用同一套模型/chunk，但只铺 14 组（约 28000 token）而不是
 * 20 组：compactionFactory() 的 40000 token 是特意做成「一上来就超阈值」（见其注释），
 * 这对 (d) 的测试是干扰——每次 send() 最前面都会先跑一次**非强制**的 maybeCompact()，
 * 20 组会让这次探测性检查本身就判定超阈值、发起一次真实的摘要请求，把测试特意排布
 * 给「真正那次 prompt()」的 mock 响应提前吃掉（实测：只给 2 个响应时，第 1 个被这次
 * 探测性压缩吃掉，第 2 个被 prompt() 吃掉，走到 (d) 的补救压缩时反而没响应可用，
 * 抛 `no more faux responses queued`，而不是测试想验证的 outcome）。
 * 28000 token 留在阈值（32000）之下，探测性检查会判 below-threshold 直接跳过、
 * 不发请求；但仍然高于 keepRecentTokens（20000），force:true 时真的有内容可压，
 * 不会一上来就撞 Nothing to compact。
 */
function overflowRecoveryFactory() {
  const faux = fauxProvider({
    tokensPerSecond: 10_000,
    models: [{ id: "faux-compaction", contextWindow: 40_000, maxTokens: 8192 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const chunk = "一".repeat(4000);
  return {
    faux,
    async create(sessionId: string) {
      const session = await createMemorySession(sessionId);
      for (let i = 0; i < 14; i++) {
        await session.appendMessage({
          role: "user",
          content: [{ type: "text", text: chunk }],
          timestamp: Date.now(),
        });
        await session.appendMessage(fauxAssistantMessage([fauxText(chunk)]));
      }
      return { harness: createHarness({ session, models, model: faux.getModel() }), session };
    },
  };
}

/**
 * 「registry 有没有把该传的东西传给 maybeCompact」这一层的测试。
 *
 * 上面那些用例全靠 fixture 本身已超阈值触发压缩，所以把 `pendingMessage: message`
 * 或 `summaryInstructions` 那两行删掉它们照样全绿——而 spec §7.1 把「待发消息必须
 * 算进阈值」列为一个专门修掉的洞，接线断了就等于洞回来了。
 */
describe("createHarnessRegistry 与 maybeCompact 的接线", () => {
  it("待发消息算进阈值：长消息触发压缩，同一份上下文下短消息不触发", async () => {
    // 28000 token 的会话，阈值 32000（窗口 40000 × 0.8）：只有把待发消息算进去才会超
    const withLong = overflowRecoveryFactory();
    withLong.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const longRegistry = createHarnessRegistry({ db, createHarness: withLong.create });
    const longHandle = await longRegistry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const longNotices: HarnessNotice[] = [];

    await longHandle.send("问".repeat(24_000), { onNotice: (n) => longNotices.push(n) });
    longHandle.release();

    expect(longNotices.map((n) => n.phase)).toEqual(["start", "end"]);

    // 成对的另一半：同一份 fixture 发一条短消息，必须一条通知都没有。
    // 缺了这一半，上面那条断言换成任何「总会压」的实现也能过
    const withShort = overflowRecoveryFactory();
    withShort.faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    const shortRegistry = createHarnessRegistry({ db, createHarness: withShort.create });
    const shortHandle = await shortRegistry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const shortNotices: HarnessNotice[] = [];

    await shortHandle.send("短问题", { onNotice: (n) => shortNotices.push(n) });
    shortHandle.release();

    expect(shortNotices).toEqual([]);
  });

  it("摘要请求带上「用中文」这条 customInstructions", async () => {
    const factory = compactionFactory();
    let summaryContext = "";
    factory.faux.setResponses([
      (context) => {
        summaryContext = JSON.stringify(context);
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    await handle.send("问题");
    handle.release();

    // pi 库层那份英文提示词已经够用，我们只追加这一条要求；断言它真的到了模型面前
    expect(summaryContext).toContain("用中文输出摘要");
  });

  /**
   * 总开关关掉之后端到端会怎样。registry 原先直读全局 `env.compaction`，
   * 这条路径在测试里根本构造不出来（改进程 env 会污染同一进程的其他用例），
   * 所以给 options 开了个 `compaction` 注入口。
   */
  it("总开关关掉时不压缩、不发通知，但照常回答", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([fauxAssistantMessage([fauxText("照常回答")])]);
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      compaction: { enabled: false, thresholdRatio: 0.8, absoluteCap: 120_000 },
    });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices).toEqual([]);
    // 一次摘要调用都没发生：唯一排的那个响应被本轮的回答消费掉了
    expect(factory.faux.getPendingResponseCount()).toBe(0);
    const entries = await handle.session.buildContextEntries();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
    expect(JSON.stringify(await handle.session.getEntries())).toContain("照常回答");
  });
});

describe("createHarnessRegistry 的 overflow 兜底", () => {
  const OVERFLOW = fauxAssistantMessage([fauxText("")], {
    stopReason: "error",
    errorMessage: "This model's maximum context length is 40000 tokens",
  });

  /** 跑一轮并把抛出的错误文案取回来。不用 rejects.toThrow：要对同一条文案做多次断言 */
  async function sendAndCatch(handle: { send: (m: string) => Promise<void> }, message: string) {
    try {
      await handle.send(message);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("压缩成功时文案要求重发", async () => {
    const factory = overflowRecoveryFactory();
    factory.faux.setResponses([OVERFLOW, fauxAssistantMessage([fauxText("## Goal\n摘要")])]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const text = await sendAndCatch(handle, "问题");
    handle.release();

    expect(text).toContain("已自动压缩历史，请重新发送");
  });

  it("排队 run 溢出时同样触发补救压缩，避免后续消息连锁失败", async () => {
    const factory = overflowRecoveryFactory();
    let firstStarted = false;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    factory.faux.setResponses([
      async () => {
        firstStarted = true;
        await firstGate;
        return fauxAssistantMessage([fauxText("第一轮回答")]);
      },
      OVERFLOW,
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const first = handle.send("第一个问题");
    await vi.waitFor(() => expect(firstStarted).toBe(true));
    const notices: HarnessNotice[] = [];
    const second = handle.send("第二个问题", { onNotice: (notice) => notices.push(notice) });
    releaseFirst();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/已自动压缩历史，请重新发送/);
    handle.release();

    expect(notices.at(-1)).toMatchObject({ phase: "end", outcome: { kind: "compacted" } });
    const entries = await handle.session.buildContextEntries();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
  });

  /**
   * 这条是评审抓出的死循环：压缩没成功却告诉用户「已压缩，请重发」，
   * 用户重发 → 又爆窗 → 又被告知已压缩，无限循环。
   */
  it("摘要失败时文案不出现「已自动压缩」", async () => {
    const factory = overflowRecoveryFactory();
    factory.faux.setResponses([
      OVERFLOW,
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const text = await sendAndCatch(handle, "问题");
    handle.release();

    expect(text).toContain("自动压缩失败");
    expect(text).not.toContain("已自动压缩");
  });

  /**
   * 总开关优先于 force：关掉之后 (d) 兜底也不再压。文案必须说清是被关掉了，
   * 而不是「压缩已无法再回收空间」——后者会让人以为是会话本身没救了。
   */
  it("总开关关掉时 (d) 兜底也不压，文案说明已关闭", async () => {
    const factory = overflowRecoveryFactory();
    // 只排一个响应：本轮的 prompt 撞窗口。若 force 绕过了总开关，这里会因为
    // 补救压缩找不到响应而抛 `no more faux responses queued`，测试同样会红
    factory.faux.setResponses([OVERFLOW]);
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      compaction: { enabled: false, thresholdRatio: 0.8, absoluteCap: 120_000 },
    });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const text = await sendAndCatch(handle, "问题");
    handle.release();

    expect(text).toContain("自动压缩已关闭");
    const entries = await handle.session.buildContextEntries();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(false);
  });

  /**
   * abort() 只要看到 entry.compaction 非空就置 abortRequested，而消费点只有
   * pre-prompt 那一个分支。落在补救压缩期间的置位若没人清掉，会一直挂在实例上，
   * 等用户下一次 send() 时命中——那一轮不 prompt、不报错、SSE 空流关闭，
   * 用户这条消息静默消失（CLAUDE.md 硬约束 8 点名的那类故障）。
   */
  it("补救压缩期间 abort 之后，下一条消息仍然会被处理", async () => {
    const factory = overflowRecoveryFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryCalls = 0;
    factory.faux.setResponses([
      OVERFLOW,
      async () => {
        summaryCalls += 1;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("下一轮的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const first = sendAndCatch(handle, "问题");
    // 等补救压缩真的开始，abort() 才会撞上「compaction 正在进行」这个状态；
    // 早了的话置位会落到别的分支，这条用例就测不到目标行为
    await new Promise<void>((resolve) => {
      const tick = () => (summaryCalls > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    await registry.abort(SESSION_ID, TEST_USER_ID);
    releaseSummary();
    await first;

    await handle.send("下一个问题");
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("下一个问题");
    expect(text).toContain("下一轮的回答");
  });

  /**
   * ⑦ 的补救压缩发生在 prompt() 之后，那时 chain 已经放行、running 也已复位成
   * false。若临界区不 await held.compaction，第二个请求会径直发起自己的压缩，
   * 两个 compact() 撞在一起，后者必抛 busy。
   */
  it("补救压缩期间的第二个请求不会并发发起第二次压缩", async () => {
    const factory = overflowRecoveryFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryCalls = 0;
    factory.faux.setResponses([
      OVERFLOW,
      async () => {
        summaryCalls += 1;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const first = sendAndCatch(handle, "问题");
    // 等补救压缩真的开始（第一轮的 prompt 已经返回 overflow）
    await new Promise<void>((resolve) => {
      const tick = () => (summaryCalls > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    const second = handle.send("第二个问题");
    releaseSummary();
    await Promise.all([first, second.catch(() => undefined)]);

    // 只有一次摘要请求：第二个请求等的是同一条 compaction promise，没有自己再压。
    // 但这条断言只能证明没有并发压缩，证明不了第二条消息没被丢——如果 held.compaction
    // 没赋值，第二个请求会落到 held.running 仍为 true 的 followUp 分支，followUp()
    // 本身不检查 phase 所以不报错，但排进去的消息从未被真正处理，等 rescue 结束、
    // running 复位后 waitForIdle() 发现 harness 已经 idle，直接 resolve——消息静默
    // 丢失且没有任何报错。这正是整块并发逻辑要防的头号故障，必须直接断言消息落地。
    expect(summaryCalls).toBe(1);
    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第二个问题");
    handle.release();
  });

  /**
   * 真实的死循环条件不是 nothing-to-compact（见 overflowMessage() 上方注释），
   * 是「压缩成功了，但上下文仍然超窗口」：单条消息本身就大到超过模型窗口时，
   * compact() 不会砍掉即将 prompt 的这条消息（retainedTail 恒定保留最新一轮），
   * 压完 tokensAfter 依然 > contextWindow，「已压缩请重发」只会让用户对着同一条
   * 巨型消息再爆一次窗。
   *
   * 用空会话 + 一条约 50000 token 的巨型消息构造：40000 token 的窗口下，
   * 无论怎么压缩，这一条消息自己就超了。
   */
  it("压缩后仍超窗口时提示缩短输入或换模型", async () => {
    const faux = fauxProvider({
      tokensPerSecond: 10_000,
      models: [{ id: "faux-compaction", contextWindow: 40_000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const HUGE = "一".repeat(200_000);
    faux.setResponses([OVERFLOW, fauxAssistantMessage([fauxText("## Goal\n摘要")])]);
    const registry = createHarnessRegistry({
      db,
      createHarness: async (sessionId) => {
        const session = await createMemorySession(sessionId);
        return { harness: createHarness({ session, models, model: faux.getModel() }), session };
      },
    });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, HUGE);

    const text = await sendAndCatch(handle, HUGE);
    handle.release();

    expect(text).toContain("压缩无法解决");
    expect(text).not.toContain("已自动压缩历史，请重新发送");
  });
});

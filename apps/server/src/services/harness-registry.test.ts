import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHarness, createMemorySession, resolveModel } from "@petrel/agent";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

  it("运行中的后续消息都走 followUp，在同一个 run 内被消化", async () => {
    // 慢速吐字，保证后续 send 进临界区时第一轮真的还在跑
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    const third = handle.send("第三个问题");
    // send() 现在自己会等到整轮真正结束才 resolve（followUp 分支内部等了 waitForIdle）
    await Promise.all([first, second, third]);
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    expect(text).toContain("第三个问题");
    // 这条才是真正区分 followUp 与 prompt 的断言：followUp 的消息在同一个 run 内，
    // 所以整个过程只有一次 agent_end。两条都走 prompt 的话这里会是 2
    expect(types.filter((type) => type === "agent_end")).toHaveLength(1);
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
 * 窗口取 40000（阈值 32000）而不是更小：pi 硬编码 keepRecentTokens = 20000，
 * 阈值离它太近的话压缩几乎切不掉东西。见 spec §10.1。
 */
function compactionFactory() {
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

    expect(waiterNotices.some((notice) => notice.phase === "start")).toBe(true);
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
    const evicting = registry.evict(SESSION_ID);
    releaseSummary();
    await expect(evicting).resolves.toBeUndefined();
    await sending.catch(() => undefined);
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).not.toContain("不该出现的回答");
    expect(registry.size()).toBe(0);
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

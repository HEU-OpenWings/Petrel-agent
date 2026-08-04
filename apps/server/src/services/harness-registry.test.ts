import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHarness, createMemorySession } from "@petrel/agent";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarnessRegistry } from "./harness-registry.ts";

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

  it("会话 id 属于别人时拒绝，且不装配实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const owned = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    owned.release();

    await expect(registry.acquire(SESSION_ID, OTHER_USER_ID, "偷看")).rejects.toThrow(/不存在或无权访问/);
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

    await expect(registry.acquire(second, TEST_USER_ID, "另一个会话")).rejects.toThrow(/容量/);
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

  it("运行中的第二条消息走 followUp，在同一个 run 内被消化", async () => {
    // 慢速吐字，保证第二个 send 进临界区时第一轮真的还在跑
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await Promise.all([first, second]);
    await handle.harness.waitForIdle();
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    // 这条才是真正区分 followUp 与 prompt 的断言：followUp 的消息在同一个 run 内，
    // 所以整个过程只有一次 agent_end。两条都走 prompt 的话这里会是 2
    expect(types.filter((type) => type === "agent_end")).toHaveLength(1);
  });

  it("abort 只对属于自己的会话生效", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    handle.release();

    await expect(registry.abort(SESSION_ID, OTHER_USER_ID)).rejects.toThrow(/不存在或无权访问/);
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

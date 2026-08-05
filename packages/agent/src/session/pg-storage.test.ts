import { InMemorySessionRepo, Session, type SessionStorage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, type Usage } from "@earendil-works/pi-ai";
import { createSessionRepository, createTokenUsageRepository, tokenUsage } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgSessionStorage } from "./pg-storage.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 两个被测实现：内存版是 pi 自己的参考实现，pg 版是我们要验证的 */
type Fixture = { storage: SessionStorage; session: Session };

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  await createSessionRepository(db).upsert({
    id: SESSION_ID,
    userId: TEST_USER_ID,
    title: "契约测试",
  });
});

async function memoryFixture(): Promise<Fixture> {
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  return { storage: session.getStorage(), session };
}

async function pgFixture(): Promise<Fixture> {
  // createdAt 由构造参数传入而不是查库：真实调用方（PgSessionRepo.open）
  // 打开会话时本来就要读 sessions 行，顺手带过来即可。
  // userId（HEU-40）由归属校验后的调用方传入；测试用 TEST_USER_ID。
  const storage = new PgSessionStorage(db, SESSION_ID, new Date(), TEST_USER_ID);
  return { storage, session: new Session(storage) };
}

const IMPLEMENTATIONS: Array<[string, () => Promise<Fixture>]> = [
  ["InMemorySessionRepo（pi 参考实现）", memoryFixture],
  ["PgSessionStorage", pgFixture],
];

describe.each(IMPLEMENTATIONS)("SessionStorage 契约：%s", (_name, makeFixture) => {
  it("appendMessage 后 buildContext 拿回同一条消息", async () => {
    const { session } = await makeFixture();

    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "你好" }],
      timestamp: Date.now(),
    });

    const context = await session.buildContext();
    expect(context.messages).toHaveLength(1);
    expect(JSON.stringify(context.messages)).toContain("你好");
  });

  it("多条消息按 parent 链保序", async () => {
    const { session } = await makeFixture();

    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第一条" }],
      timestamp: Date.now(),
    });
    await session.appendMessage(fauxAssistantMessage([fauxText("第二条")]));
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第三条" }],
      timestamp: Date.now(),
    });

    const context = await session.buildContext();
    const text = JSON.stringify(context.messages);
    expect(context.messages).toHaveLength(3);
    expect(text.indexOf("第一条")).toBeLessThan(text.indexOf("第二条"));
    expect(text.indexOf("第二条")).toBeLessThan(text.indexOf("第三条"));
  });

  it("getLeafId 跟着 append 前进", async () => {
    const { session, storage } = await makeFixture();
    expect(await storage.getLeafId()).toBeNull();

    const id = await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: Date.now(),
    });

    expect(await storage.getLeafId()).toBe(id);
  });

  it("compaction 条目之后，上下文只剩摘要与保留尾部", async () => {
    const { session } = await makeFixture();
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "很久以前" }],
      timestamp: Date.now(),
    });
    await session.appendMessage(fauxAssistantMessage([fauxText("旧回答")]));
    const tail = fauxAssistantMessage([fauxText("保留下来的尾部")]);

    await session.appendCompaction("这是摘要", undefined, 1234, undefined, false, undefined, [tail]);

    const context = await session.buildContext();
    const text = JSON.stringify(context.messages);
    expect(text).toContain("这是摘要");
    expect(text).toContain("保留下来的尾部");
    // 被压缩掉的历史不再进上下文
    expect(text).not.toContain("很久以前");
  });

  it("model_change 与 active_tools_change 被 buildContext 还原", async () => {
    const { session } = await makeFixture();

    await session.appendModelChange("deepseek", "deepseek-v4-flash");
    await session.appendActiveToolsChange(["get_current_time"]);

    const context = await session.buildContext();
    expect(context.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash" });
    expect(context.activeToolNames).toEqual(["get_current_time"]);
  });

  it("getEntry 取不存在的 id 返回 undefined", async () => {
    const { storage } = await makeFixture();

    expect(await storage.getEntry("aaaaaaaa-0000-0000-0000-000000000099")).toBeUndefined();
  });

  it("appendSessionName 后 getSessionName 拿到最新的名字", async () => {
    const { session, storage } = await makeFixture();
    expect(await storage.getSessionName()).toBeUndefined();

    await session.appendSessionName("第一个名字");
    await session.appendSessionName("第二个名字");

    expect(await storage.getSessionName()).toBe("第二个名字");
  });

  it("appendLabel 后 getLabel 按目标条目取回", async () => {
    const { session, storage } = await makeFixture();
    const target = await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "被标记的消息" }],
      timestamp: Date.now(),
    });

    await session.appendLabel(target, "重要");

    expect(await storage.getLabel(target)).toBe("重要");
  });

  it("getEntries 的游标能续读", async () => {
    const { session, storage } = await makeFixture();
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "一" }],
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "二" }],
      timestamp: Date.now(),
    });

    const all = await storage.getEntries();
    expect(all).toHaveLength(2);
    const rest = await storage.getEntries({ afterEntrySeq: 1, limit: 10 });
    // 第一条的序号是 1，所以续读只剩第二条
    expect(rest).toHaveLength(1);
    expect(JSON.stringify(rest)).toContain("二");
  });

  it("getSessionStats 汇总 assistant 消息、compaction、branch_summary 的 usage", async () => {
    const { session, storage } = await makeFixture();

    // fauxAssistantMessage 固定填 DEFAULT_USAGE（全 0），测不出「算错但恰好是 0」的 bug，
    // 所以手工覆盖 usage 字段。
    const assistantUsage: Usage = {
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 1, total: 33 },
    };
    const compactionUsage: Usage = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 1, output: 1.5, cacheRead: 0.3, cacheWrite: 0.2, total: 3 },
    };
    const branchSummaryUsage: Usage = {
      input: 7,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0.7, output: 0.2, cacheRead: 0.1, cacheWrite: 0, total: 1 },
    };

    // user 消息没有 usage，不应计入统计
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "问题" }],
      timestamp: Date.now(),
    });
    const assistantMessage = { ...fauxAssistantMessage([fauxText("回答")]), usage: assistantUsage };
    const target = await session.appendMessage(assistantMessage);
    await session.appendCompaction("摘要", undefined, 999, undefined, false, compactionUsage);
    await session.moveTo(target, { summary: "分支摘要", usage: branchSummaryUsage });

    const stats = await storage.getSessionStats();
    const usages = [assistantUsage, compactionUsage, branchSummaryUsage];

    // messageCount 只数 message 类型条目（user + assistant），compaction/branch_summary 不算
    expect(stats.messageCount).toBe(2);
    expect(stats.cachedTokens).toBeCloseTo(usages.reduce((sum, u) => sum + u.cacheRead, 0));
    expect(stats.uncachedTokens).toBeCloseTo(usages.reduce((sum, u) => sum + u.input + u.cacheWrite, 0));
    expect(stats.totalTokens).toBeCloseTo(
      usages.reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheWrite, 0),
    );
    expect(stats.costTotal).toBeCloseTo(usages.reduce((sum, u) => sum + u.cost.total, 0));
  });
});

// HEU-40 双写：这些用例只针对 PgSessionStorage（内存版没有 token_usage）。
// 验证 appendEntry 事务双写 session_entries + token_usage，幂等、归属、删会话不恢复额度。
describe("PgSessionStorage HEU-40 usage 双写", () => {
  const assistantUsage: Usage = {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 10,
    totalTokens: 9999, // 故意不一致：测的是「不读 usage.totalTokens」
    cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 1, total: 33 },
  };

  async function factsInDb() {
    // reset() 已清表，测试隔离靠它。这里全量读即可，不必按 userId 过滤
    //（agent 包不直接依赖 drizzle-orm 的 operator，走 @petrel/database）。
    return db.select().from(tokenUsage);
  }

  it("assistant 消息双写一条 token_usage，归属到 userId，totalTokens 由四分量相加", async () => {
    const storage = new PgSessionStorage(db, SESSION_ID, new Date(), TEST_USER_ID);
    const session = new Session(storage);

    await session.appendMessage({ role: "user", content: [{ type: "text", text: "问" }], timestamp: 0 });
    await session.appendMessage({ ...fauxAssistantMessage([fauxText("答")]), usage: assistantUsage });

    const facts = await factsInDb();
    // user 消息不计，只有 assistant 那条
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    // 可选链：fact 为 undefined 时这些断言会失败（值不匹配），测试语义不变，且过 TS 严格检查
    expect(fact?.sourceType).toBe("message");
    expect(fact?.userId).toBe(TEST_USER_ID);
    expect(fact?.sessionId).toBe(SESSION_ID);
    expect(fact?.inputTokens).toBe(100);
    expect(fact?.outputTokens).toBe(50);
    expect(fact?.totalTokens).toBe(180); // 100+50+20+10，不是 usage.totalTokens 的 9999
    expect(fact && Number(fact.costTotal)).toBe(33);
  });

  it("token_usage 的 entry_id 幂等：同一 entryId 二次插入只落一行", async () => {
    // pi 在正常流程里给每条新消息新 entryId，不会对同一 entryId 二次 appendEntry（那会撞
    // session_entries_pkey）。token_usage 的 onConflictDoNothing 防的是「用量层」的重复——
    // 比如将来补偿/回填逻辑对同一事实二次 insert。直接在 repository 层验证这条幂等。
    const usageRepo = createTokenUsageRepository(db);
    const fact = {
      entryId: "019fd1b9-0000-7000-8000-000000000001",
      userId: TEST_USER_ID,
      sessionId: SESSION_ID,
      sourceType: "message" as const,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 180,
      costTotal: "33",
    };
    await usageRepo.insertFact(fact);
    await usageRepo.insertFact(fact); // 同 entryId，应 no-op

    const facts = await factsInDb();
    expect(facts).toHaveLength(1);
  });

  it("getSessionStats 与 token_usage 聚合一致（同源口径）", async () => {
    const storage = new PgSessionStorage(db, SESSION_ID, new Date(), TEST_USER_ID);
    const session = new Session(storage);

    await session.appendMessage({ role: "user", content: [{ type: "text", text: "问" }], timestamp: 0 });
    await session.appendMessage({ ...fauxAssistantMessage([fauxText("答")]), usage: assistantUsage });

    const stats = await storage.getSessionStats();
    const facts = await factsInDb();
    const factTotal = facts.reduce((s, f) => s + f.totalTokens, 0);
    const factCost = facts.reduce((s, f) => s + Number(f.costTotal), 0);

    expect(stats.totalTokens).toBe(factTotal);
    expect(stats.costTotal).toBeCloseTo(factCost);
  });

  // 防绕过配额：删会话不应让用量事实消失（token_usage.session_id 无级联外键）。
  it("删除 session 后 token_usage 仍保留（不级联删除用量事实）", async () => {
    const storage = new PgSessionStorage(db, SESSION_ID, new Date(), TEST_USER_ID);
    const session = new Session(storage);
    await session.appendMessage({ role: "user", content: [{ type: "text", text: "问" }], timestamp: 0 });
    await session.appendMessage({ ...fauxAssistantMessage([fauxText("答")]), usage: assistantUsage });
    expect(await factsInDb()).toHaveLength(1);

    // 删整个 session 行：session_entries 会级联（它有 session_id 外键），
    // 但 token_usage 不应被级联删（session_id 无外键约束，见 schema.ts）
    await createSessionRepository(db).remove(SESSION_ID, TEST_USER_ID);

    const factsAfter = await factsInDb();
    expect(factsAfter).toHaveLength(1);
    expect(factsAfter[0]?.sessionId).toBe(SESSION_ID);
  });

  // CHECK 约束：total_tokens 必须等于四分量之和。DB 级钉死，防 issue 警告的静默归零。
  it("违反 total=四分量之和 的 fact 被 DB CHECK 约束拒绝", async () => {
    const usageRepo = createTokenUsageRepository(db);
    // totalTokens 故意写错（180 的真值应是四分量 100+50+20+10）
    const badFact = {
      entryId: "019fd1b9-0000-7000-8000-000000000002",
      userId: TEST_USER_ID,
      sessionId: SESSION_ID,
      sourceType: "message" as const,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 1, // 与四分量之和不符
      costTotal: "33",
    };
    await expect(usageRepo.insertFact(badFact)).rejects.toThrow();
    // 没有任何事实落库（事务/CHECK 拒绝）
    expect(await factsInDb()).toHaveLength(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createMemoryRepository } from "./memories.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000bb";
const EMBEDDING_DIM = 1024;

/**
 * 造一个 1024 维的稀疏向量：只有指定下标非零。
 *
 * 用它而不是随机数，是为了让相似度可以手算：两个不同下标的单位向量正交（余弦 0），
 * 同一下标的余弦是 1。断言里写死的期望值因此是可验证的，不是「跑出来是多少就写多少」。
 */
function vectorOf(weights: Record<number, number>): number[] {
  const values = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const [index, weight] of Object.entries(weights)) {
    values[Number(index)] = weight;
  }
  return values;
}

describe("createMemoryRepository", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let repo: ReturnType<typeof createMemoryRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    repo = createMemoryRepository(db);
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await testDb.reset();
    await db.insert(users).values({
      id: OTHER_USER_ID,
      email: "other@example.com",
      passwordHash: "!",
    });
  });

  it("插入后能按用户列出，且不返回 embedding", async () => {
    const created = await repo.insert(TEST_USER_ID, {
      content: "用户喜欢简洁的回答",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(created.content).toBe("用户喜欢简洁的回答");
    // 1024 个浮点数对调用方没用，返回它只会塞进 HTTP 响应和日志
    expect(created).not.toHaveProperty("embedding");
    expect(await repo.listByUserId(TEST_USER_ID)).toHaveLength(1);
  });

  it("countByUserId 只数自己的", async () => {
    await repo.insert(TEST_USER_ID, { content: "a", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });
    await repo.insert(OTHER_USER_ID, { content: "b", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });

    expect(await repo.countByUserId(TEST_USER_ID)).toBe(1);
  });

  it("按余弦相似度倒序返回", async () => {
    await repo.insert(TEST_USER_ID, {
      content: "正交",
      embedding: vectorOf({ 5: 1 }),
      sourceSessionId: null,
    });
    await repo.insert(TEST_USER_ID, {
      content: "完全一致",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });
    await repo.insert(TEST_USER_ID, {
      content: "部分相关",
      embedding: vectorOf({ 0: 0.6, 1: 0.8 }),
      sourceSessionId: null,
    });

    const hits = await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 10);

    expect(hits.map((hit) => hit.content)).toEqual(["完全一致", "部分相关", "正交"]);
    expect(hits[0]?.similarity).toBeCloseTo(1, 5);
    expect(hits[1]?.similarity).toBeCloseTo(0.6, 5);
    expect(hits[2]?.similarity).toBeCloseTo(0, 5);
  });

  it("limit 生效", async () => {
    await repo.insert(TEST_USER_ID, { content: "a", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });
    await repo.insert(TEST_USER_ID, { content: "b", embedding: vectorOf({ 1: 1 }), sourceSessionId: null });

    expect(await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 1)).toHaveLength(1);
  });

  // 这是本轮的安全核心：检索必须按 userId 收窄
  it("检索不到别人的记忆", async () => {
    await repo.insert(OTHER_USER_ID, {
      content: "别人的秘密",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 10)).toEqual([]);
    expect(await repo.listByUserId(TEST_USER_ID)).toEqual([]);
  });

  it("删不掉别人的记忆", async () => {
    const other = await repo.insert(OTHER_USER_ID, {
      content: "别人的秘密",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.deleteById(TEST_USER_ID, other.id)).toBe(false);
    expect(await repo.listByUserId(OTHER_USER_ID)).toHaveLength(1);
  });

  it("删自己的记忆返回 true", async () => {
    const mine = await repo.insert(TEST_USER_ID, {
      content: "我的记忆",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.deleteById(TEST_USER_ID, mine.id)).toBe(true);
    expect(await repo.listByUserId(TEST_USER_ID)).toEqual([]);
  });
});

import { createMemoryRepository, MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError, MemoryQuotaError } from "./errors.ts";
import { searchMemories } from "./search.ts";
import { writeMemory } from "./write.ts";

const state = vi.hoisted(() => ({ apiKey: "test-key", maxPerUser: 200 }));

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        baseUrl: "https://embedding.test/v1",
        model: "BAAI/bge-m3",
        timeoutMs: 10_000,
        get apiKey() {
          return state.apiKey;
        },
      },
      memory: {
        searchLimit: 5,
        get maxPerUser() {
          return state.maxPerUser;
        },
      },
    },
  };
});

function vectorOf(value: number): number[] {
  return new Array<number>(MEMORY_EMBEDDING_DIM).fill(value);
}

/** 每次调用返回同一个向量。返回 fn 便于断言调用次数 */
function stubEmbedding(value: number) {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(value) }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("writeMemory / searchMemories", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
  });
  afterAll(() => testDb.close());
  beforeEach(() => {
    state.apiKey = "test-key";
    state.maxPerUser = 200;
    return testDb.reset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("写入落库，内容与来源会话都存下来", async () => {
    stubEmbedding(0.1);

    const created = await writeMemory(db, {
      userId: TEST_USER_ID,
      sessionId: null,
      content: "用户偏好简洁的回答",
    });

    expect(created.content).toBe("用户偏好简洁的回答");
    expect(await createMemoryRepository(db).countByUserId(TEST_USER_ID)).toBe(1);
  });

  // 先查数再 embed：超限时不该先花一次 embedding 的钱
  it("条数达上限时抛 MemoryQuotaError，且没有发起 embedding 请求", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "第一条" });

    state.maxPerUser = 1;
    const fetchSpy = stubEmbedding(0.1);

    await expect(
      writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "第二条" }),
    ).rejects.toThrow(MemoryQuotaError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 落一条没有向量的记忆等于写了个查不到的东西——静默失效
  it("embedding 失败时不落库", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(
      writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "写不进去的" }),
    ).rejects.toThrow(EmbeddingError);
    expect(await createMemoryRepository(db).countByUserId(TEST_USER_ID)).toBe(0);
  });

  it("空白内容不写库", async () => {
    const fetchSpy = stubEmbedding(0.1);

    await expect(
      writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "   " }),
    ).rejects.toThrow(/内容不能为空/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("检索命中自己写入的记忆", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, {
      userId: TEST_USER_ID,
      sessionId: null,
      content: "用户在做 Petrel 项目",
    });

    stubEmbedding(0.1);
    const hits = await searchMemories(db, { userId: TEST_USER_ID, query: "他在做什么项目" });

    expect(hits.map((hit) => hit.content)).toEqual(["用户在做 Petrel 项目"]);
  });

  it("检索用的是配置里的默认条数上限", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "一" });
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "二" });

    stubEmbedding(0.1);
    expect(await searchMemories(db, { userId: TEST_USER_ID, query: "q", limit: 1 })).toHaveLength(1);
  });
});

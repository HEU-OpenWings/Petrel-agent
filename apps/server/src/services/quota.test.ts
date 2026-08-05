import { createSessionRepository, createTokenUsageRepository, type Database } from "@petrel/database";
import { createTestDb, TEST_USER_EMAIL, TEST_USER_ID } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** catch 到的错误形状：QuotaError 实例（dynamic import 下只有值语义，用结构类型断言） */
type QuotaErrorInstance = {
  name: "QuotaError";
  kind: "exceeded" | "unavailable";
  retryAfterSeconds?: number;
};

/**
 * quota service 直接消费 env.quotaEnforcement / quotaTokenLimit。env 在模块加载时固化，
 * vi.stubEnv 改不了已导入的 env。这里 mock @petrel/config，只覆盖 quota 三项（用 getter 动态读
 * state），其余透传真实 env（工厂内 importOriginal 取）。
 */
const state = vi.hoisted(() => ({
  enforcement: true,
  limit: 1000,
  windowHours: 24,
  usageRepoThrows: false,
  // createTestDb() 的返回值 {db, reset, close}。hoisted 里无法精确标注，用 unknown + 用处转换
  testDb: undefined as unknown,
}));

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get quotaEnforcement() {
        return state.enforcement;
      },
      get quotaTokenLimit() {
        return state.limit;
      },
      get quotaWindowHours() {
        return state.windowHours;
      },
    },
  };
});

// mock @petrel/database：透传真实实现，只让 getDb() 返回测试库、并可注入会抛错的 usageRepo。
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return {
    ...actual,
    getDb: () =>
      (state.testDb as { db: unknown } | undefined)?.db as unknown as ReturnType<typeof actual.getDb>,
    createTokenUsageRepository: (...args: Parameters<typeof actual.createTokenUsageRepository>) => {
      const repo = actual.createTokenUsageRepository(...args);
      if (!state.usageRepoThrows) return repo;
      return {
        ...repo,
        sumWindowUsage: () => Promise.reject(new Error("db down")),
      };
    },
  };
});

// import 必须在 mock 声明之后（vi.mock 提升，这里拿到的是 mock 后的模块）
const { createQuotaService, QuotaError } = await import("./quota.ts");

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

let db: Database;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let quota: ReturnType<typeof createQuotaService>;
let usageRepo: ReturnType<typeof createTokenUsageRepository>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.testDb = testDb;
  db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  quota = createQuotaService(db);
  usageRepo = createTokenUsageRepository(db);
});
afterAll(() => close?.());
beforeEach(async () => {
  state.enforcement = true;
  state.limit = 1000;
  state.windowHours = 24;
  state.usageRepoThrows = false;
  await reset();
  await createSessionRepository(db).upsert({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });
});

async function insertUsage(totalTokens: number, userId = TEST_USER_ID) {
  await usageRepo.insertFact({
    entryId: crypto.randomUUID(),
    userId,
    sessionId: SESSION_ID,
    sourceType: "message",
    inputTokens: 0,
    outputTokens: totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    costTotal: "0.01",
  });
}

const normalUser = {
  id: TEST_USER_ID,
  email: TEST_USER_EMAIL,
  role: "user",
  disabled: false,
  createdAt: new Date(),
};
const adminUser = { ...normalUser, role: "admin" };

describe("quota service", () => {
  it("enforcement 关闭时一律放行（只计量不拦截）", async () => {
    state.enforcement = false;
    await insertUsage(9999);
    await expect(quota.check(normalUser)).resolves.toBeUndefined();
  });

  it("低于额度时放行", async () => {
    state.limit = 1000;
    await insertUsage(500);
    await expect(quota.check(normalUser)).resolves.toBeUndefined();
  });

  it("达到额度时拒绝（exceeded → 429）", async () => {
    state.limit = 1000;
    await insertUsage(1000);
    await expect(quota.check(normalUser)).rejects.toMatchObject({
      name: "QuotaError",
      kind: "exceeded",
    });
  });

  it("超出额度时拒绝，带 retryAfterSeconds（算得出时为正）", async () => {
    state.limit = 100;
    await insertUsage(300);
    const err = (await quota.check(normalUser).catch((e) => e)) as QuotaErrorInstance;
    expect(err.kind).toBe("exceeded");
    if (err.retryAfterSeconds !== undefined) {
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("admin 豁免拒绝（计量由 storage 层的 appendEntry 完成，与本函数无关）", async () => {
    state.limit = 1;
    await insertUsage(9999);
    await expect(quota.check(adminUser)).resolves.toBeUndefined();
  });

  it("查询失败时 fail-closed（unavailable → 503），不放行", async () => {
    state.usageRepoThrows = true;
    state.limit = 1000;
    // service 在创建时就持有 usageRepo 实例，所以这里用「开 throws 之后」现建一个 service，
    // 它拿到的 createTokenUsageRepository(db) 才是会抛错的版本
    const failingQuota = createQuotaService(db);
    await expect(failingQuota.check(normalUser)).rejects.toMatchObject({
      name: "QuotaError",
      kind: "unavailable",
    });
    state.usageRepoThrows = false;
  });

  it("token_limit=0（用户被显式禁止）拒绝", async () => {
    state.limit = 0;
    await expect(quota.check(normalUser)).rejects.toMatchObject({
      name: "QuotaError",
      kind: "exceeded",
    });
  });
});

import { createSessionRepository, createTokenUsageRepository, type Database, sql } from "@petrel/database";
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
  emailVerifiedAt: null,
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

  it("超出额度时拒绝，retryAfterSeconds 用非默认窗口算出精确秒数（防 24h 硬编码）", async () => {
    // 用 1 小时窗口而非默认 24h：若 secondsUntilUnderLimit 退回硬编码 24h，
    // 算出的 Retry-After 会是 ~86400s 而非 ~3600s。默认窗口下两者观测等价（review 🔴#1 的
    // 「默认值遮蔽」），只有非默认窗口才能区分「读配置」与「硬编码」。
    state.windowHours = 1;
    state.limit = 100;
    await insertUsage(300);
    const err = (await quota.check(normalUser).catch((e) => e)) as QuotaErrorInstance;
    expect(err.kind).toBe("exceeded");
    // 不能用 `if (x !== undefined) expect(x>0)`：undefined 时无条件通过（review 🔵 空转）。
    expect(err.retryAfterSeconds, "Retry-After 必须算得出，不能是 undefined").toBeDefined();
    // 事实 recorded_at ≈ now，1h 窗口过期时刻 ≈ now+3600s。给窄区间 [1, 4000]：
    // - 上界 4000 排除硬编码 24h（会返回 ~86400）；
    // - 下界 1 排除「已过期返回 0」。
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds, "若仍是 24h 硬编码，此值会 ≈86400").toBeLessThan(4000);
  });

  // 滚动窗口语义：超出窗口的旧用量不计入配额。这是整个配额语义的核心，
  // review 🔵 指出原本没有任何用例覆盖。insertFact 的 recorded_at 走 defaultNow()
  // 无法手动指定，所以用底层 SQL 直接写一条窗口外（48h 前）的旧事实，
  // 再走 insertFact 写一条窗口内的新事实，验证 sumWindowUsage 只算窗口内的。
  it("滚动窗口外的旧用量不计入配额", async () => {
    state.limit = 1000;
    state.windowHours = 24;
    // 窗口外的旧事实（48 小时前）：不应被计入
    await db.execute(sql`INSERT INTO token_usage
      (entry_id, user_id, session_id, source_type, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, total_tokens, cost_total, recorded_at)
      VALUES (${crypto.randomUUID()}, ${TEST_USER_ID}, ${SESSION_ID}, 'message', 0, 9999, 0, 0, 9999, '0.01',
              ${new Date(Date.now() - 48 * 60 * 60 * 1000)})`);
    // 窗口内的新事实：300，应被计入
    await insertUsage(300);
    // 若旧用量也被计入，used = 9999 + 300 ≫ 1000，会被拒绝。只算窗口内则 300 < 1000 放行。
    await expect(quota.check(normalUser)).resolves.toBeUndefined();
    // 反向钉死：sumWindowUsage 的窗口起点之后只有 300
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(await usageRepo.sumWindowUsage(TEST_USER_ID, since)).toBe(300);
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

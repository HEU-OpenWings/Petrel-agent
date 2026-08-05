import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionEntries, sessions, userPreferences, users } from "./schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "./testing.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

describe("schema", () => {
  it("测试夹具用户已就位", async () => {
    const rows = await db.select().from(users).where(eq(users.id, TEST_USER_ID));
    expect(rows).toHaveLength(1);
  });

  it("会话必须挂在存在的用户下", async () => {
    await expect(
      db.insert(sessions).values({
        id: "33333333-3333-3333-3333-333333333333",
        userId: "99999999-9999-9999-9999-999999999999",
        title: "孤儿会话",
      }),
    ).rejects.toThrow();
  });
});

describe("session_entries", () => {
  it("条目按 parent_id 串成链，entry_seq 自增", async () => {
    await db.insert(sessions).values({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });

    const first = "aaaaaaaa-0000-0000-0000-000000000001";
    const second = "aaaaaaaa-0000-0000-0000-000000000002";
    await db.insert(sessionEntries).values({
      id: first,
      sessionId: SESSION_ID,
      parentId: null,
      type: "message",
      payload: { message: { role: "user", content: [] } },
    });
    await db.insert(sessionEntries).values({
      id: second,
      sessionId: SESSION_ID,
      parentId: first,
      type: "message",
      payload: { message: { role: "assistant", content: [] } },
    });

    const rows = await db.select().from(sessionEntries).orderBy(sessionEntries.entrySeq);
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(rows.map((r) => r.parentId)).toEqual([null, first]);
    // entry_seq 只保证单调递增，不保证从 1 开始（bigserial 是全局序列）
    expect(Number(rows[1]?.entrySeq)).toBeGreaterThan(Number(rows[0]?.entrySeq));
  });

  it("删除会话级联删除条目", async () => {
    await db.insert(sessions).values({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });
    await db.insert(sessionEntries).values({
      id: "aaaaaaaa-0000-0000-0000-000000000003",
      sessionId: SESSION_ID,
      parentId: null,
      type: "leaf",
      payload: { targetId: null },
    });

    await db.delete(sessions).where(eq(sessions.id, SESSION_ID));

    expect(await db.select().from(sessionEntries)).toHaveLength(0);
  });

  it("偏好一人一行：同一用户插两次会撞主键", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "a" });

    await expect(
      db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "b" }),
    ).rejects.toThrow();
  });

  it("两列都可空：null 表示跟随系统默认", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID });

    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, TEST_USER_ID));
    expect(rows[0]).toMatchObject({ defaultModel: null, systemPrompt: null });
  });

  it("删除用户会级联删掉它的偏好", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "a" });

    await db.delete(users).where(eq(users.id, TEST_USER_ID));

    expect(await db.select().from(userPreferences)).toHaveLength(0);
  });
});

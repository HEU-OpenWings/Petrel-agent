import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { messages, sessions, userPreferences, users } from "./schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "./testing.ts";

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

/** 造一个会话，返回它的 id */
async function seedSession(id = "11111111-1111-1111-1111-111111111111") {
  await db.insert(sessions).values({ id, userId: TEST_USER_ID, title: "测试会话" });
  return id;
}

describe("schema", () => {
  it("测试夹具用户已就位", async () => {
    const rows = await db.select().from(users).where(eq(users.id, TEST_USER_ID));
    expect(rows).toHaveLength(1);
  });

  it("同一会话的 seq 不允许重复", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "user", message: { role: "user" } });

    await expect(
      db.insert(messages).values({ sessionId, seq: 1, role: "user", message: { role: "user" } }),
    ).rejects.toThrow();
  });

  it("不同会话可以有相同的 seq", async () => {
    const first = await seedSession("11111111-1111-1111-1111-111111111111");
    const second = await seedSession("22222222-2222-2222-2222-222222222222");

    await db.insert(messages).values({ sessionId: first, seq: 1, role: "user", message: {} });
    await db.insert(messages).values({ sessionId: second, seq: 1, role: "user", message: {} });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(2);
  });

  it("删除会话会级联删掉它的消息", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "user", message: {} });

    await db.delete(sessions).where(eq(sessions.id, sessionId));

    expect(await db.select().from(messages)).toHaveLength(0);
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

  it("interrupted 默认为 false", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "assistant", message: {} });

    const rows = await db.select().from(messages);
    expect(rows[0]?.interrupted).toBe(false);
  });

  it("AgentMessage 原样存取，结构不丢失", async () => {
    const sessionId = await seedSession();
    const agentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "现在是下午三点" },
        { type: "toolCall", id: "call_1", name: "get_current_time", arguments: {} },
      ],
    };

    await db.insert(messages).values({ sessionId, seq: 1, role: "assistant", message: agentMessage });

    const rows = await db.select().from(messages);
    expect(rows[0]?.message).toEqual(agentMessage);
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

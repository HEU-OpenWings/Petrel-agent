import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID, sessions } from "../schema.ts";
import { createTestDb, type TestDb } from "../testing.ts";
import { createMessageRepository } from "./messages.ts";

let db: TestDb;
let repo: ReturnType<typeof createMessageRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createMessageRepository(db);
});

beforeEach(async () => {
  await reset();
  await db.insert(sessions).values({ id: SESSION_ID, userId: DEFAULT_USER_ID, title: "测试会话" });
});

afterAll(() => close());

describe("messageRepository", () => {
  it("append 后能按 seq 升序读回", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 2, role: "assistant", message: { role: "assistant" } });
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: { role: "user" } });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.seq)).toEqual([1, 2]);
    expect(list.map((item) => item.role)).toEqual(["user", "assistant"]);
  });

  it("空会话的 maxSeq 是 0", async () => {
    expect(await repo.maxSeq(SESSION_ID)).toBe(0);
  });

  it("maxSeq 返回当前最大序号", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: {} });
    await repo.append({ sessionId: SESSION_ID, seq: 7, role: "assistant", message: {} });

    expect(await repo.maxSeq(SESSION_ID)).toBe(7);
  });

  it("interrupted 默认 false，可显式置 true", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "assistant", message: {} });
    await repo.append({
      sessionId: SESSION_ID,
      seq: 2,
      role: "assistant",
      message: {},
      interrupted: true,
    });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.interrupted)).toEqual([false, true]);
  });

  it("AgentMessage 的嵌套结构原样返回", async () => {
    const agentMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "get_current_time", arguments: { tz: "Asia/Shanghai" } },
      ],
    };
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "assistant", message: agentMessage });

    const list = await repo.listBySession(SESSION_ID);
    expect(list[0]?.message).toEqual(agentMessage);
  });

  it("只返回指定会话的消息", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    await db.insert(sessions).values({ id: other, userId: DEFAULT_USER_ID, title: "另一个会话" });
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: {} });
    await repo.append({ sessionId: other, seq: 1, role: "user", message: {} });

    expect(await repo.listBySession(SESSION_ID)).toHaveLength(1);
  });
});

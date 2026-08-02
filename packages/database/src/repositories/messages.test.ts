import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID, messages, sessions } from "../schema.ts";
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

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

describe("messageRepository", () => {
  it("append 按调用顺序分配 seq，读回时升序", async () => {
    await repo.append({ sessionId: SESSION_ID, role: "user", message: { role: "user" } });
    await repo.append({ sessionId: SESSION_ID, role: "assistant", message: { role: "assistant" } });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.seq)).toEqual([1, 2]);
    expect(list.map((item) => item.role)).toEqual(["user", "assistant"]);
  });

  it("seq 从库里的当前最大值接着排，不从 1 重来", async () => {
    // 直接插一条高序号的，模拟「另一个请求已经写到 7 了」
    await db.insert(messages).values({ sessionId: SESSION_ID, seq: 7, role: "user", message: {} });

    await repo.append({ sessionId: SESSION_ID, role: "assistant", message: {} });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.seq)).toEqual([7, 8]);
  });

  it("并发 append 同一会话，seq 连续无洞且一条不丢", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.append({ sessionId: SESSION_ID, role: "user", message: { index } }),
      ),
    );

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("空会话的 maxSeq 是 0", async () => {
    expect(await repo.maxSeq(SESSION_ID)).toBe(0);
  });

  it("maxSeq 返回当前最大序号", async () => {
    await db.insert(messages).values({ sessionId: SESSION_ID, seq: 1, role: "user", message: {} });
    await db.insert(messages).values({ sessionId: SESSION_ID, seq: 7, role: "assistant", message: {} });

    expect(await repo.maxSeq(SESSION_ID)).toBe(7);
  });

  it("interrupted 默认 false，可显式置 true", async () => {
    await repo.append({ sessionId: SESSION_ID, role: "assistant", message: {} });
    await repo.append({ sessionId: SESSION_ID, role: "assistant", message: {}, interrupted: true });

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
    await repo.append({ sessionId: SESSION_ID, role: "assistant", message: agentMessage });

    const list = await repo.listBySession(SESSION_ID);
    expect(list[0]?.message).toEqual(agentMessage);
  });

  it("只返回指定会话的消息", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    await db.insert(sessions).values({ id: other, userId: DEFAULT_USER_ID, title: "另一个会话" });
    await repo.append({ sessionId: SESSION_ID, role: "user", message: {} });
    await repo.append({ sessionId: other, role: "user", message: {} });

    expect(await repo.listBySession(SESSION_ID)).toHaveLength(1);
  });
});

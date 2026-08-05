import { createEntryRepository } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSessionService } from "./session.ts";

let db: TestDb;
let service: ReturnType<typeof createSessionService>;
let entryRepo: ReturnType<typeof createEntryRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  service = createSessionService(db, TEST_USER_ID);
  entryRepo = createEntryRepository(db);
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 造一条 message 条目，parent 串在上一条后面。落库现在归 harness/PgSessionStorage 管，
 * 这里直接写 entries 来构造历史，与 routes/sessions.test.ts 的同名辅助一致 */
async function appendMessageEntry(sessionId: string, n: number, role: string, content: unknown) {
  await entryRepo.append({
    id: `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`,
    sessionId,
    parentId: n === 1 ? null : `aaaaaaaa-0000-0000-0000-${String(n - 1).padStart(12, "0")}`,
    type: "message",
    payload: { message: { role, content } },
  });
}

describe("buildTitle", () => {
  it("短消息原样作标题", () => {
    expect(service.buildTitle("现在几点")).toBe("现在几点");
  });

  it("超过 30 字截断并加省略号", () => {
    const long = "一".repeat(40);
    const title = service.buildTitle(long);

    expect(title).toHaveLength(31);
    expect(title.endsWith("…")).toBe(true);
  });

  it("首尾空白不计入", () => {
    expect(service.buildTitle("  现在几点  ")).toBe("现在几点");
  });

  it("空消息回落到默认标题", () => {
    expect(service.buildTitle("   ")).toBe("新对话");
  });
});

describe("ensureSession", () => {
  it("首次调用建出会话并用首句作标题", async () => {
    await service.ensureSession(SESSION_ID, "帮我查一下时间");

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("帮我查一下时间");
  });

  it("再次调用不覆盖已改过的标题", async () => {
    await service.ensureSession(SESSION_ID, "第一条消息");
    await service.rename(SESSION_ID, "我改的名字");
    await service.ensureSession(SESSION_ID, "第二条消息");

    const list = await service.list();
    expect(list[0]?.title).toBe("我改的名字");
  });
});

describe("loadHistory", () => {
  it("空会话返回空历史", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([]);
  });

  it("按写入顺序读回消息", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await appendMessageEntry(SESSION_ID, 1, "user", "你好");
    await appendMessageEntry(SESSION_ID, 2, "assistant", "你也好");

    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你也好" },
    ]);
  });

  it("role 从 message 里自动取出", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await appendMessageEntry(SESSION_ID, 1, "toolResult", []);

    const history = await service.loadHistory(SESSION_ID);
    expect((history.messages[0] as { role: string }).role).toBe("toolResult");
  });

  it("非 message 类型的条目不出现在历史里", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await appendMessageEntry(SESSION_ID, 1, "user", "你好");
    await entryRepo.append({
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      sessionId: SESSION_ID,
      parentId: "aaaaaaaa-0000-0000-0000-000000000001",
      type: "compaction",
      payload: { summary: "占位" },
    });

    const history = await service.loadHistory(SESSION_ID);
    expect(history.messages).toHaveLength(1);
  });

  it("不属于当前用户的会话按不存在处理", async () => {
    const history = await service.loadHistory("22222222-2222-2222-2222-222222222222");
    expect(history.messages).toEqual([]);
  });
});

describe("CRUD", () => {
  it("rename 命中返回 true，不存在返回 false", async () => {
    await service.ensureSession(SESSION_ID, "会话");

    expect(await service.rename(SESSION_ID, "新名")).toBe(true);
    expect(await service.rename("22222222-2222-2222-2222-222222222222", "新名")).toBe(false);
  });

  it("remove 删掉会话及其消息", async () => {
    await service.ensureSession(SESSION_ID, "会话");
    await appendMessageEntry(SESSION_ID, 1, "user", "你好");

    expect(await service.remove(SESSION_ID)).toBe(true);
    expect(await service.list()).toHaveLength(0);
    // 会话没了，归属校验就先失败，等价于「没有历史」而不是级联删除本身的断言
    expect((await service.loadHistory(SESSION_ID)).messages).toEqual([]);
  });
});

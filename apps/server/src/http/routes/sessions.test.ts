import { createEntryRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "../../services/session.ts";
import { app } from "../app.ts";
import { __resetRegistry } from "./chat.ts";

/**
 * 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，
 * 所以整个模块替身一次，把它换成测试库。
 *
 * 没有改成依赖注入：那要在生产代码（Hono context 或工厂函数）上开一个
 * 只为测试存在的口子，覆盖面一样、成本更高。
 * repository 收的 Database 本来就是 NodePgDatabase | PgliteDatabase 的联合，
 * PGlite 实例能原样喂进去。
 *
 * state 用 vi.hoisted：vi.mock 会被提升到 import 之上，
 * 工厂里不能引用普通的顶层变量。
 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  // getDb 的签名只认 NodePgDatabase，断言一次把 PGlite 实例塞进去
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

/** 源码里不放不可见控制字符：写成字面量会让 diff 和 grep 都读不出来 */
const NUL = String.fromCharCode(0);

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-2222-2222-222222222222";
const ABSENT_SESSION_ID = "33333333-3333-3333-3333-333333333333";

let service: ReturnType<typeof createSessionService>;
let entryRepo: ReturnType<typeof createEntryRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  entryRepo = createEntryRepository(testDb.db);
});

let cookie: string;

beforeEach(async () => {
  await reset();
  __resetRegistry();
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@x.io", password: "hunter2hunter2" }),
  });
  cookie = (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await response.json()) as { user: { id: string } };
  service = createSessionService(state.db!, body.user.id);
});

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 造一条 message 条目，parent 串在上一条后面 */
async function appendMessage(sessionId: string, n: number, role: string, text: string) {
  await entryRepo.append({
    id: `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`,
    sessionId,
    parentId: n === 1 ? null : `aaaaaaaa-0000-0000-0000-${String(n - 1).padStart(12, "0")}`,
    type: "message",
    payload: { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
  });
}

function patch(id: string, body: string) {
  return app.request(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body,
  });
}

describe("GET /api/sessions", () => {
  it("空库返回空数组", async () => {
    const response = await app.request("/api/sessions", { headers: { Cookie: cookie } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [] });
  });

  it("返回会话的 id 与标题，最近更新的在前", async () => {
    await service.ensureSession(SESSION_ID, "先建的会话");
    // sleep 是给 PGlite 用的：它的 now() 只有毫秒分辨率，两条 insert 挤在同一毫秒里
    // 会拿到完全相同的 updatedAt，此时 ORDER BY updated_at DESC 的顺序不定。
    // 真实 Postgres 的 now() 是微秒精度，不需要这个等待。
    // （同 repositories/sessions.test.ts 里「列表按 updatedAt 倒序」的处理）
    await new Promise((resolve) => setTimeout(resolve, 2));
    await service.ensureSession(OTHER_SESSION_ID, "后建的会话");

    const response = await app.request("/api/sessions", { headers: { Cookie: cookie } });
    const body = (await response.json()) as { sessions: { id: string; title: string }[] };

    expect(response.status).toBe(200);
    expect(body.sessions.map((session) => [session.id, session.title])).toEqual([
      [OTHER_SESSION_ID, "后建的会话"],
      [SESSION_ID, "先建的会话"],
    ]);
  });
});

describe("GET /api/sessions/:id/messages", () => {
  it("返回会话的完整消息列表", async () => {
    await service.ensureSession(SESSION_ID, "有历史的会话");
    await appendMessage(SESSION_ID, 1, "user", "问题");
    await appendMessage(SESSION_ID, 2, "assistant", "回答");

    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    // 契约里不再有 interruptedSeqs：前端从未消费它，中断信息在消息自带的 stopReason 里
    await expect(response.json()).resolves.toEqual({
      messages: [expect.objectContaining({ role: "user" }), expect.objectContaining({ role: "assistant" })],
    });
  });

  it("会话不存在时返回 200 与空数组", async () => {
    const response = await app.request(`/api/sessions/${ABSENT_SESSION_ID}/messages`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [] });
  });

  it("非法 UUID 返回 400", async () => {
    const response = await app.request("/api/sessions/not-a-uuid/messages", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "会话 id 必须是 UUID" } });
  });
});

describe("PATCH /api/sessions/:id", () => {
  it("改名后列表里是新标题", async () => {
    await service.ensureSession(SESSION_ID, "原标题");

    const response = await patch(SESSION_ID, JSON.stringify({ title: "  新标题  " }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect((await service.list())[0]?.title).toBe("新标题");
  });

  it("标题里的 NUL 被清掉后照常改名", async () => {
    await service.ensureSession(SESSION_ID, "原标题");

    const response = await patch(SESSION_ID, JSON.stringify({ title: `新${NUL}标题` }));

    expect(response.status).toBe(200);
    expect((await service.list())[0]?.title).toBe("新标题");
  });

  it("会话不存在返回 404", async () => {
    const response = await patch(ABSENT_SESSION_ID, JSON.stringify({ title: "新标题" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { message: "会话不存在" } });
  });

  it("非法 UUID 返回 400", async () => {
    const response = await patch("not-a-uuid", JSON.stringify({ title: "新标题" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "会话 id 必须是 UUID" } });
  });

  it("请求体不是 JSON 返回 400", async () => {
    const response = await patch(SESSION_ID, "not json");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "请求体必须是 JSON" } });
  });

  // 这些请求体都能让「先当成 { title: string } 用」的写法抛 TypeError，
  // 被 error 中间件兜成 500——客户端错误却报服务端错误，还白打一条 stack 日志
  it.each([
    { name: "body 是 null", body: "null" },
    { name: "body 是数组", body: "[]" },
    { name: "body 是字符串", body: '"abc"' },
    { name: "没有 title", body: "{}" },
    { name: "title 是 null", body: '{"title":null}' },
    { name: "title 是数字", body: '{"title":123}' },
    { name: "title 是布尔", body: '{"title":true}' },
    { name: "title 是对象", body: '{"title":{}}' },
    { name: "title 是数组", body: '{"title":[]}' },
    { name: "title 只有空白", body: '{"title":"   "}' },
    { name: "title 只有 NUL", body: JSON.stringify({ title: `${NUL} ${NUL}` }) },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const response = await patch(SESSION_ID, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "title 必须是非空字符串" },
    });
  });

  it("超长 title 返回 400，不让它落库", async () => {
    await service.ensureSession(SESSION_ID, "原标题");

    const response = await patch(SESSION_ID, JSON.stringify({ title: "长".repeat(201) }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "title 不能超过 200 字" } });
    expect((await service.list())[0]?.title).toBe("原标题");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("删掉会话，消息一并级联删除", async () => {
    await service.ensureSession(SESSION_ID, "待删的会话");
    await appendMessage(SESSION_ID, 1, "user", "你好");

    const response = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(await service.list()).toEqual([]);
    expect((await service.loadHistory(SESSION_ID)).messages).toEqual([]);
  });

  it("删除会话后常驻实例被清掉", async () => {
    await service.ensureSession(SESSION_ID, "t");

    const response = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    // evict 是幂等的：没有活实例时也不该报错
    const second = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(second.status).toBe(404);
  });

  it("会话不存在返回 404", async () => {
    const response = await app.request(`/api/sessions/${ABSENT_SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { message: "会话不存在" } });
  });

  it("非法 UUID 返回 400", async () => {
    const response = await app.request("/api/sessions/not-a-uuid", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "会话 id 必须是 UUID" } });
  });
});

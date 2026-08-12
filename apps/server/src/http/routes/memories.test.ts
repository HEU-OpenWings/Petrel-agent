import {
  createMemoryRepository,
  createUserRepository,
  MEMORY_EMBEDDING_DIM,
} from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

// 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});
beforeEach(() => {
  __resetAuthRateLimits();
  return reset();
});
afterAll(() => close?.());

/** 注册并登录，返回 { cookie, userId } */
async function registerUser(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await createUserRepository(state.db!).setEmailVerified(body.user.id, new Date());
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return { cookie: login.headers.get("set-cookie") ?? "", userId: body.user.id };
}

async function seedMemory(userId: string, content: string): Promise<string> {
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  const created = await createMemoryRepository(state.db!).insert(userId, {
    content,
    embedding: new Array<number>(MEMORY_EMBEDDING_DIM).fill(0.1),
    sourceSessionId: null,
  });
  return created.id;
}

describe("GET /api/memories", () => {
  it("只返回自己的记忆，且不含 embedding", async () => {
    const mine = await registerUser("mine@example.com");
    const other = await registerUser("other@example.com");
    await seedMemory(mine.userId, "我的记忆");
    await seedMemory(other.userId, "别人的记忆");

    const response = await app.request("/api/memories", { headers: { cookie: mine.cookie } });
    const body = (await response.json()) as { memories: { content: string }[] };

    expect(response.status).toBe(200);
    expect(body.memories.map((memory) => memory.content)).toEqual(["我的记忆"]);
    // 1024 个浮点数不该出现在 HTTP 响应里
    expect(body.memories[0]).not.toHaveProperty("embedding");
  });
});

describe("DELETE /api/memories/:id", () => {
  it("能删自己的", async () => {
    const mine = await registerUser("mine@example.com");
    const id = await seedMemory(mine.userId, "我的记忆");

    const response = await app.request(`/api/memories/${id}`, {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(200);
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    expect(await createMemoryRepository(state.db!).listByUserId(mine.userId)).toEqual([]);
  });

  // 403 会泄漏「这个 id 存在」
  it("删别人的返回 404 且那条记忆仍在", async () => {
    const mine = await registerUser("mine@example.com");
    const other = await registerUser("other@example.com");
    const id = await seedMemory(other.userId, "别人的记忆");

    const response = await app.request(`/api/memories/${id}`, {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(404);
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    expect(await createMemoryRepository(state.db!).listByUserId(other.userId)).toHaveLength(1);
  });

  it("删不存在的返回 404", async () => {
    const mine = await registerUser("mine@example.com");

    const response = await app.request("/api/memories/00000000-0000-0000-0000-0000000000ff", {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(404);
  });
});

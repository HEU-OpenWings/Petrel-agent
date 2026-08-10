import { createUserRepository } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  userIds: [] as string[],
}));

vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    listConfiguredModels: vi.fn(() => {
      throw new Error("account 不得再调用 global listConfiguredModels");
    }),
    createUserProviderService: vi.fn((_db: unknown, userId: string) => {
      state.userIds.push(userId);
      return {
        listConfiguredModels: vi.fn(async () => [
          {
            id: "personal-runtime-model",
            name: "Personal runtime model",
            provider: "deepseek",
            providerName: "DeepSeek",
            isDefault: false,
          },
        ]),
      };
    }),
  };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(async () => {
  state.userIds.length = 0;
  __resetAuthRateLimits();
  await reset();
});

afterAll(() => close?.());

async function registerUser(): Promise<{ id: string; cookie: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "scoped-models@example.com", password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  // biome-ignore lint/style/noNonNullAssertion: test db is initialized in beforeAll
  await createUserRepository(state.db!).setEmailVerified(body.user.id, new Date());
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "scoped-models@example.com", password: "hunter2hunter2" }),
  });
  return {
    id: body.user.id,
    cookie: (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "",
  };
}

describe("account preferences 使用当前用户 runtime Models", () => {
  it("GET 返回 user-scoped 清单，PUT 用同一清单校验", async () => {
    const user = await registerUser();

    const get = await app.request("/api/account/preferences", {
      headers: { Cookie: user.cookie },
    });
    const getBody = (await get.json()) as { models: Array<{ id: string }> };
    const put = await app.request("/api/account/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify({ defaultModel: "personal-runtime-model", systemPrompt: null }),
    });

    expect(get.status).toBe(200);
    expect(getBody.models.map((model) => model.id)).toEqual(["personal-runtime-model"]);
    expect(put.status).toBe(200);
    expect(state.userIds).toEqual([user.id, user.id]);
  });
});

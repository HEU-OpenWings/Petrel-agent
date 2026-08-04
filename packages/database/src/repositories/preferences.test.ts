import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createPreferencesRepository } from "./preferences.ts";

let db: TestDb;
let repo: ReturnType<typeof createPreferencesRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离（同 schema.test.ts）
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createPreferencesRepository(db);
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

describe("createPreferencesRepository", () => {
  // 响应形状恒定是个契约：调用方不该需要区分「没这行」和「两项都跟随默认」
  it("没有行时返回两项都是 null，而不是 undefined", async () => {
    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: null,
    });
  });

  it("save 会懒创建这一行", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "你是助手" });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: "m-1",
      systemPrompt: "你是助手",
    });
  });

  it("save 第二次走更新而不是插入，不撞主键", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "第一版" });

    await repo.save(TEST_USER_ID, { defaultModel: "m-2", systemPrompt: "第二版" });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: "m-2",
      systemPrompt: "第二版",
    });
  });

  // 全量语义：null 是「清回系统默认」，不是「这项别动」
  it("save 传 null 会把已有的值清掉", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "你是助手" });

    await repo.save(TEST_USER_ID, { defaultModel: null, systemPrompt: null });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: null,
    });
  });

  it("save 返回落库后的值，调用方不用再查一次", async () => {
    await expect(
      repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: null }),
    ).resolves.toEqual({ defaultModel: "m-1", systemPrompt: null });
  });
});

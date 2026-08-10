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

  // 返回值断言必须和「库里真的是这些内容」贴在一起：save 是全量覆盖写，
  // 单独断言它的返回值只是「函数返回自己的入参」的恒等式，证明不了任何落库行为。
  // Task 7 的路由把这个返回值直接当 HTTP 响应体，所以契约本身值得钉住
  it("save 懒创建这一行，返回值与落库内容一致", async () => {
    const saved = await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "你是助手" });

    expect(saved).toEqual({ defaultModel: "m-1", systemPrompt: "你是助手" });
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

  it("默认模型仍匹配时条件清空，并保留 systemPrompt", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "保留这段提示词" });

    await expect(repo.clearDefaultModelIfMatches(TEST_USER_ID, "m-1")).resolves.toBe(true);
    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: "保留这段提示词",
    });
  });

  it("并发保存了新默认模型后，过期的条件清理不会覆盖新值", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "提示词" });

    // 模拟删除凭据请求读到 m-1 后，另一个标签页先保存了 m-2。
    await repo.save(TEST_USER_ID, { defaultModel: "m-2", systemPrompt: "新提示词" });

    await expect(repo.clearDefaultModelIfMatches(TEST_USER_ID, "m-1")).resolves.toBe(false);
    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: "m-2",
      systemPrompt: "新提示词",
    });
  });

  it("没有偏好行时条件清理幂等返回 false", async () => {
    await expect(repo.clearDefaultModelIfMatches(TEST_USER_ID, "m-1")).resolves.toBe(false);
    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: null,
    });
  });
});

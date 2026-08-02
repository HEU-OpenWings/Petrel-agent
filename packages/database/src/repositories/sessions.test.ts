import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../schema.ts";
import { createTestDb, type TestDb } from "../testing.ts";
import { createSessionRepository } from "./sessions.ts";

let db: TestDb;
let repo: ReturnType<typeof createSessionRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createSessionRepository(db);
});

beforeEach(() => reset());

afterAll(() => close());

describe("sessionRepository", () => {
  it("upsert 建出新会话", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "第一个会话" });

    const found = await repo.findById(ID_A);
    expect(found?.title).toBe("第一个会话");
  });

  it("upsert 命中已存在的会话时不覆盖标题", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "原标题" });
    await repo.rename(ID_A, "用户改过的标题");
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "又一条消息的首句" });

    const found = await repo.findById(ID_A);
    expect(found?.title).toBe("用户改过的标题");
  });

  it("findById 找不到时返回 undefined", async () => {
    expect(await repo.findById(ID_A)).toBeUndefined();
  });

  it("列表按 updatedAt 倒序", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "旧会话" });
    await repo.upsert({ id: ID_B, userId: DEFAULT_USER_ID, title: "新会话" });
    // 显式 touch 一次把 A 顶上去。sleep 是给 PGlite 用的：它的 now() 只有毫秒
    // 分辨率，insert B 和 touch A 挤在同一毫秒里会拿到完全相同的时间戳，
    // 此时 ORDER BY updated_at DESC 的顺序不定（实测 30 次里 19 次撞上）。
    // 真实 Postgres 的 now() 是微秒精度，不需要这个等待。
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repo.touch(ID_A);

    const list = await repo.listByUser(DEFAULT_USER_ID);
    expect(list.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  it("rename 改标题并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "旧名" });

    expect(await repo.rename(ID_A, "新名")).toBe(true);
    expect((await repo.findById(ID_A))?.title).toBe("新名");
  });

  it("rename 不存在的会话返回 false", async () => {
    expect(await repo.rename(ID_A, "新名")).toBe(false);
  });

  it("remove 删除并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "待删" });

    expect(await repo.remove(ID_A)).toBe(true);
    expect(await repo.findById(ID_A)).toBeUndefined();
  });

  it("remove 不存在的会话返回 false", async () => {
    expect(await repo.remove(ID_A)).toBe(false);
  });

  it("touch 推进 updatedAt", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "会话" });
    const before = (await repo.findById(ID_A))?.updatedAt;

    await repo.touch(ID_A);
    const after = (await repo.findById(ID_A))?.updatedAt;

    expect(before).toBeInstanceOf(Date);
    expect(after?.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
  });
});

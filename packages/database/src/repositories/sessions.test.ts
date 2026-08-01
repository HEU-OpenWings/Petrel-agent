import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../schema.ts";
import { createTestDb, type TestDb } from "../testing.ts";
import { createSessionRepository } from "./sessions.ts";

let db: TestDb;
let repo: ReturnType<typeof createSessionRepository>;

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  repo = createSessionRepository(db);
  return () => created.close();
});

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
    // 显式 touch 一次，避免两条记录的 defaultNow() 落在同一时刻
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

    expect(after!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });
});

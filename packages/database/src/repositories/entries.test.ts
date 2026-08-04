import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessions } from "../schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createEntryRepository } from "./entries.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-2222-2222-222222222222";

/** 条目 id 要看得出顺序，用后缀编号而不是随机 uuid */
function entryId(n: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

/** 另一个会话专用的条目 id：前缀不同，避免跟 SESSION_ID 侧的 id 撞主键 */
function otherEntryId(n: number): string {
  return `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let repo: ReturnType<typeof createEntryRepository>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createEntryRepository(db);
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  await db.insert(sessions).values([
    { id: SESSION_ID, userId: TEST_USER_ID, title: "a" },
    { id: OTHER_SESSION_ID, userId: TEST_USER_ID, title: "b" },
  ]);
});

/** 追加一条 message 条目，parent 为上一条 */
async function appendMessage(n: number, parent: number | null, sessionId = SESSION_ID) {
  await repo.append({
    id: entryId(n),
    sessionId,
    parentId: parent === null ? null : entryId(parent),
    type: "message",
    payload: { message: { role: "user", content: [{ type: "text", text: `m${n}` }] } },
  });
}

describe("createEntryRepository", () => {
  it("append 后能按 id 取回，payload 原样", async () => {
    await appendMessage(1, null);

    const row = await repo.byId(SESSION_ID, entryId(1));
    expect(row).toMatchObject({ id: entryId(1), parentId: null, type: "message" });
    expect(row?.payload).toEqual({
      message: { role: "user", content: [{ type: "text", text: "m1" }] },
    });
  });

  it("byId 按 sessionId 收窄，别的会话的条目取不到", async () => {
    await appendMessage(1, null, OTHER_SESSION_ID);

    expect(await repo.byId(SESSION_ID, entryId(1))).toBeUndefined();
  });

  it("pathToRootOrCompaction 返回根到叶的正序", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await appendMessage(3, 2);

    const path = await repo.pathToRootOrCompaction(SESSION_ID, entryId(3));
    expect(path.map((e) => e.id)).toEqual([entryId(1), entryId(2), entryId(3)]);
  });

  it("pathToRootOrCompaction 在 compaction 条目处停下，且包含它", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await repo.append({
      id: entryId(3),
      sessionId: SESSION_ID,
      parentId: entryId(2),
      type: "compaction",
      payload: { summary: "s", tokensBefore: 10 },
    });
    await appendMessage(4, 3);

    const path = await repo.pathToRootOrCompaction(SESSION_ID, entryId(4));
    // 压缩之前的 1、2 被挡在上下文之外，但它们仍然在表里
    expect(path.map((e) => e.id)).toEqual([entryId(3), entryId(4)]);
    expect(await repo.byId(SESSION_ID, entryId(1))).toBeDefined();
  });

  it("leafId 为 null 时 pathToRootOrCompaction 返回空数组", async () => {
    await appendMessage(1, null);

    expect(await repo.pathToRootOrCompaction(SESSION_ID, null)).toEqual([]);
  });

  it("byType 只返回该类型，按 entry_seq 升序，且按 sessionId 收窄", async () => {
    await appendMessage(1, null);
    await repo.append({
      id: entryId(2),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(1) },
    });
    await repo.append({
      id: entryId(3),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(2) },
    });
    // 另一个会话下同类型的条目：不应混进结果
    await repo.append({
      id: otherEntryId(1),
      sessionId: OTHER_SESSION_ID,
      parentId: null,
      type: "leaf",
      payload: { targetId: otherEntryId(1) },
    });

    const leaves = await repo.byType(SESSION_ID, "leaf");
    expect(leaves.map((e) => e.id)).toEqual([entryId(2), entryId(3)]);
  });

  it("latestLeaf 取最后写入的 leaf 条目，且按 sessionId 收窄", async () => {
    await appendMessage(1, null);
    await repo.append({
      id: entryId(2),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(1) },
    });

    expect((await repo.latestLeaf(SESSION_ID))?.id).toEqual(entryId(2));
    expect(await repo.latestLeaf(OTHER_SESSION_ID)).toBeUndefined();

    // 另一个会话之后才写入 leaf：不应改变 SESSION_ID 的结果
    await repo.append({
      id: otherEntryId(1),
      sessionId: OTHER_SESSION_ID,
      parentId: null,
      type: "leaf",
      payload: { targetId: otherEntryId(1) },
    });

    expect((await repo.latestLeaf(SESSION_ID))?.id).toEqual(entryId(2));
    expect((await repo.latestLeaf(OTHER_SESSION_ID))?.id).toEqual(otherEntryId(1));
  });

  it("listAll 按 entry_seq 升序，listAfter 按游标续读，且都按 sessionId 收窄", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await appendMessage(3, 2);
    // 另一个会话的条目：entry_seq 全局递增，若 listAll/listAfter 漏了 sessionId 过滤，
    // 这条会混进 SESSION_ID 的结果里
    await repo.append({
      id: otherEntryId(1),
      sessionId: OTHER_SESSION_ID,
      parentId: null,
      type: "message",
      payload: { message: { role: "user", content: [{ type: "text", text: "other" }] } },
    });

    const all = await repo.listAll(SESSION_ID);
    expect(all.map((e) => e.id)).toEqual([entryId(1), entryId(2), entryId(3)]);

    const first = all[0];
    if (first === undefined) throw new Error("expected at least one entry");

    const after = await repo.listAfter(SESSION_ID, first.entrySeq, 10);
    expect(after.map((e) => e.id)).toEqual([entryId(2), entryId(3)]);

    const limited = await repo.listAfter(SESSION_ID, first.entrySeq, 1);
    expect(limited.map((e) => e.id)).toEqual([entryId(2)]);
  });
});

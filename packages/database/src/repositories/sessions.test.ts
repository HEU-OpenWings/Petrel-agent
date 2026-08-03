import { drizzle } from "drizzle-orm/pglite";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../schema.ts";
import { users } from "../schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
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

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

describe("sessionRepository", () => {
  it("upsert 建出新会话", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "第一个会话" });

    const found = await repo.findById(ID_A, TEST_USER_ID);
    expect(found?.title).toBe("第一个会话");
  });

  it("upsert 命中已存在的会话时不覆盖标题", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "原标题" });
    await repo.rename(ID_A, TEST_USER_ID, "用户改过的标题");
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "又一条消息的首句" });

    const found = await repo.findById(ID_A, TEST_USER_ID);
    expect(found?.title).toBe("用户改过的标题");
  });

  it("findById 找不到时返回 undefined", async () => {
    expect(await repo.findById(ID_A, TEST_USER_ID)).toBeUndefined();
  });

  it("列表按 updatedAt 倒序", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "旧会话" });
    await repo.upsert({ id: ID_B, userId: TEST_USER_ID, title: "新会话" });
    // 显式 touch 一次把 A 顶上去。sleep 是给 PGlite 用的：它的 now() 只有毫秒
    // 分辨率，insert B 和 touch A 挤在同一毫秒里会拿到完全相同的时间戳，
    // 此时 ORDER BY updated_at DESC 的顺序不定（实测 30 次里 19 次撞上）。
    // 真实 Postgres 的 now() 是微秒精度，不需要这个等待。
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repo.touch(ID_A, TEST_USER_ID);

    const list = await repo.listByUser(TEST_USER_ID);
    expect(list.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  it("rename 改标题并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "旧名" });

    expect(await repo.rename(ID_A, TEST_USER_ID, "新名")).toBe(true);
    expect((await repo.findById(ID_A, TEST_USER_ID))?.title).toBe("新名");
  });

  it("rename 不存在的会话返回 false", async () => {
    expect(await repo.rename(ID_A, TEST_USER_ID, "新名")).toBe(false);
  });

  it("remove 删除并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "待删" });

    expect(await repo.remove(ID_A, TEST_USER_ID)).toBe(true);
    expect(await repo.findById(ID_A, TEST_USER_ID)).toBeUndefined();
  });

  it("remove 不存在的会话返回 false", async () => {
    expect(await repo.remove(ID_A, TEST_USER_ID)).toBe(false);
  });

  it("touch 推进 updatedAt", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "会话" });
    const before = (await repo.findById(ID_A, TEST_USER_ID))?.updatedAt;

    // 同样要等一下：PGlite 的 now() 只有毫秒精度，touch 紧跟 insert 会拿到完全
    // 相同的时间戳，断言就退化成 t >= t 的空转。等过一毫秒才能断严格递增
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repo.touch(ID_A, TEST_USER_ID);
    const after = (await repo.findById(ID_A, TEST_USER_ID))?.updatedAt;

    assert(before instanceof Date);
    assert(after instanceof Date);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

/**
 * updatedAt 必须由数据库时钟生成（理由见 sessions.ts 里 NOW 的注释）。
 *
 * 这条行为在 PGlite 上测不出来：它的 now() 和 JS 的 Date.now() 都是毫秒精度，
 * 两种写法产生的时间戳无法区分，改回 new Date() 全套测试照样全绿。
 * 所以这里退一步，直接断言下发的 SQL 里是 now() 而不是参数占位符。
 */
describe("updatedAt 的时钟源", () => {
  /** 用带 logger 的 drizzle 包同一个 PGlite 客户端，抓真正执行的 SQL */
  function recordingRepo() {
    const queries: string[] = [];
    const recording = drizzle({
      client: db.$client,
      schema,
      logger: { logQuery: (query) => queries.push(query) },
    });
    return { repo: createSessionRepository(recording), queries };
  }

  it("touch 用 now() 而不是绑定参数", async () => {
    const { repo: recorded, queries } = recordingRepo();

    await recorded.touch(ID_A, TEST_USER_ID);

    expect(queries.at(-1)).toMatch(/set "updated_at" = now\(\)/);
  });

  it("rename 用 now() 而不是绑定参数", async () => {
    const { repo: recorded, queries } = recordingRepo();

    await recorded.rename(ID_A, TEST_USER_ID, "新名");

    expect(queries.at(-1)).toMatch(/"updated_at" = now\(\)/);
  });

  // ensureSession 每条消息都会调 upsert，左栏「最近更新置顶」靠的就是这个分支
  it("upsert 命中冲突时用 now() 而不是绑定参数", async () => {
    const { repo: recorded, queries } = recordingRepo();

    await recorded.upsert({ id: ID_A, userId: TEST_USER_ID, title: "会话" });

    expect(queries.at(-1)).toMatch(/do update set "updated_at" = now\(\)/);
  });
});

describe("跨用户隔离", () => {
  const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000aa";

  beforeEach(async () => {
    await db.insert(users).values({
      id: OTHER_USER_ID,
      email: "other@x.io",
      // 同 testing.ts 的夹具：不合法的哈希格式，这个账号登不进来
      passwordHash: "!",
    });
  });

  it("findById 读不到别人的会话", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "我的会话" });

    await expect(repo.findById(ID_A, OTHER_USER_ID)).resolves.toBeUndefined();
  });

  it("rename 改不动别人的会话", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "原标题" });

    await expect(repo.rename(ID_A, OTHER_USER_ID, "被改了")).resolves.toBe(false);
    expect((await repo.findById(ID_A, TEST_USER_ID))?.title).toBe("原标题");
  });

  it("remove 删不掉别人的会话", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "我的会话" });

    await expect(repo.remove(ID_A, OTHER_USER_ID)).resolves.toBe(false);
    expect(await repo.findById(ID_A, TEST_USER_ID)).toBeDefined();
  });

  // 这条守的是「往别人会话里注入内容」——比改删更严重的一种越权
  it("upsert 撞上别人的会话 id 时返回 false 且不更新对方", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "我的会话" });
    const before = await repo.findById(ID_A, TEST_USER_ID);
    await new Promise((resolve) => setTimeout(resolve, 2));

    const accepted = await repo.upsert({ id: ID_A, userId: OTHER_USER_ID, title: "劫持" });

    expect(accepted).toBe(false);
    const after = await repo.findById(ID_A, TEST_USER_ID);
    expect(after?.title).toBe("我的会话");
    // updatedAt 也不能被顶起，否则对方的左栏排序会被外人扰动
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("upsert 自己的会话返回 true", async () => {
    await expect(repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "新建" })).resolves.toBe(true);
    await expect(repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "再来一条" })).resolves.toBe(true);
  });

  it("listByUser 只返回自己的", async () => {
    await repo.upsert({ id: ID_A, userId: TEST_USER_ID, title: "我的" });
    await repo.upsert({ id: ID_B, userId: OTHER_USER_ID, title: "别人的" });

    const list = await repo.listByUser(TEST_USER_ID);

    expect(list.map((session) => session.id)).toEqual([ID_A]);
  });
});

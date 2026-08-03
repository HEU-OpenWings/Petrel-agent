import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../client.ts";
import { users } from "../schema.ts";
import { TEST_USER_EMAIL, TEST_USER_ID } from "../testing.ts";
import { createMessageRepository } from "./messages.ts";
import { createSessionRepository } from "./sessions.ts";

/**
 * append() 的并发正确性在真实 Postgres 上的验证。默认跳过，显式给了 DATABASE_URL 才跑：
 *
 *   docker compose up -d db
 *   pnpm --filter @petrel/database exec drizzle-kit migrate   # 首次建表
 *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
 *
 * 为什么非要一份真机测试：seq 不撞车靠的是 append() 里那条 FOR UPDATE，
 * 而 PGlite 是单后端 WASM Postgres，JS 侧并行发出去的语句会被排队串行执行——
 * 把那行锁删掉，全部 PGlite 用例照样全绿。一行锁被误删、CI 毫无反应、
 * 线上开始静默丢消息，是这个仓库里最坏的一类缺口。
 *
 * 并发必须落在多条连接上：getDb() 的 Pool 会让每个 db.transaction() 各自
 * pool.connect() 拿一条独立连接，这才是真并发；跑在单连接上等于又回到 PGlite。
 */
const SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ABSENT_SESSION_ID = "aaaaaaaa-0000-4000-8000-000000000002";

/** 取 12：高于 Pool 默认的 max=10，确保连接确实被抢占、事务真的在互相等锁 */
const CONCURRENCY = 12;

let repo: ReturnType<typeof createMessageRepository>;

describe.skipIf(!process.env.DATABASE_URL)("messageRepository（真实 Postgres）", () => {
  beforeAll(async () => {
    const db = getDb();
    repo = createMessageRepository(db);
    // 真实库里没有播种用户了，会话要挂在人身上，先把夹具用户建出来。
    // passwordHash 同 testing.ts：不合法的哈希格式，这个账号登不进来
    await db
      .insert(users)
      .values({ id: TEST_USER_ID, email: TEST_USER_EMAIL, passwordHash: "!" })
      .onConflictDoNothing();
    await createSessionRepository(db).upsert({
      id: SESSION_ID,
      userId: TEST_USER_ID,
      title: "并发集成测试",
    });
  });

  // 跑完把库恢复原状：删夹具用户，会话与消息靠外键级联一起走
  afterAll(async () => {
    await getDb().delete(users).where(eq(users.id, TEST_USER_ID));
    await closeDb();
  });

  it(`${CONCURRENCY} 路并发 append 同一会话，seq 连续无洞且一条不丢`, async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        repo.append({ sessionId: SESSION_ID, role: "user", message: { index } }),
      ),
    );

    // 用 toEqual([]) 而不是数个数：失败时 diff 里直接能看到是不是 23505
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);

    const seqs = (await repo.listBySession(SESSION_ID)).map((row) => row.seq);
    expect(seqs).toEqual(Array.from({ length: CONCURRENCY }, (_, index) => index + 1));
  });

  it("会话不存在时报外键错误，而不是静默跳过", async () => {
    const error = await repo.append({ sessionId: ABSENT_SESSION_ID, role: "user", message: {} }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // 锁不到会话行时 INSERT 仍然执行并撞上外键——不能变成写了个寂寞
    expect((error as { cause?: { code?: string } } | undefined)?.cause?.code).toBe("23503");
  });
});

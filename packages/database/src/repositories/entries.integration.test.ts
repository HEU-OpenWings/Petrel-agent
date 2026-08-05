import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../schema.ts";
import { createEntryRepository } from "./entries.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";
const ROOT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

/**
 * 默认跳过。跑法：
 *   docker compose up -d db
 *   pnpm --filter @petrel/database exec drizzle-kit migrate
 *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
 */
describe.skipIf(!DATABASE_URL)("createEntryRepository 并发（真实 Postgres）", () => {
  let pool: Pool;
  let repo: ReturnType<typeof createEntryRepository>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = createEntryRepository(drizzle(pool, { schema }));
  });
  afterAll(() => pool.end());

  beforeEach(async () => {
    const db = drizzle(pool, { schema });
    // 只清自己造的数据，不 TRUNCATE：这个库可能有开发者手动造的会话
    await db.execute(sql`DELETE FROM session_entries WHERE session_id = ${SESSION_ID}`);
    await db.execute(sql`DELETE FROM sessions WHERE id = ${SESSION_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_ID}, 'integration@example.com', '!')`,
    );
    await db.execute(
      sql`INSERT INTO sessions (id, user_id, title) VALUES (${SESSION_ID}, ${USER_ID}, 'integration')`,
    );
    await repo.append({
      id: ROOT_ID,
      sessionId: SESSION_ID,
      parentId: null,
      type: "message",
      payload: { message: { role: "user", content: [] } },
    });
  });

  it("12 路并发基于同一 leaf 追加，一条都不丢", async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `bbbbbbbb-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    );

    const results = await Promise.allSettled(
      ids.map((id) =>
        repo.append({
          id,
          sessionId: SESSION_ID,
          parentId: ROOT_ID,
          type: "message",
          payload: { message: { role: "assistant", content: [] } },
        }),
      ),
    );

    // 关键：全部成功。线性 seq 模型在这里会有一批撞唯一约束后静默丢失，
    // 树模型下并发的结果是同一个 parent 下分出多个子节点——数据不丢，只是分叉
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    const all = await repo.listAll(SESSION_ID);
    expect(all).toHaveLength(13);
    // entry_seq 严格递增，游标分页不会漏读
    const seqs = all.map((e) => e.entrySeq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("递归 CTE 在真实 Postgres 上与 PGlite 行为一致", async () => {
    const child = "bbbbbbbb-0000-0000-0000-0000000000ff";
    await repo.append({
      id: child,
      sessionId: SESSION_ID,
      parentId: ROOT_ID,
      type: "message",
      payload: { message: { role: "assistant", content: [] } },
    });

    const path = await repo.pathToRootOrCompaction(SESSION_ID, child);
    expect(path.map((e) => e.id)).toEqual([ROOT_ID, child]);
  });
});

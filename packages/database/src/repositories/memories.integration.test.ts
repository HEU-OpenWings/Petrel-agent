import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../schema.ts";
import { MEMORY_EMBEDDING_DIM } from "../schema.ts";
import { createMemoryRepository } from "./memories.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-0000-0000-0000000000cc";

/**
 * 默认跳过。跑法：
 *   docker compose up -d db
 *   pnpm --filter @petrel/database exec drizzle-kit migrate
 *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
 */
describe.skipIf(!DATABASE_URL)("记忆检索（真实 pgvector）", () => {
  let pool: Pool;
  let repo: ReturnType<typeof createMemoryRepository>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = createMemoryRepository(drizzle(pool, { schema }));
  });
  afterAll(() => pool.end());

  beforeEach(async () => {
    const db = drizzle(pool, { schema });
    // 只清自己造的数据，不 TRUNCATE：这个库可能有开发者手动造的数据
    await db.execute(sql`DELETE FROM user_memories WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_ID}, 'memory-integration@example.com', '!')`,
    );
  });

  function vectorOf(weights: Record<number, number>): number[] {
    const values = new Array<number>(MEMORY_EMBEDDING_DIM).fill(0);
    for (const [index, weight] of Object.entries(weights)) {
      values[Number(index)] = weight;
    }
    return values;
  }

  it("HNSW 索引下排序仍然正确", async () => {
    await repo.insert(USER_ID, {
      content: "正交",
      embedding: vectorOf({ 5: 1 }),
      sourceSessionId: null,
    });
    await repo.insert(USER_ID, {
      content: "一致",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    const hits = await repo.searchByEmbedding(USER_ID, vectorOf({ 0: 1 }), 10);

    expect(hits.map((hit) => hit.content)).toEqual(["一致", "正交"]);
  });
});

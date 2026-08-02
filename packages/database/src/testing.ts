import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";
import { DEFAULT_USER_ID, DEFAULT_USERNAME, messages, sessions, users } from "./schema.ts";

/** migration 目录是包内的相对位置，测试从仓库根跑，所以要解析成绝对路径 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 建一个跑在内存里的 Postgres 并跑完 migration。
 *
 * 用 PGlite 而不是 testcontainers：CI 不需要 Docker，而外键、级联、唯一约束、
 * 事务这些语义都是真的。
 *
 * 但建实例要数秒（不是当初设想的毫秒级），全量测试并行跑时每个用例建一个
 * 会把 beforeEach 拖超时。所以实例按测试文件复用，用例之间调 reset() 清表隔离。
 */
export async function createTestDb(): Promise<{
  db: TestDb;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db = drizzle({ client, schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  async function seedDefaultUser() {
    await db.insert(users).values({ id: DEFAULT_USER_ID, username: DEFAULT_USERNAME });
  }

  await seedDefaultUser();

  return {
    db,
    async reset() {
      // RESTART IDENTITY 顺带复位序列，让用例之间的自增值也互不影响
      await db.execute(sql`TRUNCATE ${users}, ${sessions}, ${messages} RESTART IDENTITY CASCADE`);
      await seedDefaultUser();
    },
    close: () => client.close(),
  };
}

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DEFAULT_USER_ID, DEFAULT_USERNAME, users } from "./schema.ts";
import * as schema from "./schema.ts";

/** migration 目录是包内的相对位置，测试从仓库根跑，所以要解析成绝对路径 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 建一个跑在内存里的 Postgres 并跑完 migration。
 *
 * 用 PGlite 而不是 testcontainers：毫秒级启动、每个用例一个干净实例、
 * CI 不需要 Docker，而外键、级联、唯一约束、事务这些语义都是真的。
 */
export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle({ client, schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(users).values({ id: DEFAULT_USER_ID, username: DEFAULT_USERNAME });

  return { db, close: () => client.close() };
}

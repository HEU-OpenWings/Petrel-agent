import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";
import { messages, sessions, users } from "./schema.ts";

/** migration 目录是包内的相对位置，测试从仓库根跑，所以要解析成绝对路径 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * 测试夹具用户。
 *
 * 数据层的测试需要一个能挂会话的用户，但建它不该依赖 apps/api 的注册流程
 * （那是反方向的依赖）。passwordHash 存 "!"：它不是合法的哈希格式，scrypt 校验
 * 必然失败，所以这个账号登不进来，不用于登录测试；
 * 需要真实登录的用例走 /api/auth/register。
 */
export const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
export const TEST_USER_EMAIL = "test@example.com";

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

  async function seedTestUser() {
    await db.insert(users).values({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      passwordHash: "!",
    });
  }

  await seedTestUser();

  return {
    db,
    async reset() {
      // CASCADE 是必需的：三张表之间有外键，单独 TRUNCATE users 会被拒绝。
      // RESTART IDENTITY 当前是空操作（本 schema 没有 serial/identity 列），
      // 留着是为了以后真加了自增列时不会漏掉复位
      await db.execute(sql`TRUNCATE ${users}, ${sessions}, ${messages} RESTART IDENTITY CASCADE`);
      await seedTestUser();
    },
    close: () => client.close(),
  };
}

import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./client.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * 启动时执行。失败就让进程退出——带着没建表的数据库启动，
 * 只会让每个请求都在运行时炸，不如启动时就失败得清楚。
 */
export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}

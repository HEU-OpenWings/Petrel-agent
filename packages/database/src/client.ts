import { env } from "@petrel/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

let pool: Pool | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** 连接池是进程级单例：每个请求新建连接会迅速耗尽 Postgres 的连接数 */
export function getDb() {
  if (!db) {
    pool = new Pool({ connectionString: env.databaseUrl });
    db = drizzle({ client: pool, schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

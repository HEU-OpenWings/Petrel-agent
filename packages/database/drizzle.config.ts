import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // generate 不需要连数据库，这里给占位值即可；
  // 真正的连接串在运行时由 @petrel/config 提供
  dbCredentials: { url: "postgres://petrel:petrel@localhost:5432/petrel" },
});

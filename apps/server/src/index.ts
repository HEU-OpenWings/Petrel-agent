import { serve } from "@hono/node-server";
import { initMcpTools, shutdownMcpTools } from "@petrel/agent";
import { env } from "@petrel/config";
import { runMigrations } from "@petrel/database";
import { logger } from "@petrel/logger";
import { app } from "./http/app.ts";

await runMigrations();
logger.info("database migrations applied");

// 连接 MCP server 并注册其工具。失败不阻断启动：server 不可用只是它的工具不出现。
try {
  await initMcpTools();
  logger.info("MCP tools initialized");
} catch (error) {
  logger.warn({ err: error }, "MCP tools initialization failed");
}

function gracefulShutdown() {
  shutdownMcpTools()
    .catch(() => {})
    .finally(() => process.exit(0));
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, ({ port }) => {
  logger.info({ port, nodeEnv: env.nodeEnv }, "agent-server listening");
});

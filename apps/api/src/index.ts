import { serve } from "@hono/node-server";
import { env } from "@petrel/config";
import { logger } from "@petrel/logger";
import { app } from "./http/app.ts";

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, ({ port }) => {
  logger.info({ port, nodeEnv: env.nodeEnv }, "agent-server listening");
});

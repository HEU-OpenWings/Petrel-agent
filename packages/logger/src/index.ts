import { env, isProduction } from "@petrel/config";
import type { MiddlewareHandler } from "hono";
import { pino } from "pino";

export const logger = pino({
  level: env.logLevel,
  transport: isProduction ? undefined : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
});

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    },
    "request",
  );
};

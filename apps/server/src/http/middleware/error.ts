import { logger } from "@petrel/logger";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { message: err.message } }, err.status);
  }
  logger.error({ err, path: c.req.path }, "unhandled error");
  return c.json({ error: { message: "Internal Server Error" } }, 500);
};

export const notFound: NotFoundHandler = (c) =>
  c.json({ error: { message: `Not Found: ${c.req.path}` } }, 404);

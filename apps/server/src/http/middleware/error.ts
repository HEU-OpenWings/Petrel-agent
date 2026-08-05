import { logger } from "@petrel/logger";
import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { QuotaError } from "../../services/quota.ts";

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { message: err.message } }, err.status);
  }
  // HEU-40 配额错误。exceeded → 429（带 Retry-After，若算得出）；unavailable → 503。
  // 与上面的 HTTPException 分支一样返回 {error:{message}} 形状。
  if (err instanceof QuotaError) {
    const status = err.kind === "exceeded" ? 429 : 503;
    const headers: Record<string, string> = {};
    // 算不出准确过期时间就不返回 Retry-After，不误导客户端
    if (err.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(err.retryAfterSeconds);
    }
    return c.json({ error: { message: err.message } }, status, headers);
  }
  logger.error({ err, path: c.req.path }, "unhandled error");
  return c.json({ error: { message: "Internal Server Error" } }, 500);
};

export const notFound: NotFoundHandler = (c) =>
  c.json({ error: { message: `Not Found: ${c.req.path}` } }, 404);

import { Hono } from "hono";

export const system = new Hono().get("/health", (c) =>
  c.json({ status: "ok", uptime: Math.round(process.uptime()) }),
);

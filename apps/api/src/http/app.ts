import { requestLogger } from "@petrel/logger";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { requireAdmin, requireAuth } from "./middleware/auth.ts";
import { notFound, onError } from "./middleware/error.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { chat } from "./routes/chat.ts";
import { sessions } from "./routes/sessions.ts";
import { system } from "./routes/system.ts";

export const app = new Hono<AppEnv>();

app.use(requestLogger);
app.onError(onError);
app.notFound(notFound);

// 后续路由挂载点：agents · knowledge · dashboard · eval
app.route("/api/system", system);
app.route("/api/auth", auth);
app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.use("/api/admin/*", requireAuth, requireAdmin);
app.route("/api/admin", admin);

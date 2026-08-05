import { requestLogger } from "@petrel/logger";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { requireAdmin, requireAuth } from "./middleware/auth.ts";
import { notFound, onError } from "./middleware/error.ts";
import { account } from "./routes/account.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { chat } from "./routes/chat.ts";
import { sessions } from "./routes/sessions.ts";
import { system } from "./routes/system.ts";

export const app = new Hono<AppEnv>();

app.use(requestLogger);
app.onError(onError);
app.notFound(notFound);

// 挂载顺序有安全含义：system 与 auth 在 requireAuth 之前，是仅有的两个公开前缀；
// 之后新增的业务路由挂在 requireAuth 之下就自动受保护，不会因为忘了加中间件而裸奔。
// routes/isolation.test.ts 有两条用例守着这个顺序，调整前先看那里
app.route("/api/system", system);
app.route("/api/auth", auth);

app.use("/api/*", requireAuth);

app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.route("/api/account", account);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", admin);

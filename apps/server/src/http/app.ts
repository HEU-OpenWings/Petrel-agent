import { requestLogger } from "@petrel/logger";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { requireAdmin, requireAuth } from "./middleware/auth.ts";
import { notFound, onError } from "./middleware/error.ts";
import { account } from "./routes/account.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { chat } from "./routes/chat.ts";
import { memories } from "./routes/memories.ts";
import { providers } from "./routes/providers.ts";
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

// Provider 响应包含当前凭据的实时状态；这层必须放在 requireAuth 前，
// 才能让未登录 401 也带 no-store。已认证的成功、错误和自然 404
// 还会由 providers 子路由的同名中间件防御性覆盖。
app.use("/api/providers/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.use("/api/*", requireAuth);

app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.route("/api/account", account);
// HEU-53/54：Settings「模型服务」的当前用户状态与凭据管理接口。
// 挂在 requireAuth 之下，isolation.test.ts 守着「无 cookie → 401」。
app.route("/api/providers", providers);
// 记忆管理。挂在 requireAuth 之下；isolation.test.ts 守着「无 cookie → 401」
app.route("/api/memories", memories);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", admin);

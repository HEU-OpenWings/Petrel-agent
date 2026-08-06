import { getConnInfo } from "@hono/node-server/conninfo";
import { env } from "@petrel/config";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { __resetAuthLimits, AuthError, getAuthService } from "../../services/auth.ts";
import { escapeHtml } from "../../services/html.ts";
import { createRateLimiter } from "../../services/rate-limit.ts";
import type { AppEnv } from "../../types.ts";
import { clearToken, issueToken, resolveUser } from "../middleware/auth.ts";

/**
 * 请求体是运行时的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 email；
 * 直接 body.email.trim() 会抛成 500——客户端错误报成服务器错误
 * （同 routes/sessions.ts 的 requireTitle）。
 */
function parseCredentials(body: unknown): { email: string; password: string } {
  const fields = body as { email?: unknown; password?: unknown } | null;

  if (typeof fields?.email !== "string" || typeof fields?.password !== "string") {
    throw new HTTPException(400, { message: "email 和 password 必须是字符串" });
  }

  return { email: fields.email, password: fields.password };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new HTTPException(400, { message: "请求体必须是 JSON" });
  });
}

/** AuthError 带着状态码，翻译成 HTTPException 交给 error 中间件统一出格式 */
function toHttpException(error: unknown): never {
  if (error instanceof AuthError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

/** 只把这几个字段吐给前端。createdAt 和 disabled 前端用不到 */
function publicView(user: { id: string; email: string; role: string }) {
  return { id: user.id, email: user.email, role: user.role };
}

/**
 * 客户端 IP：优先取 X-Forwarded-For 第一段（生产必须由反向代理写入，否则可伪造），
 * 回退到 socket 地址；app.request 的测试环境没有真实 socket，走 XFF。
 */
function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 注册限流按 IP（scrypt 每次 64MB，不挡住就是 CPU/内存炸弹）；单实例内存，多副本在风控 issue */
const registerLimiter = createRateLimiter(env.rateLimit.registerMax, env.rateLimit.registerWindowMs);

/** 测试专用：清空注册限流与 auth service 单例里的计数 */
export function __resetAuthRateLimits(): void {
  registerLimiter.reset();
  __resetAuthLimits();
}

/**
 * 忘记密码 / 重置密码的 HTML 表单页与 JSON API 共用同一对端点：
 * body 同时接受 JSON 与 application/x-www-form-urlencoded，响应按 Accept 给 JSON 或 HTML。
 */
async function readField(c: Context, name: string): Promise<string | undefined> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await readJson(c)) as Record<string, unknown> | null;
    const value = body?.[name];
    return typeof value === "string" ? value : undefined;
  }
  const form = await c.req.parseBody();
  const value = form[name];
  return typeof value === "string" ? value : undefined;
}

function wantsJson(c: Context): boolean {
  // Accept 没显式声明时，JSON 请求体本身就是「我要 JSON 响应」的信号：
  // 否则 curl / fetch 默认不带 Accept，429/400 会被转成 200 的 HTML 错误页
  if ((c.req.header("accept") ?? "").includes("application/json")) return true;
  return (c.req.header("content-type") ?? "").includes("application/json");
}

/** 后端渲染的最小页面：验证 / 忘记密码 / 重置密码的浏览器入口，SPA 页面留后续轮 */
const PAGE_STYLE = `<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f3f4f6; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; margin: 24px; padding: 32px; background: #fff;
    border-radius: 16px; box-shadow: 0 8px 24px rgba(0, 0, 0, .08); }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { color: #4b5563; line-height: 1.6; word-break: break-all; }
  label { display: block; margin: 16px 0 6px; font-weight: 600; font-size: 14px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; }
  button { width: 100%; margin-top: 20px; padding: 10px 12px; border: 0; border-radius: 8px;
    background: #2563eb; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  .error { padding: 12px; border-radius: 8px; background: #fef2f2; color: #b91c1c; }
  .ok { padding: 12px; border-radius: 8px; background: #f0fdf4; color: #166534; }
  a { color: #2563eb; }
</style>`;

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${PAGE_STYLE}</head><body><main>${inner}</main></body></html>`;
}

function verifyResultPage(ok: boolean, message: string): string {
  const title = ok ? "邮箱验证成功" : "邮箱验证失败";
  const box = ok ? `<p class="ok">${escapeHtml(message)}</p>` : `<p class="error">${escapeHtml(message)}</p>`;
  return page(
    title,
    `<h1>${title}</h1>${box}<p><a href="${escapeHtml(env.publicWebUrl)}/login">返回登录</a></p>`,
  );
}

function forgotFormPage(): string {
  return page(
    "忘记密码",
    `<h1>忘记密码</h1><p>输入注册邮箱，我们会发一封带重置链接的邮件。</p>
     <form method="post" action="/api/auth/forgot-password">
       <label for="email">邮箱</label>
       <input id="email" name="email" type="email" required autocomplete="email">
       <button type="submit">发送重置邮件</button>
     </form>
     <p><a href="${escapeHtml(env.publicWebUrl)}/login">返回登录</a></p>`,
  );
}

function forgotSentPage(): string {
  return page(
    "邮件已发送",
    `<h1>邮件已发送</h1><p class="ok">如果该邮箱已注册，重置邮件会很快送达，请查收（含垃圾箱）。</p>
     <p><a href="${escapeHtml(env.publicWebUrl)}/login">返回登录</a></p>`,
  );
}

function resetFormPage(token: string, error?: string): string {
  const alert = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return page(
    "重置密码",
    `<h1>重置密码</h1>${alert}
     <form method="post" action="/api/auth/reset-password">
       <input type="hidden" name="token" value="${escapeHtml(token)}">
       <label for="password">新密码（至少 8 位）</label>
       <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password">
       <button type="submit">设置新密码</button>
     </form>`,
  );
}

function resetResultPage(ok: boolean, message: string): string {
  const title = ok ? "密码已重置" : "重置失败";
  const box = ok ? `<p class="ok">${escapeHtml(message)}</p>` : `<p class="error">${escapeHtml(message)}</p>`;
  const action = ok
    ? `<p><a href="${escapeHtml(env.publicWebUrl)}/login">去登录</a></p>`
    : `<p><a href="/api/auth/forgot-password">重新申请重置链接</a></p>`;
  return page(title, `<h1>${title}</h1>${box}${action}`);
}

export const auth = new Hono<AppEnv>()
  .post("/register", async (c) => {
    if (!registerLimiter.hit(clientIp(c))) {
      throw new HTTPException(429, { message: "注册过于频繁，请稍后再试" });
    }

    const { email, password } = parseCredentials(await readJson(c));

    const user = await getAuthService().register(email, password).catch(toHttpException);
    // 不再自动登录：验证邮件发出前不种 cookie，否则「邮箱验证」形同虚设
    return c.json({ user: publicView(user), verificationSent: true }, 201);
  })

  .post("/login", async (c) => {
    const { email, password } = parseCredentials(await readJson(c));

    const user = await getAuthService().login(email, password).catch(toHttpException);
    await issueToken(c, user);

    return c.json({ user: publicView(user) });
  })

  .post("/logout", (c) => {
    clearToken(c);
    return c.json({ ok: true });
  })

  // me 挂在全局 requireAuth 之前（见 app.ts 的挂载顺序），所以自己校验一次。
  // 走的是同一个 resolveUser，禁用与过期的判定不会与中间件漂移
  .get("/me", async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      throw new HTTPException(401, { message: "未登录或登录已失效" });
    }
    return c.json({ user: publicView(user) });
  })

  // 验证链接从邮件里点进来，浏览器直接开这个 URL，返回渲染好的结果页
  .get("/verify-email", async (c) => {
    const token = c.req.query("token") ?? "";
    try {
      const user = await getAuthService().verifyEmail(token);
      return c.html(verifyResultPage(true, `${user.email} 已验证，现在可以登录了`));
    } catch (error) {
      if (error instanceof AuthError) {
        return c.html(verifyResultPage(false, error.message));
      }
      throw error;
    }
  })

  // 验证邮件丢了 / 过期时重发。恒 200 防枚举；限流按邮箱
  .post("/resend-verification", async (c) => {
    const email = await readField(c, "email");
    if (!email) {
      throw new HTTPException(400, { message: "email 必须是字符串" });
    }
    await getAuthService().resendVerification(email).catch(toHttpException);
    return c.json({ ok: true });
  })

  .get("/forgot-password", (c) => c.html(forgotFormPage()))

  .post("/forgot-password", async (c) => {
    const email = await readField(c, "email");
    if (!email) {
      if (wantsJson(c)) {
        throw new HTTPException(400, { message: "email 必须是字符串" });
      }
      return c.html(forgotFormPage());
    }

    try {
      await getAuthService().forgotPassword(email);
    } catch (error) {
      if (error instanceof AuthError && wantsJson(c)) {
        throw new HTTPException(error.status, { message: error.message });
      }
      if (error instanceof AuthError && !wantsJson(c)) {
        return c.html(resetResultPage(false, error.message));
      }
      throw error;
    }

    if (wantsJson(c)) return c.json({ ok: true });
    return c.html(forgotSentPage());
  })

  .get("/reset-password", async (c) => {
    const token = c.req.query("token") ?? "";
    const valid = await getAuthService().isResetTokenValid(token);
    if (!valid) {
      return c.html(resetResultPage(false, "重置链接无效或已过期，请重新申请"));
    }
    return c.html(resetFormPage(token));
  })

  .post("/reset-password", async (c) => {
    const token = (await readField(c, "token")) ?? "";
    const password = (await readField(c, "password")) ?? "";
    if (!token || !password) {
      if (wantsJson(c)) {
        throw new HTTPException(400, { message: "token 和 password 必须是字符串" });
      }
      return c.html(resetFormPage(token, "请输入新密码"));
    }

    try {
      await getAuthService().resetPassword(token, password);
    } catch (error) {
      if (error instanceof AuthError) {
        if (wantsJson(c)) {
          throw new HTTPException(error.status, { message: error.message });
        }
        // 链接本身无效就不要再给表单了；只是密码不合规则留在表单上提示
        if (error.message.includes("无效或已过期")) {
          return c.html(resetResultPage(false, error.message));
        }
        return c.html(resetFormPage(token, error.message));
      }
      throw error;
    }

    if (wantsJson(c)) return c.json({ ok: true });
    return c.html(resetResultPage(true, "密码已重置，请用新密码登录"));
  });

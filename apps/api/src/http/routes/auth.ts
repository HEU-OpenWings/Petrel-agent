import { getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AuthError, createAuthService } from "../../services/auth.ts";
import type { AppEnv } from "../../types.ts";
import { clearToken, issueToken, resolveUser } from "../middleware/auth.ts";

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 email，
 * 直接 body.email.trim() 会抛成 500——客户端错误报成服务端错误
 * （同 routes/sessions.ts 的 requireTitle）。
 */
function parseCredentials(body: unknown): { email: string; password: string } {
  const fields = body as { email?: unknown; password?: unknown } | null;

  if (typeof fields?.email !== "string" || typeof fields?.password !== "string") {
    throw new HTTPException(400, { message: "email 与 password 必须是字符串" });
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

/** 只把这三个字段吐给前端。createdAt 与 disabled 前端用不到 */
function publicView(user: { id: string; email: string; role: string }) {
  return { id: user.id, email: user.email, role: user.role };
}

let authService: ReturnType<typeof createAuthService> | undefined;

function getAuthService() {
  // 登录失败计数存在 service 实例内，整个应用必须复用同一个实例；
  // 惰性初始化保留「只导入 app 不连接数据库」的测试能力。
  authService ??= createAuthService(getDb());
  return authService;
}

export const auth = new Hono<AppEnv>()
  .post("/register", async (c) => {
    const { email, password } = parseCredentials(await readJson(c));

    const user = await getAuthService().register(email, password).catch(toHttpException);
    await issueToken(c, user);

    return c.json({ user: publicView(user) }, 201);
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
  });

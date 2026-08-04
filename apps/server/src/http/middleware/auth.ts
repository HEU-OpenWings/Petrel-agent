import { env, isProduction } from "@petrel/config";
import { createUserRepository, getDb, type PublicUser } from "@petrel/database";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { sign, verify } from "hono/jwt";
import type { AppEnv } from "../../types.ts";

export const COOKIE_NAME = "petrel_token";

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const ALGORITHM = "HS256";

/** 签发 token 并种 cookie。register 与 login 两个端点共用 */
export async function issueToken(
  c: Context,
  user: { id: string; email: string; role: string },
): Promise<void> {
  const token = await sign(
    {
      sub: user.id,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    },
    env.jwtSecret,
    ALGORITHM,
  );

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    // 本地 http://localhost 下设 Secure，浏览器会静默丢弃 cookie，
    // 表现为「登录接口返回 200 但下一个请求仍是未登录」
    secure: isProduction,
    path: "/",
    maxAge: TOKEN_TTL_SECONDS,
  });
}

export function clearToken(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

/**
 * 从 cookie 解出当前用户，解不出返回 undefined。
 *
 * requireAuth 与 /api/auth/me 共用这一份实现——两边各写一遍的话，
 * 「禁用用户要拒绝」这类规则很容易只在其中一条路径上生效。
 *
 * 验签之后还要查一次库：token 里的 role 只是签发那一刻的快照，
 * 而 admin 禁用一个滥用者必须立即生效，不能等对方的 token 自然过期。
 * 所以角色与禁用状态一律以库里为准，不信 payload 里的那份。
 */
export async function resolveUser(c: Context): Promise<PublicUser | undefined> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return undefined;

  let payload: Awaited<ReturnType<typeof verify>>;
  try {
    payload = await verify(token, env.jwtSecret, ALGORITHM);
  } catch {
    // 签名不对、格式不对、已过期都走这里。都是「没登录」，不是服务端错误
    return undefined;
  }

  if (typeof payload.sub !== "string") return undefined;

  const user = await createUserRepository(getDb()).findById(payload.sub);
  if (!user || user.disabled) return undefined;

  return user;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveUser(c);
  if (!user) {
    throw new HTTPException(401, { message: "未登录或登录已失效" });
  }
  c.set("currentUser", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("currentUser").role !== "admin") {
    throw new HTTPException(403, { message: "需要管理员权限" });
  }
  await next();
};

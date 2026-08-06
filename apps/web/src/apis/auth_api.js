/**
 * 认证接口。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：token 在 httpOnly cookie 里，
 * 同源请求浏览器会自动带上，前端不需要也拿不到它。
 */
import { get, post } from "@/apis/http";

/**
 * treatUnauthorizedAsRequestError：登录/注册失败后端返 401（凭据错误、账号被禁用），
 * 那是这次请求的业务结果，不是「登录失效」。不加这个标记会被 http.js 的全局 401
 * 分支截胡：错误文案被替换、多打一次 logout、还会把用户从 /login 推到
 * /login?redirect=/login（之后即使密码输对也会在守卫里打转）。
 */
export const registerApi = (email, password) =>
  post("/api/auth/register", { email, password }, { treatUnauthorizedAsRequestError: true });

export const loginApi = (email, password) =>
  post("/api/auth/login", { email, password }, { treatUnauthorizedAsRequestError: true });

export const logoutApi = () => post("/api/auth/logout", {});

/** skipUnauthorizedHandler：未登录时的 401 是预期结果，见 http.js 的 handleUnauthorized */
export const meApi = () => get("/api/auth/me", { skipUnauthorizedHandler: true });

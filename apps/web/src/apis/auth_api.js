/**
 * 认证接口。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：token 在 httpOnly cookie 里，
 * 同源请求浏览器会自动带上，前端不需要也拿不到它。
 */
import { get, post } from '@/apis/http'

export const registerApi = (email, password) => post('/api/auth/register', { email, password })

export const loginApi = (email, password) => post('/api/auth/login', { email, password })

export const logoutApi = () => post('/api/auth/logout', {})

/** skipUnauthorizedHandler：未登录时的 401 是预期结果，见 http.js 的 handleUnauthorized */
export const meApi = () => get('/api/auth/me', { skipUnauthorizedHandler: true })

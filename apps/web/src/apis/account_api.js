/**
 * 当前账号相关的接口：偏好读写与改密码。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：token 在 httpOnly cookie 里，
 * 同源请求浏览器会自动带上。
 */
import { get, post, put } from '@/apis/http'

/** 响应是 { preferences: { defaultModel, systemPrompt }, models: [...] } */
export function fetchPreferences() {
  return get('/api/account/preferences')
}

/**
 * 全量写入：两个字段都要传，null 表示「跟随系统默认」。
 * 显式列出字段而不是直传对象，免得把 store 里的其他状态（models / loaded）也发上去。
 */
export function savePreferences({ defaultModel, systemPrompt }) {
  return put('/api/account/preferences', { defaultModel, systemPrompt })
}

/**
 * treatUnauthorizedAsRequestError：旧密码不正确时后端返 401，那是这次请求的业务结果，
 * 不是「登录失效」。不加这个标记会被 http.js 的全局 401 分支截胡——
 * 用户输错一次旧密码就被 logout() 并踢到登录页。同 auth_api.js 的登录/注册。
 */
export function changePassword(currentPassword, newPassword) {
  return post(
    '/api/account/password',
    { currentPassword, newPassword },
    { treatUnauthorizedAsRequestError: true }
  )
}

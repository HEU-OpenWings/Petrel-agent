import { useUserStore } from '@/stores/user'

/**
 * v0.5 的 HTTP 封装。
 *
 * 与 base.js 的区别：不做 admin/superadmin 权限预检（那是 v0.4 的角色模型，
 * 等 HEU-7 定了认证范围再说），401 的跳转行为由外部注册而不是写死。
 */

let unauthorizedHandler = null

/** 由 main.js 在启动时注册。放在这里是为了让本模块对 router 零依赖，从而可测。 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler
}

/**
 * 401 的完整处理：登出 + 通知 handler + 给出错误。
 *
 * 三步是一个契约，只在这里定义一次。不走 request() 的链路（chat_api 的 SSE）
 * 也调它，否则文案与副作用会各写一份、各自演进而不被测试发现。
 * 返回 Error 而不是抛出，是为了让调用方的 throw 显式可见。
 *
 * skipUnauthorizedHandler 只给 /api/auth/me 用：启动时恢复登录态失败是「本来就
 * 没登录」，不是「登录失效」，这时不该通知 handler（它注册的跳转会把守卫算好的
 * ?redirect= 覆盖掉），去不去登录页交给路由守卫。它仍然会 logout()。
 *
 * 注意与 request() 的 treatUnauthorizedAsRequestError 区分：那个是「这次 401 根本
 * 不是登录失效」，压根不进本函数。
 */
export function handleUnauthorized({ skipUnauthorizedHandler = false } = {}) {
  // 不 await：调用方（含 handler 里的跳转）必须立刻看到未登录态，
  // logout() 是先同步清 user 再发请求的。
  // 依赖 /api/auth/logout 是公开路由（挂在 requireAuth 之前）：它一旦会返 401，这里就会自我递归
  useUserStore().logout()
  if (!skipUnauthorizedHandler) {
    unauthorizedHandler?.()
  }
  return new Error('登录已失效，请重新登录')
}

async function readErrorMessage(response) {
  try {
    const body = await response.json()
    return body?.error?.message ?? body?.detail ?? body?.message ?? ''
  } catch {
    return ''
  }
}

export async function request(url, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    responseType = 'json',
    skipUnauthorizedHandler = false,
    treatUnauthorizedAsRequestError = false
  } = options

  const isFormData = body instanceof FormData
  const finalHeaders = { ...headers }
  // FormData 必须让浏览器自己带 boundary，手动设 Content-Type 会让后端解析失败
  if (body !== undefined && !isFormData && finalHeaders['Content-Type'] === undefined) {
    finalHeaders['Content-Type'] = 'application/json'
  }

  let payload
  if (body !== undefined) {
    payload = isFormData ? body : JSON.stringify(body)
  }

  const response = await fetch(url, { method, headers: finalHeaders, body: payload, signal })

  // treatUnauthorizedAsRequestError：这个接口的 401 是请求自身的业务结果而不是
  // 「登录失效」——登录/注册凭据错误就是这样。此时既不该 logout()、也不该通知
  // handler（用户就在登录页，跳转会把 URL 变成 /login?redirect=/login），更不该把
  // 后端的「邮箱或密码不正确」换成「登录已失效」。直接落到下面的 !response.ok 分支。
  if (response.status === 401 && !treatUnauthorizedAsRequestError) {
    throw handleUnauthorized({ skipUnauthorizedHandler })
  }

  if (!response.ok) {
    throw new Error((await readErrorMessage(response)) || `请求失败（HTTP ${response.status}）`)
  }

  if (responseType === 'raw') return response
  if (responseType === 'text') return response.text()

  const contentType = response.headers.get('Content-Type') ?? ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

export const get = (url, options) => request(url, { ...options, method: 'GET' })
export const post = (url, body, options) => request(url, { ...options, method: 'POST', body })
export const put = (url, body, options) => request(url, { ...options, method: 'PUT', body })
export const del = (url, options) => request(url, { ...options, method: 'DELETE' })

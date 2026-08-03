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

async function readErrorMessage(response) {
  try {
    const body = await response.json()
    return body?.error?.message ?? body?.detail ?? body?.message ?? ''
  } catch {
    return ''
  }
}

export async function request(url, options = {}) {
  const { method = 'GET', body, headers = {}, signal, responseType = 'json' } = options

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

  if (response.status === 401) {
    // 依赖 /api/auth/logout 是公开路由（挂在 requireAuth 之前）：它一旦会返 401，这里就会自我递归
    useUserStore().logout()
    unauthorizedHandler?.()
    throw new Error('登录已失效，请重新登录')
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

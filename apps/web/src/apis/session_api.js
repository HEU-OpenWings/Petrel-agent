/**
 * 会话接口。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：前者带 JWT 注入与 401 处理，
 * 认证落地后不用再改这里。
 */
import { del, get, request } from '@/apis/http'

export function listSessions() {
  return get('/api/sessions').then((data) => data.sessions ?? [])
}

export function fetchMessages(sessionId) {
  return get(`/api/sessions/${sessionId}/messages`)
}

export function renameSession(sessionId, title) {
  return request(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { title } })
}

export function deleteSession(sessionId) {
  return del(`/api/sessions/${sessionId}`)
}

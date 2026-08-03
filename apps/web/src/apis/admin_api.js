/** admin 接口。401 由 http.js 统一处理，403 落到普通请求错误分支 */
import { get, request } from '@/apis/http'

export const listUsersApi = () => get('/api/admin/users')

export const setUserDisabledApi = (id, disabled) =>
  request(`/api/admin/users/${id}`, { method: 'PATCH', body: { disabled } })

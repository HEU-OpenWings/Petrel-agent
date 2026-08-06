/**
 * Provider 状态接口。
 *
 * R0 — 只读状态查询：
 *   GET /api/providers
 *   GET /api/providers/:id/models
 *   后端端点尚未实现时，ProvidersPanel 用 usePreferencesStore 做临时推导。
 *
 * R1 — 凭据管理（所有用户可直接在 UI 输入 API key，即时生效）：
 *   PUT    /api/providers/:id/credential
 *   DELETE /api/providers/:id/credential
 *   POST   /api/providers/:id/test
 *   后端实现后，前端无需推倒重做，只替换数据来源 + 接通这些写操作。
 */
import { del, get, post, put } from '@/apis/http'

// --------------- R0 只读 ---------------

/** GET /api/providers → { defaultProviderId, defaultModelId, providers: [...] } */
export function fetchProviders() {
  return get('/api/providers')
}

/** GET /api/providers/:id/models → { provider, credentialConfigured, catalog, models } */
export function fetchProviderModels(id) {
  return get(`/api/providers/${encodeURIComponent(id)}/models`)
}

// --------------- R1 凭据管理 ---------------

/**
 * PUT /api/providers/:id/credential
 * 创建或替换 API key。后端强制 test-before-save。
 * @param {string} id provider id
 * @param {string} apiKey 明文 key
 */
export function saveProviderCredential(id, apiKey) {
  return put(`/api/providers/${encodeURIComponent(id)}/credential`, { apiKey })
}

/**
 * DELETE /api/providers/:id/credential
 * 删除 DB 中的 key，回落到环境变量。
 * @param {string} id provider id
 */
export function deleteProviderCredential(id) {
  return del(`/api/providers/${encodeURIComponent(id)}/credential`)
}

/**
 * POST /api/providers/:id/test
 * 测试当前凭据或候选 key 是否有效。
 * @param {string} id provider id
 * @param {string} [candidateKey] 待测试的候选 key，不传则测试当前凭据
 */
export function testProviderCredential(id, candidateKey) {
  return post(`/api/providers/${encodeURIComponent(id)}/test`, candidateKey ? { apiKey: candidateKey } : undefined)
}

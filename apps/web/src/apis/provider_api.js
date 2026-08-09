/** Provider 状态与当前用户凭据管理接口。请求体不在此记录或持久化。 */
import { del, get, post, put } from "@/apis/http";

function providerPath(id) {
  return `/api/providers/${encodeURIComponent(id)}`;
}

/** GET /api/providers → { defaultProviderId, defaultModelId, providers: ProviderStatus[] } */
export function fetchProviders() {
  return get("/api/providers");
}

/** GET /api/providers/:id/models → { provider, configured, runtimeStatus, statusMessage, models } */
export function fetchProviderModels(id) {
  return get(`${providerPath(id)}/models`);
}

/** 保存或覆盖当前用户的 Provider API Key；保存本身不会访问上游。 */
export function saveProviderCredential(id, apiKey) {
  return put(`${providerPath(id)}/credential`, { apiKey });
}

/**
 * 测试 candidate / saved personal / ambient。
 * 必须用 hasOwn 区分 `{apiKey: ""}` 与 `{}`，不能 truthy 回退。
 */
export function testProviderCredential(id, input = {}) {
  const body = Object.hasOwn(input, "apiKey") ? { apiKey: input.apiKey } : {};
  return post(`${providerPath(id)}/test`, body);
}

/** 幂等删除当前用户的个人凭据。 */
export function deleteProviderCredential(id) {
  return del(`${providerPath(id)}/credential`);
}

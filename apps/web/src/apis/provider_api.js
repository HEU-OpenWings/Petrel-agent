/**
 * Provider 状态接口（R0 只读）。
 *
 * 后端端点见 docs/tech/heu53-provider-config-api.md：
 *   GET /api/providers                → { defaultProviderId, defaultModelId, providers: [...] }
 *   GET /api/providers/:id/models     → { provider, configured, runtimeStatus, statusMessage, models }
 *
 * 凭据管理（R1：在 UI 填 key 即时生效）不在本期范围——它要求 admin 权限、加密落库、
 * 审计与运行时改造，是独立的 issue。届时再加 saveProviderCredential /
 * testProviderCredential / deleteProviderCredential，且端点路径在 /api/admin/providers 下。
 */
import { get } from "@/apis/http";

/** GET /api/providers → { defaultProviderId, defaultModelId, providers: ProviderStatus[] } */
export function fetchProviders() {
  return get("/api/providers");
}

/** GET /api/providers/:id/models → { provider, configured, runtimeStatus, statusMessage, models } */
export function fetchProviderModels(id) {
  return get(`/api/providers/${encodeURIComponent(id)}/models`);
}

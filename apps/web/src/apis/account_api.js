/**
 * 当前账号相关的接口：偏好读写与改密码。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：token 在 httpOnly cookie 里，
 * 同源请求浏览器会自动带上。
 */
import { get, post, put } from "@/apis/http";

/** 响应是 { preferences: { defaultModel, systemPrompt }, models: [...] } */
export function fetchPreferences() {
  return get("/api/account/preferences");
}

/**
 * 全量写入：两个字段都要传，null 表示「跟随系统默认」。
 * 显式列出字段而不是直传对象，免得把 store 里的其他状态（models / loaded）也发上去。
 */
export function savePreferences({ defaultModel, systemPrompt }) {
  return put("/api/account/preferences", { defaultModel, systemPrompt });
}

export function changePassword(currentPassword, newPassword) {
  return post("/api/account/password", { currentPassword, newPassword });
}

/** 退出所有设备：后端自增 tokenVersion，所有已签发 token 立即失效（含当前这个） */
export function logoutAllDevices() {
  return post("/api/account/logout-all", {});
}

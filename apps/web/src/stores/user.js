import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { loginApi, logoutApi, meApi, registerApi } from "@/apis/auth_api";

/**
 * 用户状态。
 *
 * token 不在这里——它在 httpOnly cookie 里，JS 读不到也不需要读。
 * 代价是刷新页面后必须调一次 /api/auth/me 才知道自己是谁，见 main.js。
 */
export const useUserStore = defineStore("user", () => {
  const user = ref(null);

  const isLoggedIn = computed(() => user.value !== null);
  const isAdmin = computed(() => user.value?.role === "admin");
  /** 展示名取邮箱前缀，不单独落库 */
  const displayName = computed(() => user.value?.email?.split("@")[0] ?? "");

  async function login(email, password) {
    const data = await loginApi(email, password);
    user.value = data.user;
    return data.user;
  }

  async function register(email, password) {
    // 注册后不再自动登录：后端发出验证邮件、不种 cookie（见 auth 设计文档 2026-08-06）。
    // 由登录页提示「查收验证邮件」，用户验证后再登录
    return registerApi(email, password);
  }

  async function logout() {
    // 先同步清本地态：http.js 的 401 分支不 await 本函数，紧接着就跳转登录页，
    // 跳转发生的那一刻必须已经是未登录态，否则路由守卫会把人当成已登录再弹走
    user.value = null;
    try {
      await logoutApi();
    } catch {
      // 后端不可达时不阻断本地登出
    }
  }

  /**
   * 启动时恢复登录态。
   *
   * 注意副作用：未登录时 /api/auth/me 返 401，会被 http.js 的全局 401 分支拦截——
   * 先触发一次 logout()（多打一次 logout 请求，后端 logout 是公开路由，恒 200），
   * 再把错误抛给调用方。meApi 带了 skipUnauthorizedHandler，所以这里不会触发跳转，
   * 该不该跳登录页由路由守卫按 meta.requiresAuth 决定。
   */
  async function fetchMe() {
    const data = await meApi();
    user.value = data.user;
    return data.user;
  }

  return {
    user,
    isLoggedIn,
    isAdmin,
    displayName,
    login,
    register,
    logout,
    fetchMe,
  };
});

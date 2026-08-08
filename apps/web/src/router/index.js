import { createRouter, createWebHistory } from "vue-router";
import AppShell from "@/layouts/AppShell.vue";
import BlankLayout from "@/layouts/BlankLayout.vue";
import { useUserStore } from "@/stores/user";
import { safeRedirect } from "@/utils/redirect";

/**
 * meta 约定：
 * - workspace: true  该页需要右栏工作区
 * - title            中栏顶部工具条显示的标题
 * - requiresAuth     需要登录
 * - requiresAdmin    需要 admin 角色（同时要 requiresAuth）
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      name: "main",
      component: BlankLayout,
      children: [
        {
          path: "",
          name: "Home",
          component: () => import("../views/HomeView.vue"),
          meta: { keepAlive: true, requiresAuth: false },
        },
      ],
    },
    {
      path: "/login",
      name: "login",
      component: () => import("../views/LoginView.vue"),
      meta: { requiresAuth: false },
    },
    {
      path: "/agent",
      name: "AgentMain",
      component: AppShell,
      children: [
        {
          path: "",
          name: "Chat",
          component: () => import("../views/ChatView.vue"),
          meta: { requiresAuth: true, workspace: true, title: "新对话" },
        },
      ],
    },
    {
      path: "/admin",
      name: "admin",
      component: AppShell,
      children: [
        {
          path: "",
          name: "AdminUsers",
          component: () => import("../views/AdminView.vue"),
          meta: { requiresAuth: true, requiresAdmin: true, title: "用户管理" },
        },
      ],
    },
    {
      path: "/knowledge",
      name: "knowledge",
      component: AppShell,
      children: [
        {
          path: "",
          name: "KnowledgeList",
          component: () => import("../views/DataBaseView.vue"),
          meta: { keepAlive: true, requiresAuth: false, title: "知识库" },
        },
        {
          path: ":database_id",
          name: "KnowledgeDetail",
          component: () => import("../views/DataBaseInfoView.vue"),
          meta: { keepAlive: false, requiresAuth: false, title: "知识库" },
        },
      ],
    },
    {
      path: "/dashboard",
      name: "dashboard",
      component: AppShell,
      children: [
        {
          path: "",
          name: "DashboardComp",
          component: () => import("../views/DashboardView.vue"),
          meta: { keepAlive: false, requiresAuth: false, title: "Dashboard" },
        },
      ],
    },
    {
      path: "/eval",
      name: "eval",
      component: AppShell,
      children: [
        {
          path: "",
          name: "EvalComp",
          component: () => import("../views/EvalView.vue"),
          meta: { requiresAuth: false, title: "评测" },
        },
      ],
    },
    {
      path: "/:pathMatch(.*)*",
      name: "NotFound",
      component: () => import("../views/EmptyView.vue"),
      meta: { requiresAuth: false },
    },
  ],
});

/**
 * 认证守卫。
 *
 * requiresAdmin 分支不要恢复 v0.4 那一版：它会调 agentStore.initialize() 打
 * Python API，必然抛错——那样关掉认证的结果不是「不校验」而是「导航时报错」。
 */
router.beforeEach((to, _from, next) => {
  const userStore = useUserStore();

  if (to.meta.requiresAuth === true && !userStore.isLoggedIn) {
    next({ path: "/login", query: { redirect: to.fullPath } });
    return;
  }

  if (to.meta.requiresAdmin === true && !userStore.isAdmin) {
    next({ path: "/agent" });
    return;
  }

  // 已登录的人不该再看到登录页；如果 URL 上带着 redirect（被 401 踢过来时写的），
  // 就把人送回原目标，而不是一律扔到 /agent
  if (to.path === "/login" && userStore.isLoggedIn) {
    // 传字符串而不是 { path }：redirect 里是 fullPath，可能带 query / hash，
    // { path } 形式不会解析它们
    next(safeRedirect(to.query.redirect));
    return;
  }

  next();
});

export default router;

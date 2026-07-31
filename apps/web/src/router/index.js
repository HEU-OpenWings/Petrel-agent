import { createRouter, createWebHistory } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import BlankLayout from '@/layouts/BlankLayout.vue'

/**
 * meta 约定：
 * - workspace: true  该页需要右栏工作区
 * - title            中栏顶部工具条显示的标题
 * - requiresAuth     HEU-7 落地前一律 false，见文件末尾的守卫说明
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'main',
      component: BlankLayout,
      children: [
        {
          path: '',
          name: 'Home',
          component: () => import('../views/HomeView.vue'),
          meta: { keepAlive: true, requiresAuth: false }
        }
      ]
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/agent',
      name: 'AgentMain',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'Chat',
          component: () => import('../views/ChatView.vue'),
          meta: { requiresAuth: false, workspace: true, title: '新对话' }
        }
      ]
    },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'KnowledgeList',
          component: () => import('../views/DataBaseView.vue'),
          meta: { keepAlive: true, requiresAuth: false, title: '知识库' }
        },
        {
          path: ':database_id',
          name: 'KnowledgeDetail',
          component: () => import('../views/DataBaseInfoView.vue'),
          meta: { keepAlive: false, requiresAuth: false, title: '知识库' }
        }
      ]
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'DashboardComp',
          component: () => import('../views/DashboardView.vue'),
          meta: { keepAlive: false, requiresAuth: false, title: 'Dashboard' }
        }
      ]
    },
    {
      path: '/eval',
      name: 'eval',
      component: AppShell,
      children: [
        {
          path: '',
          name: 'EvalComp',
          component: () => import('../views/EvalView.vue'),
          meta: { requiresAuth: false, title: '评测' }
        }
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('../views/EmptyView.vue'),
      meta: { requiresAuth: false }
    }
  ]
})

/**
 * 认证守卫暂时关闭：agent-server 还没有任何认证接口（HEU-7 未做）。
 *
 * HEU-7 落地后要做的事：
 * 1. 给需要登录的路由把 meta.requiresAuth 改回 true
 * 2. 打开下面被注释的分支
 *
 * 原来的 requiresAdmin 分支已整段删除而不是注释保留：它会调
 * agentStore.initialize() 打 v0.4 的 Python API，必然抛错。留着它，
 * 关掉认证的结果不是「不校验」而是「导航时报错」。
 * 角色模型要等 HEU-7 定了范围再重写。
 */
router.beforeEach((to, from, next) => {
  // const userStore = useUserStore()
  // if (to.meta.requiresAuth === true && !userStore.isLoggedIn) {
  //   next({ path: '/login', query: { redirect: to.fullPath } })
  //   return
  // }
  next()
})

export default router

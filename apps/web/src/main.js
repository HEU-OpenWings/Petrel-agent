import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'

import Antd from 'ant-design-vue';
import 'ant-design-vue/dist/reset.css';
import '@/assets/css/main.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)

// 401 的跳转行为在这里接线，http.js 本身不依赖 router
import { setUnauthorizedHandler } from '@/apis/http'
setUnauthorizedHandler(() => {
  const redirect = router.currentRoute.value.fullPath
  router.push({ path: '/login', query: { redirect } })
})

// 恢复登录态必须在 app.use(router) 之前——分界是它而不是 mount()：
// vue-router 的 install() 里就会发起首次导航（currentRoute 还是 START_LOCATION 时
// 自己 push 一次）。放在后面，已登录用户刷新 /agent 时守卫会在 user 还是 null 时
// 判定未登录并重定向到 /login，等 fetchMe 填上 user 导航早已 resolve，救不回来。
// 未登录时 /api/auth/me 返回 401，http.js 会清状态并抛错（meApi 不触发跳转，
// 该不该去登录页交给路由守卫判断），这里吞掉即可。
// catch 同样吞掉后端不可达、5xx、响应解析失败——一律按匿名处理，不阻塞启动
import { useUserStore } from '@/stores/user'
try {
  await useUserStore().fetchMe()
} catch {
  // 未登录，保持匿名状态
}

app.use(router)
app.use(Antd)

// 预加载信息配置
import { useInfoStore } from '@/stores/info'
const infoStore = useInfoStore()
infoStore.loadInfoConfig()

app.mount('#app')

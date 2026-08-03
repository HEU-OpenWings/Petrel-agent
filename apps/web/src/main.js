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
app.use(router)
app.use(Antd)

// 401 的跳转行为在这里接线，http.js 本身不依赖 router
import { setUnauthorizedHandler } from '@/apis/http'
setUnauthorizedHandler(() => {
  const redirect = router.currentRoute.value.fullPath
  router.push({ path: '/login', query: { redirect } })
})

// 预加载信息配置
import { useInfoStore } from '@/stores/info'
const infoStore = useInfoStore()
infoStore.loadInfoConfig()

app.mount('#app')

// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserStore } from '@/stores/user'
import { apiGet } from './base.js'

vi.mock('ant-design-vue', () => ({
  message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
const { message } = await import('ant-design-vue')

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// jsdom 里给 window.location.href 赋值会报 navigation not implemented，
// 这里整体替换成普通对象，既隔离掉报错又能断言跳没跳
let locationStub

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  locationStub = { href: '/' }
  vi.stubGlobal('location', locationStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('apiRequest 的 401 分支', () => {
  it('公开接口（requiresAuth=false）收到 401 时按普通错误抛出，不登出也不跳转', async () => {
    // 真实触发场景：后端没有 /api/system/info 路由，请求落到全局 requireAuth 上返 401。
    // 一旦这里当成登录失效处理，硬跳转会整页重载，重载后 main.js 又发同一个请求 —— 死循环。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: '未认证' }, 401)))
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }

    await expect(apiGet('/api/system/info', {}, false)).rejects.toThrow('未认证')

    expect(message.error).not.toHaveBeenCalled()
    expect(userStore.user).not.toBeNull()
    expect(window.location.href).toBe('/')
  })

  it('需要认证的接口收到 401 时仍然弹提示、清状态并跳登录页', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: '无效令牌' }, 401))
      // 第二次是 401 分支里 logout() 顺带发出的 POST /api/auth/logout
      .mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }

    await expect(apiGet('/api/sessions')).rejects.toThrow('未授权，请先登录')

    expect(message.error).toHaveBeenCalledWith('认证失败，请重新登录')
    expect(userStore.user).toBeNull()
    vi.advanceTimersByTime(1500)
    expect(window.location.href).toBe('/login')
  })

  it('令牌过期的 401 用另一套文案', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: '令牌已过期' }, 401))
      .mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }

    await expect(apiGet('/api/sessions')).rejects.toThrow('未授权，请先登录')

    expect(message.error).toHaveBeenCalledWith('登录已过期，请重新登录')
  })
})

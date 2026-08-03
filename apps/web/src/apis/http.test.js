// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserStore } from '@/stores/user'
import { get, post, request, setUnauthorizedHandler } from './http.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setUnauthorizedHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('不注入 Authorization —— token 在 httpOnly cookie 里，JS 碰不到', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await get('/api/system/health')

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('对象 body 自动序列化并带 JSON Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await post('/api/chat', { message: '你好' })

    const init = fetchMock.mock.calls[0][1]
    expect(init.body).toBe('{"message":"你好"}')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('FormData 不设 Content-Type，交给浏览器加 boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const form = new FormData()
    form.append('file', 'x')
    await post('/api/upload', form)

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers['Content-Type']).toBeUndefined()
    expect(init.body).toBe(form)
  })

  it('401 时登出并触发未授权处理器', async () => {
    // mock 必须分两段：第一个响应是业务请求的 401，第二个是 401 分支里 logout()
    // 顺带发出的 POST /api/auth/logout。如果简化成「所有请求都返 401」，那次 logout
    // 请求也会撞进 401 分支再次调 logout()，测试里会无限递归。
    // 生产不会这样：/api/auth/logout 挂在 requireAuth 之前（apps/api/src/http/app.ts），永不返 401。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: '无效令牌' }, 401))
      .mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(get('/api/whatever')).rejects.toThrow('登录已失效，请重新登录')
    expect(handler).toHaveBeenCalledOnce()
    // 同步断言是有意的：logout() 必须在跳转登录页之前就把本地态清掉
    expect(userStore.user).toBeNull()
  })

  it('skipUnauthorizedHandler 时 401 仍登出但不通知 handler', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: '未登录' }, 401))
      .mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(get('/api/auth/me', { skipUnauthorizedHandler: true })).rejects.toThrow(
      '登录已失效，请重新登录'
    )
    // 启动时恢复登录态失败不该抢在守卫前面跳转，否则 ?redirect= 会被覆盖成 START_LOCATION
    expect(handler).not.toHaveBeenCalled()
    expect(userStore.user).toBeNull()
  })

  it('treatUnauthorizedAsRequestError 时 401 透出后端原文、不登出也不通知 handler', async () => {
    // 登录/注册失败走这条：后端 401 是「邮箱或密码不正确」，不是登录失效。
    // 单个 mock 就够——不该有第二次请求（不 logout）。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: '邮箱或密码不正确' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(
      post('/api/auth/login', { email: 'a@x.io' }, { treatUnauthorizedAsRequestError: true })
    ).rejects.toThrow('邮箱或密码不正确')
    // 通知 handler 会把用户从 /login 推到 /login?redirect=/login，之后即使密码输对也进不去
    expect(handler).not.toHaveBeenCalled()
    expect(userStore.user).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('非 2xx 时抛出后端给的错误文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: '知识库不存在' }, 404)))

    await expect(get('/api/kb/1')).rejects.toThrow('知识库不存在')
  })

  it('后端没给文案时回落到状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })))

    await expect(get('/api/whatever')).rejects.toThrow('请求失败（HTTP 502）')
  })

  it('非 JSON 响应返回文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('plain', { headers: { 'Content-Type': 'text/plain' } }))
    )

    await expect(request('/api/text')).resolves.toBe('plain')
  })
})

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
  it('没有 token 时不注入 Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await get('/api/system/health')

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('有 token 时注入 Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    useUserStore().token = 'abc123'

    await get('/api/whatever')

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer abc123')
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: '无效令牌' }, 401)))
    const userStore = useUserStore()
    userStore.token = 'expired'
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(get('/api/whatever')).rejects.toThrow('登录已失效，请重新登录')
    expect(userStore.token).toBe('')
    expect(handler).toHaveBeenCalledOnce()
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

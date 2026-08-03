import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setUnauthorizedHandler } from '@/apis/http'
import { useUserStore } from '@/stores/user'
import { streamChat } from './chat_api.js'

/** 造一个 SSE 响应；streamChat 走 response.body.getReader() 读流，所以必须有正文 */
function sseResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

const ONE_FRAME = 'event: agent\ndata: {"type":"agent_start"}\n\n'

beforeEach(() => {
  setActivePinia(createPinia())
  setUnauthorizedHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamChat', () => {
  it('请求体带上 sessionId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(ONE_FRAME))
    vi.stubGlobal('fetch', fetchMock)

    await streamChat(
      { message: '你好', sessionId: 'a3f1c2d4-0000-4000-8000-000000000001' },
      () => {}
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat')
    // 后端要求 sessionId 必填且是 UUID，漏传会被 400 挡下来，所以这里断到具体值
    expect(JSON.parse(init.body)).toEqual({
      message: '你好',
      sessionId: 'a3f1c2d4-0000-4000-8000-000000000001'
    })
  })

  it('systemPrompt 一并透传', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(ONE_FRAME))
    vi.stubGlobal('fetch', fetchMock)

    await streamChat(
      {
        message: '你好',
        sessionId: 'a3f1c2d4-0000-4000-8000-000000000001',
        systemPrompt: '你是助手'
      },
      () => {}
    )

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).systemPrompt).toBe('你是助手')
  })

  it('逐帧回调解析后的事件', async () => {
    const text =
      'event: agent\ndata: {"type":"agent_start"}\n\nevent: error\ndata: {"message":"炸了"}\n\n'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(text)))

    const frames = []
    await streamChat({ message: '你好', sessionId: 'sid' }, (frame) => frames.push(frame))

    expect(frames).toEqual([
      { event: 'agent', data: { type: 'agent_start' } },
      { event: 'error', data: { message: '炸了' } }
    ])
  })

  it('非 2xx 时抛出后端给的错误文案', async () => {
    const body = JSON.stringify({ error: { message: 'sessionId 必须是 UUID' } })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } })
        )
    )

    await expect(streamChat({ message: '你好' }, () => {})).rejects.toThrow('sessionId 必须是 UUID')
  })

  it('401 时登出、触发未授权处理器并抛登录失效', async () => {
    // 两段 mock：第一个是 /api/chat 的 401，第二个是 401 分支里 logout() 发的
    // POST /api/auth/logout（生产环境该路由挂在 requireAuth 之前，永不返 401）
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValue(
          new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
        )
    )
    const userStore = useUserStore()
    userStore.user = { id: '1', email: 'a@x.io', role: 'user' }
    const handler = vi.fn()
    setUnauthorizedHandler(handler)

    await expect(streamChat({ message: '你好', sessionId: 'sid' }, () => {})).rejects.toThrow(
      '登录已失效，请重新登录'
    )
    expect(handler).toHaveBeenCalledOnce()
    // 同步断言是有意的：跳转登录页之前本地态必须已经清掉
    expect(userStore.user).toBeNull()
  })
})

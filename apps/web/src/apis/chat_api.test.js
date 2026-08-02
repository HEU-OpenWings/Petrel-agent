import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from './chat_api.js'

/** 造一个 SSE 响应；streamChat 走 response.body.getReader() 读流，所以必须有正文 */
function sseResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

const ONE_FRAME = 'event: agent\ndata: {"type":"agent_start"}\n\n'

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
})

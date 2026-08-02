import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from '@/apis/chat_api'
import { useAgentStream } from './useAgentStream.js'

// 模块级替身：不改 useAgentStream 的结构就能拿到 streamChat 的入参
vi.mock('@/apis/chat_api', () => ({ streamChat: vi.fn() }))

/** 让 streamChat 替身按给定顺序回放 SSE 帧 */
function replay(frames) {
  streamChat.mockImplementation(async (_params, onFrame) => {
    for (const frame of frames) onFrame(frame)
  })
}

beforeEach(() => {
  streamChat.mockReset()
  streamChat.mockResolvedValue(undefined)
})

describe('send', () => {
  it('把 sessionId 透传给 streamChat', async () => {
    const stream = useAgentStream()

    await stream.send('你好', { sessionId: 'a3f1c2d4-0000-4000-8000-000000000001' })

    expect(streamChat).toHaveBeenCalledOnce()
    const params = streamChat.mock.calls[0][0]
    expect(params.message).toBe('你好')
    expect(params.sessionId).toBe('a3f1c2d4-0000-4000-8000-000000000001')
  })

  it('systemPrompt 与中断信号一并透传', async () => {
    const stream = useAgentStream()

    await stream.send('你好', { sessionId: 'sid', systemPrompt: '你是助手' })

    const params = streamChat.mock.calls[0][0]
    expect(params.systemPrompt).toBe('你是助手')
    expect(params.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('loadHistory', () => {
  const HISTORY = [
    { role: 'user', content: '上一轮问题' },
    { role: 'assistant', content: '上一轮回答' }
  ]

  it('用历史覆盖消息，并清空工具调用与错误', async () => {
    const stream = useAgentStream()
    // 先真跑一轮，让 toolCalls 和 error 都是脏的
    replay([
      {
        event: 'agent',
        data: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'now', args: {} }
      },
      { event: 'error', data: { message: '炸了' } }
    ])
    await stream.send('你好', { sessionId: 'sid' })
    expect(Object.keys(stream.toolCalls.value)).toHaveLength(1)
    expect(stream.error.value).toBe('炸了')

    stream.loadHistory(HISTORY)

    expect(stream.messages.value).toEqual(HISTORY)
    expect(stream.toolCalls.value).toEqual({})
    expect(stream.error.value).toBe('')
  })

  it('复制一份历史，不与调用方共享数组', () => {
    const stream = useAgentStream()

    stream.loadHistory(HISTORY)

    expect(stream.messages.value).not.toBe(HISTORY)
  })

  it('传非数组时退化成空数组', () => {
    const stream = useAgentStream()
    stream.loadHistory(HISTORY)

    stream.loadHistory(undefined)
    expect(stream.messages.value).toEqual([])

    stream.loadHistory(HISTORY)
    stream.loadHistory(null)
    expect(stream.messages.value).toEqual([])
  })

  it('灌入历史后新消息接在历史后面', async () => {
    const stream = useAgentStream()
    stream.loadHistory(HISTORY)
    // activeIndex 被重置成 -1，新一轮必须由 message_start 重新定位，
    // 否则 message_update 会覆盖掉历史里的某条
    replay([
      {
        event: 'agent',
        data: { type: 'message_start', message: { role: 'assistant', content: '' } }
      },
      {
        event: 'agent',
        data: { type: 'message_end', message: { role: 'assistant', content: '新回答' } }
      }
    ])

    await stream.send('再问一次', { sessionId: 'sid' })

    expect(stream.messages.value).toEqual([...HISTORY, { role: 'assistant', content: '新回答' }])
  })
})

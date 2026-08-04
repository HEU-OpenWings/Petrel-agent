import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abortChat, streamChat } from '@/apis/chat_api'
import { useAgentStream } from './useAgentStream.js'

// 模块级替身：不改 useAgentStream 的结构就能拿到 streamChat 的入参
vi.mock('@/apis/chat_api', () => ({ streamChat: vi.fn(), abortChat: vi.fn() }))

/** 让 streamChat 替身按给定顺序回放 SSE 帧 */
function replay(frames) {
  streamChat.mockImplementation(async (_params, onFrame) => {
    for (const frame of frames) onFrame(frame)
  })
}

/**
 * 造一条测试说了算的流：什么时候吐帧、什么时候结束都由用例决定。
 *
 * emit 前必须查 signal —— 真实的 streamChat 一旦被 abort，fetch 的 reader 就抛
 * AbortError 不再产出任何帧。不照着模拟的话，测的就不是 abort 的效果。
 */
function controllableStream() {
  const handle = {}
  streamChat.mockImplementation((params, onFrame) => {
    handle.emit = (frame) => {
      if (params.signal.aborted) return
      onFrame(frame)
    }
    return new Promise((resolve, reject) => {
      handle.close = resolve
      params.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  })
  return handle
}

/** 放空宏任务队列，让 send 的 catch / finally 跑完 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const HISTORY = [
  { role: 'user', content: '上一轮问题' },
  { role: 'assistant', content: '上一轮回答' }
]

beforeEach(() => {
  streamChat.mockReset()
  streamChat.mockResolvedValue(undefined)
  abortChat.mockReset()
  abortChat.mockResolvedValue(undefined)
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

  it('用户主动中断不算错误，不往界面上报', async () => {
    const aborted = new Error('The operation was aborted')
    aborted.name = 'AbortError'
    streamChat.mockRejectedValue(aborted)
    const stream = useAgentStream()

    await stream.send('你好', { sessionId: 'sid' })

    expect(stream.error.value).toBe('')
    expect(stream.running.value).toBe(false)
    expect(stream.canSend.value).toBe(true)
  })

  it('其它异常写进 error 供界面显示', async () => {
    streamChat.mockRejectedValue(new Error('sessionId 必须是 UUID'))
    const stream = useAgentStream()

    await stream.send('你好', { sessionId: 'bad' })

    expect(stream.error.value).toBe('sessionId 必须是 UUID')
    expect(stream.running.value).toBe(false)
  })
})

describe('loadHistory', () => {
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

  it('拷贝一份历史，调用方之后改自己的数组不会影响界面', () => {
    const stream = useAgentStream()
    const history = [{ role: 'user', content: '上一轮问题' }]

    stream.loadHistory(history)
    history.push({ role: 'assistant', content: '调用方后来自己追加的' })

    expect(stream.messages.value).toHaveLength(1)
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

  it('切会话时掐断上一轮，旧流的帧不落进新会话', async () => {
    const stream = useAgentStream()
    const flow = controllableStream()

    const pending = stream.send('会话A的问题', { sessionId: 'session-a' })
    await tick()
    expect(stream.running.value).toBe(true)

    stream.loadHistory([{ role: 'user', content: '会话B的历史' }])
    await tick()

    // 不中断的话旧请求还在飞，输入框会一直禁用着
    expect(stream.running.value).toBe(false)
    expect(stream.canSend.value).toBe(true)

    // 会话 A 的帧在切走之后才到（切会话时上一轮往往还在等首帧）
    flow.emit({
      event: 'agent',
      data: { type: 'message_start', message: { role: 'assistant', content: '会话A的回答' } }
    })
    flow.emit({
      event: 'agent',
      data: { type: 'tool_execution_start', toolCallId: 'tA', toolName: 'now', args: {} }
    })
    flow.emit({ event: 'error', data: { message: '会话A的错误' } })

    expect(stream.messages.value).toEqual([{ role: 'user', content: '会话B的历史' }])
    expect(stream.toolCalls.value).toEqual({})
    expect(stream.error.value).toBe('')

    flow.close()
    await pending
  })

  it('切会话只断本地接收，不调 abortChat 打断上一轮生成', async () => {
    const stream = useAgentStream()
    const flow = controllableStream()

    const pending = stream.send('会话A的问题', { sessionId: 'session-a' })
    await tick()

    stream.loadHistory([{ role: 'user', content: '会话B的历史' }])
    await tick()

    expect(abortChat).not.toHaveBeenCalled()

    flow.close()
    await pending
  })

  it('重置写入位置，迟到的 message_update 不会覆盖历史', async () => {
    const stream = useAgentStream()
    // 先跑完整一轮，message_start 会把写入位置指到第 0 条，activeIndex 就脏了
    replay([
      {
        event: 'agent',
        data: { type: 'message_start', message: { role: 'assistant', content: '会话A的回答' } }
      }
    ])
    await stream.send('会话A的问题', { sessionId: 'session-a' })
    expect(stream.messages.value).toHaveLength(1)

    stream.loadHistory(HISTORY)

    // 新一轮只有 message_update 没有 message_start：写入位置若没被重置成 -1，
    // 这一帧会盖掉历史的第 0 条
    replay([
      {
        event: 'agent',
        data: { type: 'message_update', message: { role: 'assistant', content: '迟到的增量' } }
      }
    ])
    await stream.send('会话B的问题', { sessionId: 'session-b' })

    expect(stream.messages.value).toEqual(HISTORY)
  })

  it('灌入历史后新消息接在历史后面', async () => {
    const stream = useAgentStream()
    stream.loadHistory(HISTORY)
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

describe('stop', () => {
  it('停止按钮要真的叫停：调 abortChat 带当前会话 id，再断本地接收', async () => {
    const stream = useAgentStream()
    const flow = controllableStream()

    const pending = stream.send('你好', { sessionId: 'session-a' })
    await tick()

    await stream.stop()

    expect(abortChat).toHaveBeenCalledOnce()
    expect(abortChat).toHaveBeenCalledWith('session-a')

    flow.close()
    await pending
    expect(stream.running.value).toBe(false)
  })
})

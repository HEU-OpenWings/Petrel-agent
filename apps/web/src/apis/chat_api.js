/**
 * agent-server 的对话接口。
 *
 * POST /api/chat 返回 SSE，事件体是 pi 的 AgentEvent 原样透传。
 * 因为需要 POST + 自定义请求头，这里用 fetch 读流，而不是 EventSource。
 */
import { handleUnauthorized } from '@/apis/http'

/** 把 SSE 帧文本解析为 { event, data }，data 解析失败时为 null。 */
function parseFrame(frame) {
  let event = 'message'
  const dataLines = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: null, raw }
  }
}

/**
 * 发起一次对话并逐帧回调。
 *
 * @param {{ message: string, sessionId: string, systemPrompt?: string, signal?: AbortSignal }} params
 * @param {(frame: { event: string, data: any }) => void} onFrame
 */
export async function streamChat({ message, sessionId, systemPrompt, signal }, onFrame) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, systemPrompt }),
    signal
  })

  if (!response.ok) {
    // 401 走 http.js 的同一份处理，否则登录失效时对话界面只会显示一条错误文案，
    // 不会跳登录页。放在解析错误体之前：那份文案这一支根本用不上
    if (response.status === 401) {
      throw handleUnauthorized()
    }

    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error?.message ?? ''
    } catch {
      detail = await response.text().catch(() => '')
    }

    throw new Error(detail || `请求失败（HTTP ${response.status}）`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseFrame(frame)
      if (parsed) onFrame(parsed)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/**
 * 停止正在进行的一轮对话。
 *
 * 后端的 harness 是常驻的，关闭 SSE 连接只会断开推送、不会停止生成
 * （这是有意的：关页面不再丢回答），所以停止必须走一个显式接口。
 */
export async function abortChat(sessionId) {
  const response = await fetch('/api/chat/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })

  if (!response.ok) {
    if (response.status === 401) {
      throw handleUnauthorized()
    }
    throw new Error(`停止失败（HTTP ${response.status}）`)
  }
}

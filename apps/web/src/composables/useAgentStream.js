import { computed, ref, shallowRef } from 'vue'
import { abortChat, streamChat } from '@/apis/chat_api'

/**
 * 把 pi 的 AgentEvent 序列归约为消息状态。
 *
 * 整个对话界面的唯一状态来源：组件只做渲染，不参与事件拼接。
 * 消息结构直接沿用 pi 的 AgentMessage（role: user / assistant / toolResult），
 * 不再自己定义一套中间格式。
 */
export function useAgentStream() {
  /** @type {import('vue').Ref<any[]>} */
  const messages = ref([])
  /** toolCallId -> { state: 'running' | 'done' | 'error', args, result, ms } */
  const toolCalls = ref({})
  const running = ref(false)
  const error = ref('')
  /** 正在压缩上下文。压缩发生在回答开始之前，所以要独立于 running 显示 */
  const compacting = ref(false)
  /**
   * 压缩标记。atIndex 记的是压缩发生那一刻 messages 的长度，渲染时插在该下标之前。
   *
   * 这些标记只活在内存里、不落库：刷新页面就没了，而历史消息一条不少。
   * 这是有意的——压缩是模型侧的事，用户侧的 transcript 本来就完整。
   */
  const compactions = ref([])
  const controller = shallowRef(null)
  /** 当前这一轮的会话 id。stop() 要用它调后端接口，而 send 之外没有别的地方知道它。
   * 只在这一轮生成期间有效，send() 收尾时会清空，避免被后续误用于对错会话调 abortChat */
  const activeSessionId = ref(null)
  /** 当前正在流式写入的消息下标，由 message_start 确定 */
  let activeIndex = -1

  const canSend = computed(() => !running.value)

  function reset() {
    messages.value = []
    toolCalls.value = {}
    error.value = ''
    compactions.value = []
    activeIndex = -1
  }

  /** 切换会话时把历史消息灌进来。归约逻辑不参与，直接覆盖整个数组。 */
  function loadHistory(history) {
    // 只断开本地接收：切走会话不等于要停止上一轮生成，harness 是常驻的，
    // 上一个会话的回答会在服务端继续跑完并落库，用户切回来能看到完整结果。
    // 不断开的话旧流的消息、工具调用、错误文案会继续写进新会话的界面，
    // running 也会一直卡在 true 让输入框禁用
    disconnect()
    messages.value = Array.isArray(history) ? [...history] : []
    toolCalls.value = {}
    error.value = ''
    // 同样的道理：不清的话上一个会话的压缩分隔线会残留到这个会话的列表里
    compactions.value = []
    activeIndex = -1
  }

  /** message_start / message_update / message_end 都带完整或部分消息，按下标覆盖即可。 */
  function upsertMessage(index, message) {
    if (index < 0) return
    const next = messages.value.slice()
    next[index] = message
    messages.value = next
  }

  function apply(event) {
    switch (event.type) {
      case 'agent_start':
        error.value = ''
        break

      case 'message_start':
        activeIndex = messages.value.length
        messages.value = [...messages.value, event.message]
        break

      case 'message_update':
      case 'message_end':
        // message_update / message_end 都带完整的（部分）消息，覆盖即可，不用自己拼 delta
        upsertMessage(activeIndex, event.message)
        break

      case 'tool_execution_start':
        toolCalls.value = {
          ...toolCalls.value,
          [event.toolCallId]: {
            state: 'running',
            name: event.toolName,
            args: event.args,
            startedAt: performance.now()
          }
        }
        break

      case 'tool_execution_end': {
        const previous = toolCalls.value[event.toolCallId] ?? {}
        toolCalls.value = {
          ...toolCalls.value,
          [event.toolCallId]: {
            ...previous,
            // isError 在事件顶层，不在 result 里
            state: event.isError ? 'error' : 'done',
            result: event.result,
            ms: previous.startedAt ? Math.round(performance.now() - previous.startedAt) : undefined
          }
        }
        break
      }

      default:
        break
    }
  }

  async function send(message, options = {}) {
    if (running.value || !message.trim()) return
    running.value = true
    error.value = ''
    controller.value = new AbortController()
    activeSessionId.value = options.sessionId

    try {
      await streamChat(
        {
          message,
          sessionId: options.sessionId,
          systemPrompt: options.systemPrompt,
          model: options.model,
          signal: controller.value.signal
        },
        (frame) => {
          if (frame.event === 'error') {
            error.value = frame.data?.message ?? '服务端返回未知错误'
            return
          }
          if (frame.event === 'compaction' && frame.data) {
            if (frame.data.phase === 'start') {
              compacting.value = true
              return
            }
            if (frame.data.phase === 'blocked') {
              error.value = '上下文已超过压缩阈值，但自动压缩暂时不可用，建议新建会话继续'
              return
            }
            // phase === 'end'
            compacting.value = false
            if (frame.data.outcome?.kind === 'compacted') {
              compactions.value.push({
                atIndex: messages.value.length,
                tokensBefore: frame.data.outcome.tokensBefore,
                tokensAfter: frame.data.outcome.tokensAfter
              })
            }
            return
          }
          if (frame.event === 'agent' && frame.data) {
            apply(frame.data)
          }
        }
      )
    } catch (err) {
      if (err.name !== 'AbortError') {
        error.value = err.message
      }
    } finally {
      running.value = false
      compacting.value = false
      controller.value = null
      // 这一轮已经结束（无论正常收尾还是被中断），activeSessionId 不再对应
      // 任何还在跑的生成，清掉以免被后续误用于对着别的会话调 abortChat
      activeSessionId.value = null
    }
  }

  /**
   * 只断开本地接收，不影响服务端的生成。
   *
   * 给「用户只是切走看别的会话/开新会话」的场景用：harness 是常驻的，
   * 断开 SSE 只是不再接收推送，上一轮生成会继续跑完并落库。
   */
  function disconnect() {
    controller.value?.abort()
  }

  /**
   * 真正停止生成（停止按钮用）。
   *
   * 两件事都要做：先调后端接口让 agent 真的停下（harness 是常驻的，
   * 断开 SSE 只是不再接收推送，生成会一直跑完），再断开本地读取。
   * 顺序不能反：先断流会让下面那次 await 处在组件收尾流程里，容易被跳过。
   */
  async function stop() {
    try {
      if (activeSessionId.value) {
        await abortChat(activeSessionId.value)
      }
    } finally {
      disconnect()
    }
  }

  return {
    messages,
    toolCalls,
    running,
    error,
    canSend,
    compacting,
    compactions,
    send,
    stop,
    disconnect,
    reset,
    loadHistory
  }
}

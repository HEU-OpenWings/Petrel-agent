import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 右栏展示什么。
 *
 * 存的是工具调用的完整快照而不是一个 id：右栏的 WorkspacePanel 与产生数据的
 * ChatView 是兄弟组件，provide/inject 传不过去，而把 useAgentStream 改成单例
 * 又会动到已验证过的归约层。由 ToolCallBlock 写入快照是代价最小的做法。
 *
 * @typedef {{ id: string, name: string, state: string, args: unknown, result: unknown, ms?: number }} ToolCallSnapshot
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const activeToolCall = ref(null)

  const activeToolCallId = computed(() => activeToolCall.value?.id ?? null)

  /** @param {ToolCallSnapshot} snapshot */
  function openToolCall(snapshot) {
    activeToolCall.value = snapshot
  }

  /** 工具还在执行时后续状态会变，只同步当前选中的那一个 */
  function syncToolCall(snapshot) {
    if (!activeToolCall.value || activeToolCall.value.id !== snapshot.id) return
    activeToolCall.value = snapshot
  }

  function clear() {
    activeToolCall.value = null
  }

  return { activeToolCall, activeToolCallId, openToolCall, syncToolCall, clear }
})

<template>
  <div class="tool-call" :class="state">
    <div class="summary-row">
      <button class="summary" type="button" @click="expanded = !expanded">
        <ChevronRight class="chevron" :class="{ open: expanded }" :size="14" />
        <span class="name">{{ toolCall.name }}</span>
        <span class="dot">·</span>
        <span class="state-text">{{ stateText }}</span>
        <template v-if="detail.ms !== undefined">
          <span class="dot">·</span>
          <span class="ms">{{ detail.ms }}ms</span>
        </template>
      </button>

      <button class="icon-btn send" type="button" title="在工作区查看" @click="sendToWorkspace">
        <ArrowUpRight :size="14" />
      </button>
    </div>

    <div v-if="expanded" class="detail">
      <div class="section">
        <div class="label">参数</div>
        <pre>{{ formattedArgs }}</pre>
      </div>
      <div v-if="resultText" class="section">
        <div class="label">结果</div>
        <pre>{{ resultText }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ArrowUpRight, ChevronRight } from 'lucide-vue-next'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from '@/utils/toolCall'

const props = defineProps({
  /** pi 的 toolCall content block：{ id, name, arguments } */
  toolCall: { type: Object, required: true },
  /** useAgentStream 里由 tool_execution_* 事件归约出的执行状态 */
  detail: { type: Object, default: () => ({}) }
})

const expanded = ref(false)
const layout = useLayoutStore()
const workspace = useWorkspaceStore()

const state = computed(() => props.detail.state ?? 'pending')
const stateText = computed(() => TOOL_STATE_TEXT[state.value])
// detail.args 来自 tool_execution_start 事件，工具还没开始执行时退回 content block 里的参数
const args = computed(() => props.detail.args ?? props.toolCall.arguments)
const formattedArgs = computed(() => formatToolArgs(args.value))
const resultText = computed(() => extractToolResultText(props.detail.result))

/** 右栏与本组件是兄弟关系，注入不到，只能把完整快照写进 store */
function snapshot() {
  return {
    id: props.toolCall.id,
    name: props.toolCall.name,
    state: state.value,
    args: args.value,
    result: props.detail.result,
    ms: props.detail.ms
  }
}

// 右栏折叠时也要能送过去，否则用户点了没有任何反馈
function sendToWorkspace() {
  workspace.openToolCall(snapshot())
  layout.expandRight()
}

// 工具执行中就被送到右栏时，后续的状态与结果要跟着更新，
// 否则右栏会一直停在「执行中」
watch(
  () => props.detail,
  () => {
    if (workspace.activeToolCallId === props.toolCall.id) {
      workspace.syncToolCall(snapshot())
    }
  },
  { deep: true }
)
</script>

<style lang="less" scoped>
// 从带边框的卡片降为一行低调摘要：工具调用是过程信息，不该和回答内容抢注意力
.tool-call {
  margin: 4px 0;
  font-size: 13px;
}

.summary-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }

  // 送右栏的入口只在 hover 时出现，避免每一行都挂一个常驻图标
  .send {
    opacity: 0;
  }

  &:hover .send {
    opacity: 1;
  }
}

.summary {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 4px 6px;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.chevron {
  flex-shrink: 0;
  transition: transform 0.15s;

  &.open {
    transform: rotate(90deg);
  }
}

.name {
  color: var(--text-strong);
  font-family: monospace;
}

.dot {
  color: var(--text-faint);
}

.running .state-text {
  color: var(--main-color);
}

.error .state-text {
  color: var(--color-error-500);
}

.ms {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.detail {
  padding: 4px 6px 8px 24px;
}

.section + .section {
  margin-top: 8px;
}

.label {
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 12px;
}

pre {
  margin: 0;
  max-height: 240px;
  padding: 8px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

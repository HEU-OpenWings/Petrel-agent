<template>
  <div class="tool-call" :class="state">
    <button class="summary" type="button" @click="expanded = !expanded">
      <ChevronRight class="chevron" :class="{ open: expanded }" :size="14" />
      <Wrench :size="14" />
      <span class="name">{{ toolCall.name }}</span>
      <span class="state-text">{{ stateText }}</span>
      <span v-if="detail.ms !== undefined" class="ms">{{ detail.ms }}ms</span>
    </button>

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
import { computed, ref } from 'vue'
import { ChevronRight, Wrench } from 'lucide-vue-next'

const props = defineProps({
  /** pi 的 toolCall content block：{ id, name, arguments } */
  toolCall: { type: Object, required: true },
  /** useAgentStream 里由 tool_execution_* 事件归约出的执行状态 */
  detail: { type: Object, default: () => ({}) }
})

const expanded = ref(false)

const state = computed(() => props.detail.state ?? 'pending')

const stateText = computed(
  () => ({ running: '执行中', done: '完成', error: '失败', pending: '待执行' })[state.value]
)

const formattedArgs = computed(() => {
  const args = props.detail.args ?? props.toolCall.arguments
  if (args === undefined || args === null) return '(无)'
  return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
})

const resultText = computed(() => {
  const result = props.detail.result
  if (!result) return ''
  // pi 的工具结果是 content block 数组，取其中的文本
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return text || JSON.stringify(result, null, 2)
})
</script>

<style lang="less" scoped>
.tool-call {
  margin: 8px 0;
  border: 1px solid var(--gray-200);
  border-radius: 6px;
  background: var(--gray-25);
  font-size: 13px;

  &.error {
    border-color: #e8a3a3;
  }
}

.summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  color: var(--gray-700);
  cursor: pointer;
  text-align: left;
}

.chevron {
  transition: transform 0.15s;
  flex-shrink: 0;

  &.open {
    transform: rotate(90deg);
  }
}

.name {
  font-family: monospace;
  color: var(--gray-1000);
}

.state-text {
  color: var(--gray-500);
}

.running .state-text {
  color: var(--main-color);
}

.error .state-text {
  color: #c04a4a;
}

.ms {
  margin-left: auto;
  color: var(--gray-400);
  font-variant-numeric: tabular-nums;
}

.detail {
  padding: 0 10px 10px;
  border-top: 1px solid var(--gray-150);
}

.section {
  margin-top: 8px;
}

.label {
  margin-bottom: 4px;
  color: var(--gray-500);
  font-size: 12px;
}

pre {
  margin: 0;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  border-radius: 4px;
  background: var(--gray-100);
  color: var(--gray-900);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

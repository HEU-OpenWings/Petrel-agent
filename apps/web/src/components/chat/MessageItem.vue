<template>
  <!-- toolResult 消息不单独渲染，结果已并入对应的 ToolCallBlock -->
  <div v-if="message.role !== 'toolResult'" class="message" :class="message.role">
    <div class="body">
      <template v-for="(block, index) in blocks" :key="index">
        <div v-if="block.type === 'thinking'" class="thinking">
          <button class="line-toggle" type="button" @click="showThinking = !showThinking">
            <Brain :size="14" />
            <span>思考过程</span>
            <ChevronRight class="chevron" :class="{ open: showThinking }" :size="14" />
          </button>
          <pre v-if="showThinking" class="thinking-body">{{ block.thinking }}</pre>
        </div>

        <ToolCallBlock
          v-else-if="block.type === 'toolCall'"
          :tool-call="block"
          :detail="toolCalls[block.id] ?? {}"
        />

        <MdPreview
          v-else-if="block.type === 'text' && block.text"
          :editor-id="`msg-${editorId}-${index}`"
          :model-value="block.text"
          :theme="theme"
          preview-theme="github"
          :show-code-row-number="false"
          class="markdown"
        />
      </template>

      <!-- 模型调用失败时 pi 不发 error 帧，而是把原因放在消息的 errorMessage 上 -->
      <div v-if="message.errorMessage" class="message-error">
        <TriangleAlert :size="14" />
        <span>{{ message.errorMessage }}</span>
      </div>

      <span v-if="streaming" class="cursor" />
    </div>

    <div v-if="message.role === 'assistant' && !streaming" class="actions">
      <button class="icon-btn" type="button" :title="copied ? '已复制' : '复制'" @click="copy">
        <Check v-if="copied" :size="14" />
        <Copy v-else :size="14" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Brain, Check, ChevronRight, Copy, TriangleAlert } from 'lucide-vue-next'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/preview.css'
import { useThemeStore } from '@/stores/theme'
import ToolCallBlock from './ToolCallBlock.vue'

const props = defineProps({
  /** pi 的 AgentMessage */
  message: { type: Object, required: true },
  toolCalls: { type: Object, default: () => ({}) },
  streaming: { type: Boolean, default: false },
  editorId: { type: [String, Number], default: 0 }
})

const showThinking = ref(false)
const copied = ref(false)
const themeStore = useThemeStore()
const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

/** pi 的 content 可能是字符串（用户输入）或 content block 数组 */
const blocks = computed(() => {
  const content = props.message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
})

const plainText = computed(() =>
  blocks.value
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
)

async function copy() {
  try {
    await navigator.clipboard.writeText(plainText.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // http 环境下 clipboard 不可用，静默失败好过弹一个用户无法处理的错误
  }
}
</script>

<style lang="less" scoped>
.message {
  padding: 12px 0;
}

// 用户消息右对齐成气泡，助手消息全宽无气泡——这是两者最直观的区分方式，
// 比加角色标签更省视觉噪音
.user {
  display: flex;
  justify-content: flex-end;

  .body {
    max-width: 70%;
    padding: 10px 14px;
    border-radius: 18px;
    background: var(--surface-subtle);
    color: var(--text-strong);
    white-space: pre-wrap;
    word-break: break-word;
  }
}

.assistant .body {
  color: var(--text-strong);
}

.thinking {
  margin: 4px 0 8px;
}

.line-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.chevron {
  transition: transform 0.15s;

  &.open {
    transform: rotate(90deg);
  }
}

.thinking-body {
  margin: 4px 0 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-muted);
  font-size: 12px;
  white-space: pre-wrap;
}

.markdown {
  background: transparent;

  :deep(.md-editor-preview-wrapper) {
    padding: 0;
  }
}

.message-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--color-error-50);
  color: var(--color-error-700);
  font-size: 13px;
  word-break: break-word;
}

.actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.cursor {
  display: inline-block;
  width: 2px;
  height: 15px;
  vertical-align: text-bottom;
  background: var(--main-color);
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>

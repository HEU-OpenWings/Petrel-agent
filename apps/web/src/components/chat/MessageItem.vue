<template>
  <!-- toolResult 消息不单独渲染，结果已并入对应的 ToolCallBlock -->
  <div v-if="message.role !== 'toolResult'" class="message" :class="message.role">
    <div class="role">{{ message.role === 'user' ? '你' : 'Petrel' }}</div>

    <div class="body">
      <template v-for="(block, index) in blocks" :key="index">
        <div v-if="block.type === 'thinking'" class="thinking">
          <button class="thinking-toggle" type="button" @click="showThinking = !showThinking">
            <Brain :size="14" />
            <span>思考过程</span>
            <ChevronRight class="chevron" :class="{ open: showThinking }" :size="14" />
          </button>
          <pre v-if="showThinking">{{ block.thinking }}</pre>
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
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Brain, ChevronRight, TriangleAlert } from 'lucide-vue-next'
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
const themeStore = useThemeStore()
const theme = computed(() => (themeStore.isDark ? 'dark' : 'light'))

/** pi 的 content 可能是字符串（用户输入）或 content block 数组 */
const blocks = computed(() => {
  const content = props.message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
})
</script>

<style lang="less" scoped>
.message {
  padding: 12px 0;

  & + .message {
    border-top: 1px solid var(--gray-100);
  }
}

.role {
  margin-bottom: 4px;
  color: var(--gray-500);
  font-size: 12px;
}

.user .body {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--gray-1000);
}

.thinking {
  margin: 4px 0 8px;
}

.thinking-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border: none;
  background: none;
  color: var(--gray-500);
  font-size: 12px;
  cursor: pointer;
}

.chevron {
  transition: transform 0.15s;

  &.open {
    transform: rotate(90deg);
  }
}

.thinking pre {
  margin: 4px 0 0;
  padding: 8px;
  border-radius: 4px;
  background: var(--gray-50);
  color: var(--gray-600);
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
  border: 1px solid #e8a3a3;
  border-radius: 6px;
  background: #fdf5f5;
  color: #c04a4a;
  font-size: 13px;
  word-break: break-word;
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

<template>
  <!-- toolResult 消息不单独渲染，结果已并入对应的 ToolCallBlock -->
  <div v-if="message.role !== 'toolResult'" class="message-row" :class="message.role">
    <div class="message-box" :class="message.role">
      <!-- 用户消息 -->
      <template v-if="message.role === 'user'">
        <div
          class="message-copy-btn human-copy"
          :class="{ 'is-copied': copied }"
          :title="copied ? '已复制' : '复制'"
          @click="copy"
        >
          <Check v-if="copied" :size="14" />
          <Copy v-else :size="14" />
        </div>
        <p class="message-text">{{ plainText }}</p>
      </template>

      <!-- 助手消息 -->
      <div v-else class="assistant-message">
        <template v-for="(block, index) in blocks" :key="index">
          <div v-if="block.type === 'thinking'" class="reasoning-box">
            <div class="reasoning-header" @click="showThinking = !showThinking">
              <CaretRightOutlined :rotate="showThinking ? 90 : 0" />
              <span>{{ streaming ? '正在思考...' : '推理过程' }}</span>
            </div>
            <p v-show="showThinking" class="reasoning-content">{{ block.thinking }}</p>
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
            class="message-md"
          />
        </template>

        <!-- 模型调用失败时 pi 不发 error 帧，而是把原因放在消息的 errorMessage 上 -->
        <div v-if="message.errorMessage" class="err-msg">
          <TriangleAlert :size="14" />
          <span>{{ message.errorMessage }}</span>
        </div>

        <span v-if="streaming" class="cursor" />

        <div v-if="!streaming && plainText" class="assistant-actions">
          <div
            class="message-copy-btn"
            :class="{ 'is-copied': copied }"
            :title="copied ? '已复制' : '复制'"
            @click="copy"
          >
            <Check v-if="copied" :size="14" />
            <Copy v-else :size="14" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref } from 'vue'
import { CaretRightOutlined } from '@ant-design/icons-vue'
import { Check, Copy, TriangleAlert } from 'lucide-vue-next'
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

/** 只取文本块：复制时不该把工具调用的 JSON 和思考过程也带上 */
const plainText = computed(() =>
  blocks.value
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
)

let copyTimer = null

async function copy() {
  try {
    await navigator.clipboard.writeText(plainText.value)
    copied.value = true
    // 连点两次时重置上一个计时器，否则第二次的「已复制」会被前一个提前掐掉
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // http 环境下 clipboard 不可用，静默失败好过弹一个用户无法处理的错误
  }
}

onUnmounted(() => clearTimeout(copyTimer))
</script>

<style lang="less" scoped>
.message-row {
  display: flex;
  margin: 0.8rem 0;

  &.user {
    justify-content: flex-end;
  }
}

.message-box {
  position: relative;
  max-width: 100%;
  color: var(--gray-10000);
  font-size: 15px;
  line-height: 24px;
  letter-spacing: 0.25px;
  word-break: break-word;
  user-select: text;

  &.user {
    max-width: 95%;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    background-color: var(--main-50);
    color: var(--gray-1000);
  }

  &.assistant {
    width: 100%;
    padding: 0;
    background-color: transparent;
    text-align: left;
  }
}

.message-text {
  max-width: 100%;
  margin-bottom: 0;
  white-space: pre-line;
}

.message-copy-btn {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  opacity: 0;
  color: var(--gray-400);
  cursor: pointer;
  transition: color 0.2s ease, opacity 0.2s ease;

  &:hover {
    color: var(--main-color);
  }

  &.is-copied {
    opacity: 1;
    color: var(--color-success-500);
  }

  // 用户气泡贴着右边，复制按钮挂在气泡左外侧，避免压住文字
  &.human-copy {
    position: absolute;
    bottom: 8px;
    left: -28px;
  }
}

.message-box:hover .message-copy-btn {
  opacity: 1;
}

.assistant-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.reasoning-box {
  margin: 10px 0 15px;
  border: 1px solid var(--gray-150);
  border-radius: 8px;
  background-color: var(--gray-25);
  overflow: hidden;
}

.reasoning-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--gray-700);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;

  :deep(.anticon) {
    color: var(--gray-400);
  }
}

.reasoning-content {
  margin: 0;
  padding: 0 16px 16px;
  color: var(--gray-800);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.message-md {
  background: transparent;

  :deep(.md-editor-preview-wrapper) {
    padding: 0;
  }
}

.err-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 0.5rem 1rem;
  border: 1px solid currentColor;
  border-radius: 8px;
  background: var(--color-error-50);
  color: var(--color-error-500);
  font-size: 14px;
  text-align: left;
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

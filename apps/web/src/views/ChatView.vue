<template>
  <div class="chat-view">
    <main ref="scrollArea" class="stream">
      <div class="inner">
        <div v-if="messages.length === 0" class="empty">
          <p>问点什么开始。</p>
          <p class="hint">试试「现在几点」，会触发一次工具调用。</p>
        </div>

        <MessageItem
          v-for="(message, index) in messages"
          :key="index"
          :message="message"
          :tool-calls="toolCalls"
          :editor-id="index"
          :streaming="running && index === messages.length - 1 && message.role === 'assistant'"
        />

        <div v-if="error" class="error">{{ error }}</div>
      </div>
    </main>

    <footer class="composer-wrap">
      <div class="inner">
        <div class="composer">
          <CommandPalette
            v-if="palette.open.value"
            :commands="palette.filtered.value"
            :active-index="palette.activeIndex.value"
            @pick="onPickCommand"
            @hover="palette.activeIndex.value = $event"
          />

          <textarea
            ref="input"
            v-model="draft"
            class="input"
            rows="1"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行，/ 唤起命令"
            @input="onInput"
            @keydown="onKeydown"
          />

          <div class="actions">
            <button class="icon-btn" type="button" disabled title="附件上传待后端接口">
              <Plus :size="16" />
            </button>
            <button class="icon-btn" type="button" title="命令" @click="toggleCommands">
              <Slash :size="16" />
            </button>

            <span class="model">{{ MODEL_NAME }}</span>

            <button v-if="running" class="send stop" type="button" title="停止" @click="abort">
              <Square :size="14" />
            </button>
            <button
              v-else
              class="send"
              type="button"
              title="发送"
              :disabled="!draft.trim()"
              @click="submit"
            >
              <ArrowUp :size="16" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowUp, Plus, Slash, Square } from 'lucide-vue-next'
import CommandPalette from '@/components/chat/CommandPalette.vue'
import MessageItem from '@/components/chat/MessageItem.vue'
import { useAgentStream } from '@/composables/useAgentStream'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'

/** packages/ai 目前只注册了这一个模型，所以这里是静态文字而不是下拉 */
const MODEL_NAME = 'DeepSeek-V3'

const { messages, toolCalls, running, error, send, abort, reset } = useAgentStream()

const layout = useLayoutStore()
const workspace = useWorkspaceStore()

// AppShell 用 key 强制重挂载来实现「新对话」，卸载时必须掐断在飞的请求，
// 否则旧对话的 SSE 会继续跑到没有组件接收它为止
onUnmounted(abort)

const draft = ref('')
const scrollArea = ref(null)
const input = ref(null)

function newChat() {
  reset()
  workspace.clear()
  draft.value = ''
}

const palette = useCommandPalette([
  { name: 'new', description: '新对话', run: newChat },
  { name: 'workspace', description: '开合右栏', run: () => layout.toggleRight() },
  { name: 'sidebar', description: '开合左栏', run: () => layout.toggleLeft() }
])

/** 只在整段输入以 / 开头时唤起面板，避免正文里的斜杠误触发 */
function onInput() {
  if (draft.value.startsWith('/')) {
    palette.openWith(draft.value.slice(1))
  } else if (palette.open.value) {
    palette.close()
  }
}

function toggleCommands() {
  if (palette.open.value) {
    palette.close()
    return
  }
  draft.value = '/'
  palette.openWith('')
  input.value?.focus()
}

function onPickCommand(index) {
  palette.pick(index)
  draft.value = ''
}

function onKeydown(event) {
  if (palette.open.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      palette.moveDown()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      palette.moveUp()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      palette.close()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      palette.pick()
      draft.value = ''
      return
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

async function submit() {
  const text = draft.value.trim()
  if (!text || running.value) return
  draft.value = ''
  await send(text)
}

watch(
  () => [messages.value.length, messages.value.at(-1)],
  async () => {
    await nextTick()
    const el = scrollArea.value
    if (el) el.scrollTop = el.scrollHeight
  }
)
</script>

<style lang="less" scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-app);
}

.stream {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

// 760px 是上限而非固定值：1280 下三栏全开时中栏只剩 680px，
// 让内容自然收窄，不挤压左右栏也不出横向滚动
.inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 0 24px;
}

.empty {
  padding: 80px 0;
  color: var(--text-muted);
  text-align: center;

  .hint {
    color: var(--text-faint);
    font-size: 13px;
  }
}

.error {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-error-50);
  color: var(--color-error-700);
  font-size: 13px;
  word-break: break-word;
}

.composer-wrap {
  flex: 0 0 auto;
  padding: 8px 0 20px;
}

.composer {
  position: relative;
  padding: 10px 12px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 24px;
  background: var(--surface-app);
  transition: border-color 0.15s ease;

  &:focus-within {
    border-color: var(--text-faint);
  }
}

.input {
  display: block;
  width: 100%;
  max-height: 200px;
  border: none;
  background: transparent;
  color: var(--text-strong);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.5;
  resize: none;

  &:focus {
    outline: none;
  }

  &::placeholder {
    color: var(--text-faint);
  }
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}

.model {
  margin-left: auto;
  margin-right: 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--text-strong);
  color: var(--surface-app);
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:disabled {
    background: var(--surface-hover);
    color: var(--text-faint);
    cursor: not-allowed;
  }

  &.stop {
    background: var(--text-muted);
  }
}
</style>

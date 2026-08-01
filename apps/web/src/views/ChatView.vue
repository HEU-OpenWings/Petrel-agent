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
        <div class="composer-shell">
          <CommandPalette
            v-if="palette.open.value"
            :commands="palette.filtered.value"
            :active-index="palette.activeIndex.value"
            @pick="onPickCommand"
            @hover="palette.activeIndex.value = $event"
          />

          <MessageInputComponent
            ref="input"
            :model-value="draft"
            :is-loading="running"
            :send-button-disabled="!running && !draft.trim()"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行，/ 唤起命令"
            @update:model-value="onDraftChange"
            @send="onSendOrStop"
            @keydown="onKeydown"
          >
            <template #actions-right>
              <span class="model">{{ MODEL_NAME }}</span>
              <a-tooltip :title="canUseCommands ? '命令' : '清空输入后可使用命令'">
                <a-button
                  type="text"
                  class="command-btn"
                  :disabled="!canUseCommands"
                  @click="toggleCommands"
                >
                  <template #icon><Slash :size="15" /></template>
                </a-button>
              </a-tooltip>
            </template>
          </MessageInputComponent>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Slash } from 'lucide-vue-next'
import CommandPalette from '@/components/chat/CommandPalette.vue'
import MessageItem from '@/components/chat/MessageItem.vue'
import MessageInputComponent from '@/components/MessageInputComponent.vue'
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
  // 必须先 abort 再 reset：reset() 不会碰 running/controller，
  // 旧流后续到达的事件会继续写回刚清空的 messages，且 running 会卡在 true 挡住新消息
  abort()
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
function onDraftChange(value) {
  draft.value = value
  if (value.startsWith('/')) {
    palette.openWith(value.slice(1))
  } else if (palette.open.value) {
    palette.close()
  }
}

// 输入框在加载中会把发送按钮换成停止图标，两种点击都走这里
function onSendOrStop() {
  if (running.value) {
    abort()
    return
  }
  submit()
}

// 面板开着时要能点它关闭；只有「面板没开且已有草稿」才禁用，
// 否则点一下会把用户没发出去的内容冲掉
const canUseCommands = computed(() => palette.open.value || !draft.value.trim())

function toggleCommands() {
  if (palette.open.value) {
    palette.close()
    return
  }
  // 走到这里说明面板没开，canUseCommands 此时等价于「草稿是否为空」，
  // 非空则拒绝打开面板，避免覆盖草稿
  if (!canUseCommands.value) return
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

// 输入框本体是 v0.4 的 MessageInputComponent，这里只负责给命令面板一个定位参照
.composer-shell {
  position: relative;
}

// packages/ai 只注册了一个模型，这里是静态标识而不是可点的下拉
.model {
  margin-right: 4px;
  color: var(--gray-500);
  font-size: 12px;
}

.command-btn {
  display: flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  padding: 0;
  border-radius: 8px;
  color: var(--gray-600);

  &:hover:not(:disabled) {
    color: var(--main-color);
  }

  &:disabled {
    color: var(--gray-300);
  }
}
</style>

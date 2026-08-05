<template>
  <div class="chat-view">
    <main ref="scrollArea" class="stream">
      <div class="inner">
        <div v-if="messages.length === 0" class="empty">
          <p>问点什么开始。</p>
          <p class="hint">试试「现在几点」，会触发一次工具调用。</p>
        </div>

        <template v-for="(message, index) in messages" :key="index">
          <!-- 压缩发生在新一轮的 prompt 之前，所以分隔线插在那一刻的消息下标之前 -->
          <CompactionDivider
            v-for="mark in compactions.filter((item) => item.atIndex === index)"
            :key="mark.id"
            :tokens-before="mark.tokensBefore"
            :tokens-after="mark.tokensAfter"
          />
          <MessageItem
            :message="message"
            :tool-calls="toolCalls"
            :editor-id="index"
            :streaming="running && index === messages.length - 1 && message.role === 'assistant'"
          />
        </template>

        <!-- atIndex 等于当前长度的标记还没有对应消息（压缩刚结束、回答还没开始） -->
        <CompactionDivider
          v-for="mark in compactions.filter((item) => item.atIndex >= messages.length)"
          :key="mark.id"
          :tokens-before="mark.tokensBefore"
          :tokens-after="mark.tokensAfter"
        />

        <div v-if="compacting" class="compacting" role="status">正在压缩上下文…</div>

        <!-- 压缩被守卫挡住但阈值确实超了。与 error 分开渲染：它不是本轮的失败，
             也不该被下一轮的 agent_start 或真错误盖掉 -->
        <div v-if="warning" class="warning" role="status">{{ warning }}</div>

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
              <span class="model">{{ modelLabel }}</span>
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Slash } from 'lucide-vue-next'
import CommandPalette from '@/components/chat/CommandPalette.vue'
import CompactionDivider from '@/components/chat/CompactionDivider.vue'
import MessageItem from '@/components/chat/MessageItem.vue'
import MessageInputComponent from '@/components/MessageInputComponent.vue'
import { fetchMessages } from '@/apis/session_api'
import { useAgentStream } from '@/composables/useAgentStream'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { useLayoutStore } from '@/stores/layout'
import { usePreferencesStore } from '@/stores/preferences'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspace'

const {
  messages,
  toolCalls,
  running,
  error,
  warning,
  compacting,
  compactions,
  send,
  stop,
  disconnect,
  reset,
  loadHistory
} = useAgentStream()

const layout = useLayoutStore()
const preferences = usePreferencesStore()
const sessionStore = useSessionStore()
const workspace = useWorkspaceStore()

// 模型名以偏好为准：没选时 store 会取后端标了 isDefault 的那个，
// 不再是写死的字符串（写死的那份已经和 packages/ai 的默认模型对不上了）
const modelLabel = computed(() => preferences.modelName || '默认模型')

// AppShell 用 key 强制重挂载来实现「新对话」，卸载时只需要断开本地接收——
// harness 是常驻的，旧对话的生成会继续跑完并落库，不是真的要停止它
onUnmounted(disconnect)

// 进对话页时没有当前会话就开一个新的；已经有了（从左栏点进来、或从别的页面切回来）就拉历史。
// startNew() 也会改 currentId，从而触发下面的 watch 去拉一个后端还不存在的会话——
// 该接口对不存在的会话刻意返回 200 + 空数组（见 routes/sessions.ts），多打一次而已，
// 换来的是「新建」和「切换」共用同一条加载路径，不用在两处各维护一套清空逻辑
onMounted(() => {
  // 幂等，SettingsModal 打开时也会调一次。拉不到不阻断对话：
  // model / systemPrompt 保持 null，后端回落到系统默认值
  void preferences.ensureLoaded()
  if (!sessionStore.currentId) sessionStore.startNew()
  else void loadSession(sessionStore.currentId)
})

/**
 * submit() 的自增计数。守的是这个场景：历史 GET 慢，用户没等它回来就发了消息，
 * 等历史到达时 loadHistory() 会先 disconnect() 掐死这条刚起的流、再把 messages 清空
 * ——用户的消息凭空消失。这里不能用 running 判断：切会话时旧流也在 running，
 * 分不出「别的会话的旧流」和「本会话的新流」，只有 send 的次数能。
 * 别因为看不出它在防什么就删掉。
 */
let sendSeq = 0

async function loadSession(id) {
  const seenSend = sendSeq
  let history = []
  try {
    const data = await fetchMessages(id)
    history = data.messages ?? []
  } catch {
    // 历史拉不到就当空会话继续，不阻塞用户提问
  }
  // 加载期间用户发了新消息，界面已经属于新一轮对话，这份历史作废
  if (sendSeq !== seenSend) return
  // 连着点两个会话时响应可能乱序到达，晚到的旧响应会把当前会话的内容盖掉
  if (sessionStore.currentId !== id) return
  loadHistory(history)
}

watch(
  () => sessionStore.currentId,
  (id) => {
    if (id) void loadSession(id)
  }
)

const draft = ref('')
const scrollArea = ref(null)
const input = ref(null)

function newChat() {
  // 必须先断开再 reset：reset() 不会碰 running/controller，
  // 旧流后续到达的事件会继续写回刚清空的 messages，且 running 会卡在 true 挡住新消息。
  // 只断本地接收，不调用 stop()：开新对话不等于要打断上一个会话正在生成的回答
  disconnect()
  reset()
  workspace.clear()
  draft.value = ''
  sessionStore.startNew()
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
    stop()
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
  if (running.value) return

  // 首次进入页面时偏好仍可能在加载。先等它结束再读取下面两个字段，避免首条消息
  // 用系统默认值、后续消息却突然切到用户保存的模型与 prompt。
  // ensureLoaded() 会吞掉加载错误；失败时字段保持 null，仍可按原契约回退系统默认。
  await preferences.ensureLoaded()

  // 等待期间可能重复触发 submit；第一个调用开始发送后，其余调用在这里退出。
  const text = draft.value.trim()
  if (!text || running.value) return

  // onMounted 保证了 currentId 非空，?? 只是不让 null 漏进请求体（后端会 400）
  const sessionId = sessionStore.currentId ?? sessionStore.startNew()

  draft.value = ''
  // 必须在 send 之前自增：在飞的 loadSession 靠它判断「我拉的历史已经过期了」
  sendSeq += 1
  await send(text, {
    sessionId,
    // ?? undefined：store 里「跟随系统默认」是 null，而请求体里不该出现
    // model: null——后端的类型校验只认字符串或不传
    model: preferences.defaultModel ?? undefined,
    systemPrompt: preferences.systemPrompt ?? undefined
  })

  // 首条消息会让后端 upsert 出这个会话，刷新列表才能把它显示出来；
  // 后续消息只改 updatedAt，同样要刷新，否则左栏的时间倒序是旧的
  await sessionStore.refresh()
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

// 与 .error 同一套配色变量，深色模式下这些 token 会被 base.dark.css 覆盖；
// 写死的 rgba(0,0,0,…) 在暗色底上近乎不可读
.warning {
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-warning-50);
  color: var(--color-warning-700);
  font-size: 13px;
  word-break: break-word;
}

.compacting {
  margin: 12px 0;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.composer-wrap {
  flex: 0 0 auto;
  padding: 8px 0 20px;
}

// 输入框本体是 v0.4 的 MessageInputComponent，这里只负责给命令面板一个定位参照
.composer-shell {
  position: relative;
}

// 显示当前生效的模型名，值来自 stores/preferences
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

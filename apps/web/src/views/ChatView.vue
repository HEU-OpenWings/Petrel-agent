<template>
  <div class="chat-view">
    <header class="top">
      <span class="title">Petrel</span>
      <span class="model">agent-server · pi agent loop</span>
      <button class="reset" type="button" :disabled="running" @click="reset">新对话</button>
    </header>

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

    <footer class="composer">
      <div class="inner">
        <textarea
          v-model="draft"
          class="input"
          rows="1"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          @keydown.enter.exact.prevent="submit"
        />
        <button v-if="running" class="action stop" type="button" @click="abort">停止</button>
        <button v-else class="action" type="button" :disabled="!draft.trim()" @click="submit">
          发送
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import MessageItem from '@/components/chat/MessageItem.vue'
import { useAgentStream } from '@/composables/useAgentStream'

const { messages, toolCalls, running, error, send, abort, reset } = useAgentStream()

const draft = ref('')
const scrollArea = ref(null)

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
  height: 100vh;
  background: var(--gray-0);
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--gray-150);
}

.title {
  color: var(--gray-1000);
  font-weight: 600;
}

.model {
  color: var(--gray-400);
  font-size: 12px;
}

.reset {
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--gray-200);
  border-radius: 4px;
  background: var(--gray-0);
  color: var(--gray-700);
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    color: var(--gray-400);
    cursor: not-allowed;
  }
}

.stream {
  flex: 1;
  overflow-y: auto;
}

.inner {
  max-width: 760px;
  margin: 0 auto;
  padding: 0 20px;
}

.empty {
  padding: 80px 0;
  color: var(--gray-500);
  text-align: center;

  .hint {
    color: var(--gray-400);
    font-size: 13px;
  }
}

.error {
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid #e8a3a3;
  border-radius: 6px;
  background: #fdf5f5;
  color: #c04a4a;
  font-size: 13px;
  word-break: break-word;
}

.composer {
  border-top: 1px solid var(--gray-150);
  padding: 12px 0 20px;

  .inner {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
}

.input {
  flex: 1;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--gray-200);
  border-radius: 8px;
  background: var(--gray-0);
  color: var(--gray-1000);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  resize: none;

  &:focus {
    outline: none;
    border-color: var(--main-300);
  }
}

.action {
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  background: var(--main-color);
  color: #fff;
  font-size: 14px;
  cursor: pointer;

  &:disabled {
    background: var(--gray-300);
    cursor: not-allowed;
  }

  &.stop {
    background: var(--gray-700);
  }
}
</style>

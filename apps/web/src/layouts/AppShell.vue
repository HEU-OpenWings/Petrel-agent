<template>
  <div class="app-shell">
    <aside v-if="!layout.leftCollapsed" class="sidebar">
      <SessionSidebar
        @new-chat="onNewChat"
        @select="onSelectSession"
        @open-settings="showSettings = true"
      />
    </aside>

    <div class="main">
      <header class="toolbar">
        <button
          class="icon-btn"
          type="button"
          :title="layout.leftCollapsed ? '展开侧栏' : '收起侧栏'"
          @click="layout.toggleLeft()"
        >
          <PanelLeft :size="16" />
        </button>
        <span class="title">{{ title }}</span>
        <button
          v-if="hasWorkspace"
          class="icon-btn right"
          type="button"
          :title="layout.rightCollapsed ? '展开工作区' : '收起工作区'"
          @click="layout.toggleRight()"
        >
          <PanelRight :size="16" />
        </button>
      </header>

      <div class="content">
        <router-view :key="viewKey" />
      </div>
    </div>

    <template v-if="hasWorkspace && !layout.rightCollapsed">
      <div
        class="resizer"
        title="拖动调整宽度，双击复位"
        @pointerdown="onPointerDown"
        @dblclick="layout.resetRightWidth()"
      />
      <aside class="workspace" :style="{ width: `${layout.rightWidth}px` }">
        <WorkspacePanel />
      </aside>
    </template>

    <SettingsModal v-model:open="showSettings" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { PanelLeft, PanelRight } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { useResizePanel } from '@/composables/useResizePanel'
import { useLayoutStore } from '@/stores/layout'
import { useSessionStore } from '@/stores/session'
import SessionSidebar from '@/components/shell/SessionSidebar.vue'
import WorkspacePanel from '@/components/shell/WorkspacePanel.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'

const route = useRoute()
const router = useRouter()
const layout = useLayoutStore()
const sessionStore = useSessionStore()

// 用 emit 而不是 provide/inject 传打开动作：SessionSidebar 已经有 @new-chat / @select
// 两个 emit，加这个与既有惯例一致，而且调用关系在模板里看得见
const showSettings = ref(false)

// 右栏只属于对话页，由路由 meta 决定，非对话页自动只剩两栏
const hasWorkspace = computed(() => route.meta.workspace === true)
const title = computed(() => route.meta.title ?? '')

const { onPointerDown } = useResizePanel({
  getWidth: () => layout.rightWidth,
  setWidth: (width) => layout.setRightWidth(width)
})

// 已经在对话页时 router.push('/agent') 不会重新挂载组件，点「新对话」会毫无反应。
// 递增 key 强制重挂载 ChatView，「全新对话」的语义正好等于「组件重新来过」，
// 连输入框草稿和错误提示一起清干净。
const chatKey = ref(0)
const viewKey = computed(() => (route.path === '/agent' ? `agent#${chatKey.value}` : route.path))

function onNewChat() {
  sessionStore.startNew()
  if (route.path === '/agent') {
    chatKey.value += 1
  } else {
    router.push('/agent')
  }
}

// 选中会话只改 store，由 ChatView 监听 currentId 去拉历史：
// AppShell 拿不到 ChatView 内部的 useAgentStream 实例，没法直接灌消息
function onSelectSession(id) {
  sessionStore.select(id)
  if (route.path !== '/agent') router.push('/agent')
}
</script>

<style lang="less" scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--surface-app);
  color: var(--text-strong);
}

.sidebar {
  flex: 0 0 240px;
  width: 240px;
  height: 100%;
  overflow: hidden;
  background: var(--surface-sunken);
}

.main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  // 没有 min-width: 0 的话 flex 子项不会收缩到内容宽度以下，窄屏会顶出横向滚动
  min-width: 0;
}

.toolbar {
  display: flex;
  flex: 0 0 44px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.title {
  color: var(--text-muted);
  font-size: 13px;
}

.icon-btn.right {
  margin-left: auto;
}

.content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.resizer {
  flex: 0 0 4px;
  background: transparent;
  cursor: col-resize;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--border-subtle);
  }
}

.workspace {
  flex: 0 0 auto;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid var(--border-subtle);
  background: var(--surface-app);
}
</style>

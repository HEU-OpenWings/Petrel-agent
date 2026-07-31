<template>
  <div class="app-shell">
    <aside v-if="!layout.leftCollapsed" class="sidebar">
      <div class="placeholder">SessionSidebar</div>
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
        <router-view />
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
        <div class="placeholder">WorkspacePanel</div>
      </aside>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { PanelLeft, PanelRight } from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import { useResizePanel } from '@/composables/useResizePanel'
import { useLayoutStore } from '@/stores/layout'

const route = useRoute()
const layout = useLayoutStore()

// 右栏只属于对话页，由路由 meta 决定，非对话页自动只剩两栏
const hasWorkspace = computed(() => route.meta.workspace === true)
const title = computed(() => route.meta.title ?? '')

const { onPointerDown } = useResizePanel({
  getWidth: () => layout.rightWidth,
  setWidth: (width) => layout.setRightWidth(width)
})
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

.placeholder {
  padding: 16px;
  color: var(--text-faint);
  font-size: 13px;
}
</style>

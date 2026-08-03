<template>
  <div class="workspace-panel">
    <header class="head">
      <span class="head-title">工作区</span>
      <button class="icon-btn" type="button" title="收起工作区" @click="layout.toggleRight()">
        <PanelRightClose :size="16" />
      </button>
    </header>

    <section class="section">
      <div class="section-title">工具调用</div>

      <div v-if="!active" class="empty">未选择工具调用</div>
      <template v-else>
        <div class="tool-head">
          <span class="tool-name">{{ active.name }}</span>
          <span class="tool-state" :class="active.state">{{ stateText }}</span>
          <span v-if="active.ms !== undefined" class="tool-ms">{{ active.ms }}ms</span>
        </div>

        <div class="block-title">参数</div>
        <pre class="block">{{ formattedArgs }}</pre>

        <template v-if="resultText">
          <div class="block-title">结果</div>
          <!-- 与中栏用同一个渲染器，右栏细读时不会看到和内联展开不一样的东西 -->
          <ToolResultRenderer :tool-name="active.name" :result-content="resultText" />
        </template>
      </template>
    </section>

    <section class="section">
      <div class="section-title">引用</div>
      <div class="empty">暂无引用，等待知识库检索接入</div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { PanelRightClose } from 'lucide-vue-next'
import { ToolResultRenderer } from '@/components/ToolCallingResult'
import { useLayoutStore } from '@/stores/layout'
import { useWorkspaceStore } from '@/stores/workspace'
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from '@/utils/toolCall'

const layout = useLayoutStore()
const workspace = useWorkspaceStore()

const active = computed(() => workspace.activeToolCall)
const stateText = computed(() => TOOL_STATE_TEXT[active.value?.state] ?? '')
const formattedArgs = computed(() => formatToolArgs(active.value?.args))
const resultText = computed(() => extractToolResultText(active.value?.result))
</script>

<style lang="less" scoped>
.workspace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.head {
  display: flex;
  flex: 0 0 44px;
  align-items: center;
  padding: 0 12px;
}

.head-title {
  margin-right: auto;
  color: var(--text-strong);
  font-size: 13px;
}

.section {
  padding: 12px 16px;

  & + .section {
    border-top: 1px solid var(--border-subtle);
  }
}

.section-title {
  margin-bottom: 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.empty {
  color: var(--text-faint);
  font-size: 13px;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
}

.tool-name {
  color: var(--text-strong);
  font-family: monospace;
}

.tool-state {
  color: var(--text-muted);

  &.running {
    color: var(--main-color);
  }

  &.error {
    color: var(--color-error-500);
  }
}

.tool-ms {
  margin-left: auto;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.block-title {
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 12px;
}

.block {
  margin: 0 0 12px;
  max-height: 320px;
  padding: 8px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text-strong);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

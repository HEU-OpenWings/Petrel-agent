<template>
  <div class="tool-call-display" :class="[state, { 'is-collapsed': !expanded }]">
    <div class="tool-header" @click="expanded = !expanded">
      <span v-if="state === 'done'" class="header-text">
        <CircleCheckBig :size="16" class="tool-loader tool-success" />
        工具 <span class="tool-name">{{ toolCall.name }}</span> 执行完成
      </span>
      <span v-else-if="state === 'error'" class="header-text">
        <CircleAlert :size="16" class="tool-loader tool-error" />
        工具 <span class="tool-name">{{ toolCall.name }}</span> 执行失败
      </span>
      <span v-else class="header-text">
        <Loader :size="16" class="tool-loader rotate tool-loading" />
        正在调用工具:
        <span class="tool-name">{{ toolCall.name }}</span>
      </span>

      <span v-if="detail.ms !== undefined" class="tool-ms">{{ detail.ms }}ms</span>

      <button class="icon-btn send" type="button" title="在工作区查看" @click.stop="sendToWorkspace">
        <ArrowUpRight :size="14" />
      </button>
    </div>

    <div v-show="expanded" class="tool-content">
      <div v-if="formattedArgs !== '(无)'" class="tool-params">
        <div class="tool-params-content"><strong>参数: </strong>{{ formattedArgs }}</div>
      </div>

      <div v-if="resultText" class="tool-result">
        <ToolResultRenderer :tool-name="toolCall.name" :result-content="resultText" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ArrowUpRight, CircleAlert, CircleCheckBig, Loader } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { ToolResultRenderer } from "@/components/ToolCallingResult";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";
import { extractToolResultText, formatToolArgs } from "@/utils/toolCall";

const props = defineProps({
  /** pi 的 toolCall content block：{ id, name, arguments } */
  toolCall: { type: Object, required: true },
  /** useAgentStream 里由 tool_execution_* 事件归约出的执行状态 */
  detail: { type: Object, default: () => ({}) },
});

const expanded = ref(false);
const layout = useLayoutStore();
const workspace = useWorkspaceStore();

const state = computed(() => props.detail.state ?? "pending");
// detail.args 来自 tool_execution_start 事件，工具还没开始执行时退回 content block 里的参数
const args = computed(() => props.detail.args ?? props.toolCall.arguments);
const formattedArgs = computed(() => formatToolArgs(args.value));
// ToolResultRenderer 会自己尝试 JSON.parse，按结果形状挑对应的展示卡片
const resultText = computed(() => extractToolResultText(props.detail.result));

/** 右栏与本组件是兄弟关系，注入不到，只能把完整快照写进 store */
function snapshot() {
  return {
    id: props.toolCall.id,
    name: props.toolCall.name,
    state: state.value,
    args: args.value,
    result: props.detail.result,
    ms: props.detail.ms,
  };
}

// 右栏折叠时也要能送过去，否则用户点了没有任何反馈
function sendToWorkspace() {
  workspace.openToolCall(snapshot());
  layout.expandRight();
}

// 工具执行中就被送到右栏时，后续的状态与结果要跟着更新，
// 否则右栏会一直停在「执行中」
watch(
  () => props.detail,
  () => {
    if (workspace.activeToolCallId === props.toolCall.id) {
      workspace.syncToolCall(snapshot());
    }
  },
  { deep: true },
);
</script>

<style lang="less" scoped>
.tool-call-display {
  margin: 10px 0;
  border-radius: 8px;
  outline: 1px solid var(--gray-150);
  background-color: var(--gray-25);
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--gray-100);
  color: var(--gray-800);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;

  // 送右栏的入口只在 hover 时出现，避免每张卡片都常驻一个图标
  .send {
    opacity: 0;
  }

  &:hover .send {
    opacity: 1;
  }
}

.is-collapsed .tool-header {
  border-bottom: none;
}

// 占满剩余宽度，把耗时与送右栏按钮自然顶到右侧
.header-text {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.tool-name {
  color: var(--main-700);
  font-weight: 600;
}

.tool-loader {
  flex-shrink: 0;
  color: var(--main-700);

  &.rotate {
    animation: rotate 2s linear infinite;
  }

  &.tool-success {
    color: var(--color-success-500);
  }

  &.tool-error {
    color: var(--color-error-500);
  }

  &.tool-loading {
    color: var(--color-info-500);
  }
}

.tool-ms {
  flex-shrink: 0;
  color: var(--gray-500);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tool-params {
  padding: 8px 12px;
  border-bottom: 1px solid var(--gray-150);
  background-color: var(--gray-25);
}

.tool-params-content {
  color: var(--gray-700);
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-result {
  padding: 0;
  background-color: transparent;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>

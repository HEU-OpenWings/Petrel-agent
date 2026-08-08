<template>
  <a-drawer
    :open="isOpen"
    :width="620"
    title="任务中心"
    placement="right"
    @close="handleClose"
  >
    <div class="task-center">
      <div class="task-toolbar">
        <div class="task-filter-group">
          <a-segmented
            v-model:value="statusFilter"
            :options="taskFilterOptions"
          />
        </div>
        <div class="task-toolbar-actions">
          <a-button
            type="text"
            @click="handleRefresh"
            :loading="loadingState"
          >
            刷新
          </a-button>
        </div>
      </div>

      <a-alert
        v-if="lastErrorState"
        type="error"
        show-icon
        class="task-alert"
        :message="lastErrorState.message || '加载任务信息失败'"
      />

      <div v-if="hasTasks" class="task-list">
        <div
          v-for="task in filteredTasks"
          :key="task.id"
          class="task-card"
          :class="taskCardClasses(task)"
        >
          <div class="task-card-header">
            <div class="task-card-info">
              <div class="task-card-title">{{ task.name }}</div>
              <div class="task-card-subtitle">
                <span class="task-card-id">#{{ formatTaskId(task.id) }}</span>
                <span class="task-card-type">{{ taskTypeLabel(task.type) }}</span>
                <span class="task-card-id" v-if="getTaskDuration(task)">{{ getTaskDuration(task) }}</span>
              </div>
            </div>
            <a-tag :color="statusColor(task.status)" class="task-card-status">
              {{ statusLabel(task.status) }}

            </a-tag>
          </div>

          <div v-if="!isTaskCompleted(task)" class="task-card-progress">
            <a-progress
              :percent="Math.round(task.progress || 0)"
              :status="progressStatus(task.status)"
              :stroke-width="6"
              />
            <!-- <span class="task-card-progress-value">{{ Math.round(task.progress || 0) }}%</span> -->
          </div>

          <div v-if="task.message && !isTaskCompleted(task)" class="task-card-message">
            {{ task.message }}
          </div>
          <div v-if="task.error" class="task-card-error">
            {{ task.error }}
          </div>

          <div class="task-card-footer">
            <div class="task-card-timestamps">
              <span v-if="task.started_at">开始: {{ formatTime(task.started_at) }}</span>
              <span v-if="task.completed_at">完成: {{ formatTime(task.completed_at) }}</span>
              <span v-if="!task.started_at">创建: {{ formatTime(task.created_at, 'short') }}</span>
            </div>
            <div class="task-card-actions">
              <a-button type="link" size="small" @click="handleDetail(task.id)" style="color: var(--gray-500);">
                详情
              </a-button>
              <a-button
                type="link"
                size="small"
                danger
                v-if="canCancel(task)"
                :disabled="!canCancel(task)"
                @click="handleCancel(task.id)"
              >
                取消
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="task-empty">
        <div class="task-empty-icon">🗂️</div>
        <div class="task-empty-title">暂无任务</div>
        <div class="task-empty-subtitle">当你提交知识库导入或其他后台任务时，会在这里展示实时进度（仅展示最近的 100 个任务）。</div>
      </div>
    </div>
  </a-drawer>
</template>

<script setup>
import { Modal } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { computed, h, onBeforeUnmount, ref, watch } from "vue";
import { useTaskerStore } from "@/stores/tasker";
import { formatFullDateTime, formatRelative, parseToShanghai } from "@/utils/time";

const taskerStore = useTaskerStore();
const { isDrawerOpen, sortedTasks, loading, lastError, activeCount, totalCount, successCount, failedCount } =
  storeToRefs(taskerStore);
const isOpen = isDrawerOpen;

const tasks = computed(() => sortedTasks.value);
const loadingState = computed(() => Boolean(loading.value));
const lastErrorState = computed(() => lastError.value);
const statusFilter = ref("all");
const inProgressCount = computed(() => activeCount.value || 0);
const completedCount = computed(() => successCount.value || 0);
const failedTaskCount = computed(() => failedCount.value || 0);
const totalTaskCount = computed(() => totalCount.value || 0);
const taskFilterOptions = computed(() => [
  {
    label: () =>
      h("span", { class: "task-filter-option" }, [
        "全部",
        h("span", { class: "filter-count" }, totalTaskCount.value),
      ]),
    value: "all",
  },
  {
    label: () =>
      h("span", { class: "task-filter-option" }, [
        "进行中",
        h("span", { class: "filter-count" }, inProgressCount.value),
      ]),
    value: "active",
  },
  {
    label: () =>
      h("span", { class: "task-filter-option" }, [
        "已完成",
        h("span", { class: "filter-count" }, completedCount.value),
      ]),
    value: "success",
  },
  {
    label: () =>
      h("span", { class: "task-filter-option" }, [
        "失败",
        h("span", { class: "filter-count" }, failedTaskCount.value),
      ]),
    value: "failed",
  },
]);

const filteredTasks = computed(() => {
  const list = tasks.value;
  switch (statusFilter.value) {
    case "active":
      return list.filter((task) => ACTIVE_CLASS_STATUSES.has(task.status));
    case "success":
      return list.filter((task) => task.status === "success");
    case "failed":
      return list.filter((task) => FAILED_STATUSES.has(task.status));
    default:
      return list;
  }
});

const hasTasks = computed(() => filteredTasks.value.length > 0);

const ACTIVE_CLASS_STATUSES = new Set(["pending", "queued", "running"]);
const FAILED_STATUSES = new Set(["failed", "cancelled"]);
const TASK_TYPE_LABELS = {
  knowledge_ingest: "知识库导入",
  knowledge_rechunks: "文档重新分块",
  graph_task: "图谱处理",
  agent_job: "智能体任务",
};

function taskCardClasses(task) {
  return {
    "task-card--active": ACTIVE_CLASS_STATUSES.has(task.status),
    "task-card--success": task.status === "success",
    "task-card--failed": task.status === "failed",
  };
}

function taskTypeLabel(type) {
  if (!type) return "后台任务";
  return TASK_TYPE_LABELS[type] || type;
}

function formatTaskId(id) {
  if (!id) return "--";
  return id.slice(0, 8);
}

watch(
  isOpen,
  (open) => {
    if (open) {
      taskerStore.loadTasks();
      taskerStore.startPolling();
    } else {
      taskerStore.stopPolling();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  taskerStore.stopPolling();
});

function handleClose() {
  taskerStore.closeDrawer();
}

function handleRefresh() {
  taskerStore.loadTasks();
}

function handleDetail(taskId) {
  const task = tasks.value.find((item) => item.id === taskId);
  if (!task) {
    return;
  }
  const detail = h("div", { class: "task-detail" }, [
    h("p", [h("strong", "状态："), statusLabel(task.status)]),
    h("p", [h("strong", "进度："), `${Math.round(task.progress || 0)}%`]),
    h("p", [h("strong", "更新时间："), formatTime(task.updated_at)]),
    h("p", [h("strong", "描述："), task.message || "-"]),
    h("p", [h("strong", "错误："), task.error || "-"]),
  ]);
  Modal.info({
    title: task.name,
    width: 520,
    content: detail,
  });
}

function handleCancel(taskId) {
  taskerStore.cancelTask(taskId);
}

function formatTime(value, mode = "full") {
  if (!value) return "-";
  if (mode === "short") {
    return formatRelative(value);
  }
  return formatFullDateTime(value);
}

function getTaskDuration(task) {
  if (!task.started_at || !task.completed_at) return null;
  try {
    const start = parseToShanghai(task.started_at);
    const end = parseToShanghai(task.completed_at);
    if (!start || !end) {
      return null;
    }

    const diffSeconds = Math.max(0, Math.floor(end.diff(start, "second")));
    const hours = Math.floor(diffSeconds / 3600);
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    const seconds = diffSeconds % 60;

    if (hours > 0) {
      return `${hours}小时${minutes}分钟`;
    }
    if (minutes > 0) {
      return `${minutes}分钟${seconds}秒`;
    }
    if (seconds > 0) {
      return `${seconds}秒`;
    }
    return "小于1秒";
  } catch {
    return null;
  }
}

function isTaskCompleted(task) {
  return ["success", "failed", "cancelled"].includes(task.status);
}

function getCompletionIcon(status) {
  const icons = {
    success: "✓",
    failed: "✗",
    cancelled: "○",
  };
  return icons[status] || "?";
}

function statusLabel(status) {
  const map = {
    pending: "等待中",
    queued: "已排队",
    running: "进行中",
    success: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] || status;
}

function statusColor(status) {
  const map = {
    pending: "blue",
    queued: "blue",
    running: "processing",
    success: "green",
    failed: "red",
    cancelled: "gray",
  };
  return map[status] || "default";
}

function progressStatus(status) {
  if (status === "failed") return "exception";
  if (status === "cancelled") return "normal";
  return "active";
}

function canCancel(task) {
  return ["pending", "running", "queued"].includes(task.status) && !task.cancel_requested;
}
</script>
<style scoped lang="less">
.task-center {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.task-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  flex-wrap: wrap;
}

.task-filter-group {
  flex-shrink: 0;
}

.task-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

:deep(.filter-count) {
  margin-left: 2px;
  font-size: 12px;
  color: var(--gray-400);
}

.task-toolbar-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
}

.task-alert {
  margin-bottom: 4px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-card {
  background: var(--gray-25);
  border: 1px solid var(--gray-100);
  border-radius: 12px;
  padding: 16px 18px;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 8px;
  // box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.task-card:hover {
  border-color: var(--gray-200);;
}

.task-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.task-card-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.task-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--gray-900);
  line-height: 1.3;
  // word-break: break-word;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}

.task-card-subtitle {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--gray-600);
}

.task-card-id {
  letter-spacing: 0.04em;
}

.task-card-type {
  padding: 0 8px;
  border-radius: 999px;
  background-color: var(--gray-100);
  color: var(--gray-500);
  line-height: 20px;
}

.task-card-status {
  margin-top: 2px;
}

.task-card-progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-card-progress :deep(.ant-progress) {
  flex: 1;
}

.task-card-progress-value {
  font-size: 12px;
  font-weight: 500;
  color: var(--gray-500);
  width: 48px;
  text-align: right;
}

.task-card-message,
.task-card-error {
  font-size: 13px;
  line-height: 1.45;
  border-radius: 6px;
  padding: 10px 12px;
}

.task-card-message {
  background: var(--gray-100);
  color: var(--gray-800);
}

.task-card-error {
  background: var(--color-error-50);
  color: var(--color-error-500);
}

.task-card-footer {
  margin-top: 2px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
}

.task-card-timestamps {
  display: flex;
  flex-direction: row;
  gap: 10px;
  font-size: 12px;
  color: var(--gray-400);
}

.task-card-actions {
  display: flex;
  gap: 6px;
}

.task-card-completion {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--gray-25);
  border: 1px solid var(--gray-100);
}

.completion-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.completion-badge--success {
  color: var(--color-success-500);
}

.completion-badge--success .completion-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-success-50);
  font-size: 14px;
}

.completion-badge--failed {
  color: var(--color-error-500);
}

.completion-badge--failed .completion-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-error-50);
  font-size: 14px;
}

.completion-badge--cancelled {
  color: var(--gray-500);
}

.completion-badge--cancelled .completion-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--gray-50);
  font-size: 14px;
}

.task-duration {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--gray-500);
}

.duration-label {
  font-weight: 500;
}

.duration-value {
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-weight: 600;
  color: var(--gray-600);
}

.task-empty {
  margin-top: 32px;
  padding: 40px 30px;
  border-radius: 16px;
  background: var(--gray-50);
  border: 1px dashed var(--gray-300);
  text-align: center;
  color: var(--gray-600);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.task-empty-icon {
  font-size: 28px;
}

.task-empty-title {
  font-size: 16px;
  font-weight: 600;
}

.task-empty-subtitle {
  font-size: 13px;
  max-width: 320px;
  line-height: 1.5;
  color: var(--gray-400);
}
</style>

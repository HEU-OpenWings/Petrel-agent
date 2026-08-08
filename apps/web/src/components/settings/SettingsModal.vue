<template>
  <a-modal
    v-model:open="visible"
    title="设置"
    :width="720"
    :footer="null"
    :body-style="{ padding: 0 }"
    :destroy-on-close="true"
  >
    <div class="settings">
      <nav class="tabs">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          type="button"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="panel">
        <GeneralPanel v-if="activeTab === 'general'" />
        <ProvidersPanel v-else-if="activeTab === 'providers'" />
        <AccountPanel v-else />
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { usePreferencesStore } from "@/stores/preferences";
import AccountPanel from "./AccountPanel.vue";
import GeneralPanel from "./GeneralPanel.vue";
import ProvidersPanel from "./ProvidersPanel.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open"]);

const TABS = [
  { key: "general", label: "通用" },
  { key: "providers", label: "模型服务" },
  { key: "account", label: "账号" },
];

const preferences = usePreferencesStore();
const activeTab = ref("general");

const visible = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

// 打开时才拉：未登录的人压根开不到这里，而应用启动阶段拉一次会多一个必然 401 的请求。
// ensureLoaded 幂等，ChatView 已经拉过就不会重复发
watch(
  () => props.open,
  (open) => {
    if (open) {
      activeTab.value = "general";
      void preferences.ensureLoaded();
    }
  },
);
</script>

<style lang="less" scoped>
.settings {
  display: flex;
  min-height: 380px;
  max-height: 70vh;
}

.tabs {
  display: flex;
  flex: 0 0 132px;
  flex-direction: column;
  gap: 4px;
  padding: 16px 8px;
  border-right: 1px solid var(--border-subtle);
}

.tab {
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }

  &.active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.panel {
  flex: 1 1 auto;
  // 没有 min-width: 0 的话 flex 子项不会收缩到内容宽度以下，长 prompt 会顶出横向滚动
  min-width: 0;
  padding: 16px 20px;
  overflow-y: auto;
}

// 窄屏转成上下布局：132px 的左栏在 480px 宽度下会把内容区挤到没法用
@media (max-width: 560px) {
  .settings {
    flex-direction: column;
    max-height: 80vh;
  }

  .tabs {
    flex: 0 0 auto;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
  }
}
</style>

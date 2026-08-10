<template>
  <a-dropdown v-model:open="dropdownOpen" trigger="click" placement="topRight" :disabled="disabled">
    <span class="trigger-wrap" @click.stop>
      <a-tooltip :title="tooltip">
        <a-button type="text" class="trigger" :disabled="disabled" :loading="saving">
          <span class="label">{{ label }}</span>
          <ChevronDown v-if="!saving" :size="13" aria-hidden="true" />
        </a-button>
      </a-tooltip>
    </span>

    <template #overlay>
      <a-menu class="model-menu" :selected-keys="[selectedKey]">
        <a-menu-item key="__system__" @click="select(null)">
          <span class="model-name">跟随系统默认</span>
          <span v-if="systemDefaultName" class="provider">{{ systemDefaultName }}</span>
        </a-menu-item>
        <a-menu-divider />
        <a-menu-item-group
          v-for="group in groups"
          :key="group.provider"
          :title="group.providerName"
        >
          <a-menu-item v-for="model in group.models" :key="model.id" @click="select(model.id)">
            <span class="model-name">{{ model.name }}</span>
            <span v-if="model.isDefault" class="provider">系统默认</span>
          </a-menu-item>
        </a-menu-item-group>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<script setup>
import { ChevronDown } from "lucide-vue-next";
import { computed, ref } from "vue";

const props = defineProps({
  models: { type: Array, default: () => [] },
  modelValue: { type: String, default: null },
  label: { type: String, default: "默认模型" },
  loading: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["select"]);
const dropdownOpen = ref(false);

const disabled = computed(() => props.loading || props.saving || props.models.length === 0);
const selectedKey = computed(() => props.modelValue ?? "__system__");
const systemDefaultName = computed(() => props.models.find((model) => model.isDefault)?.name ?? "");
const tooltip = computed(() => {
  if (props.error) return props.error;
  if (props.loading) return "正在加载可用模型…";
  if (props.models.length === 0) return "没有已配置的可用模型";
  return "选择后立即用于下一条消息，并保存为默认模型";
});
const groups = computed(() => {
  const result = [];
  const byProvider = new Map();
  for (const model of props.models) {
    let group = byProvider.get(model.provider);
    if (!group) {
      group = { provider: model.provider, providerName: model.providerName, models: [] };
      byProvider.set(model.provider, group);
      result.push(group);
    }
    group.models.push(model);
  }
  return result;
});

function select(modelId) {
  dropdownOpen.value = false;
  if (modelId === props.modelValue) return;
  emit("select", modelId);
}

defineExpose({
  open: () => {
    if (!disabled.value) dropdownOpen.value = true;
  },
});
</script>

<style lang="less" scoped>
.trigger-wrap {
  display: inline-flex;
  min-width: 0;
}

.trigger {
  display: inline-flex;
  max-width: 190px;
  height: 28px;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-menu {
  min-width: 280px;
  max-width: min(420px, calc(100vw - 32px));
  max-height: 360px;
  overflow-y: auto;
}

.model-name {
  margin-right: 10px;
}

.provider {
  color: var(--text-faint);
  font-size: 11px;
}
</style>

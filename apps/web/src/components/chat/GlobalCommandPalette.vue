<template>
  <div class="backdrop" @mousedown.self="emit('close')">
    <section
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="全局命令面板"
      @mousedown.stop
    >
      <label class="search-row">
        <Search :size="17" aria-hidden="true" />
        <input
          ref="searchInput"
          class="search-input"
          type="text"
          :value="query"
          placeholder="搜索命令…"
          autocomplete="off"
          @input="emit('update:query', $event.target.value)"
        />
        <kbd>Esc</kbd>
      </label>

      <div class="items" role="listbox" aria-label="命令">
        <button
          v-for="(command, index) in commands"
          :key="command.name"
          class="item"
          :class="{ active: index === activeIndex }"
          type="button"
          role="option"
          :aria-selected="index === activeIndex"
          @mouseenter="emit('hover', index)"
          @click="emit('pick', index)"
        >
          <span class="name">/{{ command.name }}</span>
          <span class="description">{{ command.description }}</span>
        </button>
        <div v-if="commands.length === 0" class="empty">没有匹配的命令</div>
      </div>

      <footer class="help"><kbd>↑</kbd><kbd>↓</kbd> 选择　<kbd>Enter</kbd> 执行</footer>
    </section>
  </div>
</template>

<script setup>
import { Search } from "lucide-vue-next";
import { ref } from "vue";

defineProps({
  commands: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
  query: { type: String, default: "" },
});

const emit = defineEmits(["close", "hover", "pick", "update:query"]);
const searchInput = ref(null);

defineExpose({ focus: () => searchInput.value?.focus() });
</script>

<style lang="less" scoped>
.backdrop {
  position: fixed;
  z-index: 1100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: min(18vh, 160px);
  background: rgba(0, 0, 0, 0.35);
  inset: 0;
}

.dialog {
  width: min(560px, calc(100vw - 32px));
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-app);
  box-shadow: 0 12px 40px var(--shadow-3);
}

.search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
}

.search-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-strong);
  font: inherit;

  &::placeholder {
    color: var(--text-faint);
  }
}

kbd {
  padding: 1px 5px;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  background: var(--surface-subtle);
  color: var(--text-faint);
  font-family: inherit;
  font-size: 11px;
}

.items {
  max-height: 320px;
  padding: 6px;
  overflow-y: auto;
}

.item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;

  &.active {
    background: var(--surface-hover);
  }
}

.name {
  min-width: 92px;
  color: var(--text-strong);
  font-family: monospace;
  font-size: 13px;
}

.description {
  color: var(--text-muted);
  font-size: 12px;
}

.empty {
  padding: 28px 12px;
  color: var(--text-faint);
  font-size: 13px;
  text-align: center;
}

.help {
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-faint);
  font-size: 11px;
  text-align: right;
}
</style>

<template>
  <div class="command-palette">
    <button
      v-for="(command, index) in commands"
      :key="command.name"
      class="item"
      :class="{ active: index === activeIndex }"
      type="button"
      @mouseenter="emit('hover', index)"
      @click="emit('pick', index)"
    >
      <span class="name">/{{ command.name }}</span>
      <span class="description">{{ command.description }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  /** 已过滤好的命令列表，过滤逻辑在 useCommandPalette 里 */
  commands: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
});

const emit = defineEmits(["pick", "hover"]);
</script>

<style lang="less" scoped>
.command-palette {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 10;
  padding: 4px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-app);
  // 全站唯一允许用阴影的地方：浮层没有层次就读不出它浮在内容之上
  box-shadow: 0 4px 16px var(--shadow-2);
}

.item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &.active {
    background: var(--surface-hover);
  }
}

.name {
  color: var(--text-strong);
  font-family: monospace;
  font-size: 13px;
}

.description {
  color: var(--text-muted);
  font-size: 12px;
}
</style>

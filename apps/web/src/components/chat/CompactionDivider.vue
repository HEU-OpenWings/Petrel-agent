<script setup>
defineProps({
  tokensBefore: { type: Number, default: 0 },
  tokensAfter: { type: Number, default: 0 }
})
</script>

<template>
  <!--
    压缩会让模型侧的上下文变短，但用户看到的历史一条不少。
    给出前后 token 数是为了让「为什么回答突然像忘了前面」有个可见的解释。
  -->
  <div class="compaction-divider">
    <span class="line" />
    <span>
      上下文已压缩
      <template v-if="tokensBefore">（{{ tokensBefore }} → {{ tokensAfter }} tokens）</template>
    </span>
    <span class="line" />
  </div>
</template>

<style scoped>
/* 颜色走主题变量：深色模式（base.dark.css 覆盖这两个 token）下写死的黑色近乎不可见 */
.compaction-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: var(--text-faint);
  font-size: 12px;
}
.line {
  flex: 1;
  height: 1px;
  background: var(--border-subtle);
}
</style>

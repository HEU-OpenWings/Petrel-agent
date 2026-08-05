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
    <span class="label">
      上下文已压缩
      <template v-if="tokensBefore">（{{ tokensBefore }} → {{ tokensAfter }} tokens）</template>
    </span>
    <span class="line" />
  </div>
</template>

<style scoped>
.compaction-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.line {
  flex: 1;
  height: 1px;
  background: rgba(0, 0, 0, 0.1);
}
</style>

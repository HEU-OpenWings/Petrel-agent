<template>
  <div class="eval-view">
    <CircleCheck :size="18" />
    <p class="title">评测功能开发中</p>
    <p class="hint">等待后端评测 runner 接口（HEU-29）落地。</p>
    <p class="hint">现阶段的基准测试在知识库详情页内使用。</p>
  </div>
</template>

<script setup>
import { CircleCheck } from "lucide-vue-next";
</script>

<style lang="less" scoped>
.eval-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 100%;
  padding: 80px 20px;
  color: var(--text-faint);
}

.title {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 14px;
}

.hint {
  margin: 0;
  font-size: 13px;
}
</style>

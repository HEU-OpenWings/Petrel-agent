<template>
  <div class="memories-panel">
    <p class="hint">
      这些是助手在对话中记下的、关于你的长期信息。删除会话<strong>不会</strong>删除由它产生的记忆，
      需要清理请在这里操作。
    </p>

    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="error" class="state error">{{ error }}</p>
    <p v-else-if="memories.length === 0" class="state">还没有任何记忆。</p>

    <ul v-else class="list">
      <li v-for="memory in memories" :key="memory.id" class="item">
        <span class="content">{{ memory.content }}</span>
        <button type="button" class="remove" @click="remove(memory.id)">删除</button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { deleteMemory, listMemories } from "@/apis/memory_api";

const memories = ref([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await listMemories();
    memories.value = data.memories;
  } catch (err) {
    error.value = err.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

async function remove(id) {
  try {
    await deleteMemory(id);
    // 本地摘掉而不是重新拉：一次删除不该让整个列表闪一下
    memories.value = memories.value.filter((memory) => memory.id !== id);
  } catch (err) {
    error.value = err.message || "删除失败";
  }
}

onMounted(load);
</script>

<style scoped>
.hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.75;
}
.state {
  font-size: 13px;
  opacity: 0.7;
}
.state.error {
  color: #e5484d;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid rgb(128 128 128 / 0.2);
}
.content {
  flex: 1;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}
.remove {
  flex-shrink: 0;
  border: none;
  background: none;
  color: #e5484d;
  cursor: pointer;
  font-size: 13px;
}
</style>

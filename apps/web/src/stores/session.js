import { defineStore } from "pinia";
import { ref } from "vue";
import { deleteSession, listSessions, renameSession } from "@/apis/session_api";

export const useSessionStore = defineStore("session", () => {
  const list = ref([]);
  const currentId = ref(null);
  const loading = ref(false);

  async function refresh() {
    loading.value = true;
    try {
      list.value = await listSessions();
    } catch {
      // 列表拉不到不该阻塞对话本身，保持上一次的结果
      list.value = list.value ?? [];
    } finally {
      loading.value = false;
    }
  }

  /**
   * 新建会话是纯前端操作：生成 id、切过去就完了，不调任何接口。
   * 这个会话要等用户发出第一条消息、后端 upsert 建行之后才会出现在列表里。
   * 好处是开了新对话又没说话就切走，不会留下一堆空会话。
   */
  function startNew() {
    currentId.value = crypto.randomUUID();
    return currentId.value;
  }

  function select(id) {
    currentId.value = id;
  }

  async function rename(id, title) {
    await renameSession(id, title);
    const target = list.value.find((item) => item.id === id);
    if (target) target.title = title;
  }

  async function remove(id) {
    await deleteSession(id);
    list.value = list.value.filter((item) => item.id !== id);
    if (currentId.value === id) currentId.value = null;
  }

  return { list, currentId, loading, refresh, startNew, select, rename, remove };
});

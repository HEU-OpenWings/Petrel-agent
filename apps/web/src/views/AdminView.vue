<template>
  <div class="admin-page">
    <a-alert
      type="warning"
      show-icon
      message="配额与注册限流尚未实现"
      description="任何注册用户都可以无限量调用模型。公开部署前请先完成配额那一轮。"
      class="admin-warning"
    />

    <a-table
      :columns="columns"
      :data-source="users"
      :loading="loading"
      row-key="id"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="record.role === 'admin' ? 'blue' : 'default'">{{ record.role }}</a-tag>
        </template>

        <template v-if="column.key === 'disabled'">
          <a-tag :color="record.disabled ? 'red' : 'green'">
            {{ record.disabled ? '已禁用' : '正常' }}
          </a-tag>
        </template>

        <template v-if="column.key === 'createdAt'">
          {{ formatDateTime(record.createdAt) }}
        </template>

        <template v-if="column.key === 'action'">
          <a-button
            size="small"
            :danger="!record.disabled"
            :disabled="record.id === userStore.user?.id"
            :loading="pendingId === record.id"
            @click="toggleDisabled(record)"
          >
            {{ record.disabled ? '启用' : '禁用' }}
          </a-button>
        </template>
      </template>
    </a-table>
  </div>
</template>

<script setup>
import { message } from "ant-design-vue";
import { onMounted, ref } from "vue";
import { listUsersApi, setUserDisabledApi } from "@/apis/admin_api";
import { useUserStore } from "@/stores/user";
import { formatDateTime } from "@/utils/time";

const userStore = useUserStore();

const users = ref([]);
const loading = ref(false);
const pendingId = ref(null);

const columns = [
  { title: "邮箱", dataIndex: "email", key: "email" },
  { title: "角色", dataIndex: "role", key: "role", width: 100 },
  { title: "状态", dataIndex: "disabled", key: "disabled", width: 100 },
  { title: "注册时间", dataIndex: "createdAt", key: "createdAt", width: 200 },
  { title: "操作", key: "action", width: 100 },
];

async function load() {
  loading.value = true;
  try {
    const data = await listUsersApi();
    users.value = data.users;
  } catch (error) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function toggleDisabled(record) {
  pendingId.value = record.id;
  try {
    await setUserDisabledApi(record.id, !record.disabled);
    await load();
  } catch (error) {
    message.error(error.message);
  } finally {
    pendingId.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.admin-page {
  padding: 24px;
}

.admin-warning {
  margin-bottom: 16px;
}
</style>

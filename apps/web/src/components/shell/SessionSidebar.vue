<template>
  <nav class="session-sidebar">
    <button class="new-chat" type="button" @click="onNewChat">
      <SquarePen :size="16" />
      <span>新对话</span>
    </button>

    <div class="sessions">
      <div class="group-title">会话</div>
      <div class="empty">暂无历史会话</div>
    </div>

    <div class="bottom">
      <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </RouterLink>

      <div class="user">
        <template v-if="userStore.isLoggedIn">
          <img v-if="userStore.avatar" class="avatar" :src="userStore.avatar" alt="" />
          <span v-else class="avatar fallback">{{ initial }}</span>
          <span class="name">{{ userStore.username || '已登录' }}</span>
        </template>
        <RouterLink v-else to="/login" class="login">
          <LogIn :size="16" />
          <span>未登录</span>
        </RouterLink>
      </div>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { BarChart3, CircleCheck, LibraryBig, LogIn, SquarePen } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useUserStore } from '@/stores/user'

const emit = defineEmits(['new-chat'])

const userStore = useUserStore()

const navItems = [
  { label: '知识库', path: '/knowledge', icon: LibraryBig },
  { label: 'Dashboard', path: '/dashboard', icon: BarChart3 },
  { label: '评测', path: '/eval', icon: CircleCheck }
]

const initial = computed(() => (userStore.username || '?').slice(0, 1).toUpperCase())

function onNewChat() {
  emit('new-chat')
}
</script>

<style lang="less" scoped>
.session-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
  font-size: 14px;
}

.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-strong);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }
}

.sessions {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 16px;
  overflow-y: auto;
}

.group-title {
  padding: 0 10px;
  color: var(--text-faint);
  font-size: 12px;
}

.empty {
  padding: 8px 10px;
  color: var(--text-faint);
  font-size: 13px;
}

.bottom {
  flex: 0 0 auto;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text-muted);
  text-decoration: none;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);
  }

  &.router-link-active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  color: var(--text-muted);
}

.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;

  &.fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 12px;
  }
}

.name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.login {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  text-decoration: none;

  &:hover {
    color: var(--text-strong);
  }
}
</style>

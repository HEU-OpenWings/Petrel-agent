<template>
  <nav class="session-sidebar">
    <button class="new-chat" type="button" @click="onNewChat">
      <SquarePen :size="16" />
      <span>新对话</span>
    </button>

    <div class="sessions">
      <div class="group-title">会话</div>

      <!--
        「加载中…」只在列表还是空的时候显示：下面的 v-for 是独立兄弟节点，不在这条
        v-if 链里，光判 loading 的话，每发一条消息 submit() 都会 refresh() 一次，
        这行字就会插到完整列表上方闪一个网络往返
      -->
      <div v-if="sessionStore.loading && sessionStore.list.length === 0" class="empty">加载中…</div>
      <div v-else-if="sessionStore.list.length === 0" class="empty">暂无历史会话</div>

      <div
        v-for="item in sessionStore.list"
        :key="item.id"
        class="session-item"
        :class="{ active: item.id === sessionStore.currentId }"
        @click="emit('select', item.id)"
      >
        <span class="session-title">{{ item.title }}</span>
        <button class="icon-btn" type="button" title="重命名" @click.stop="onRename(item)">
          <Pencil :size="14" />
        </button>
        <button class="icon-btn" type="button" title="删除" @click.stop="onRemove(item)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>

    <div class="bottom">
      <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
        <component :is="item.icon" :size="16" />
        <span>{{ item.label }}</span>
      </RouterLink>

      <div class="user">
        <template v-if="userStore.isLoggedIn">
          <span class="avatar fallback">{{ initial }}</span>
          <span class="name">{{ userStore.displayName || '已登录' }}</span>
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
import { computed, onMounted } from 'vue'
import {
  BarChart3,
  CircleCheck,
  LibraryBig,
  LogIn,
  Pencil,
  SquarePen,
  Trash2,
  Users
} from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useUserStore } from '@/stores/user'

const emit = defineEmits(['new-chat', 'select'])

const sessionStore = useSessionStore()
const userStore = useUserStore()

onMounted(() => sessionStore.refresh())

// 用 computed 而不是常量：/admin 只对 admin 可见，登录态是异步恢复的（main.js 里
// fetchMe），isAdmin 会从 false 变 true，静态数组不会重新求值
const navItems = computed(() => [
  { label: '知识库', path: '/knowledge', icon: LibraryBig },
  { label: 'Dashboard', path: '/dashboard', icon: BarChart3 },
  { label: '评测', path: '/eval', icon: CircleCheck },
  ...(userStore.isAdmin ? [{ label: '用户管理', path: '/admin', icon: Users }] : [])
])

const initial = computed(() => (userStore.displayName || '?').slice(0, 1).toUpperCase())

function onNewChat() {
  emit('new-chat')
}

async function onRename(item) {
  const title = window.prompt('重命名会话', item.title)?.trim()
  if (!title || title === item.title) return
  try {
    await sessionStore.rename(item.id, title)
  } catch {
    // 失败必须出声：Vue 会把这里抛的 promise 接进 errorHandler，界面上什么都不会发生，
    // 用户看到的只是「标题没变」，分不清是自己点错了还是请求挂了。
    // 用 alert 而不是引一套 toast，跟上面的 prompt / 下面的 confirm 保持一致
    window.alert('重命名失败，请重试')
  }
}

async function onRemove(item) {
  if (!window.confirm(`删除会话「${item.title}」？`)) return
  // 要在 remove 之前判断：remove() 删掉的正是当前会话时会把 currentId 置空，
  // 删完再比就永远不相等，删掉当前会话后界面会停在一个已经不存在的对话上
  const wasCurrent = item.id === sessionStore.currentId
  try {
    await sessionStore.remove(item.id)
  } catch {
    window.alert('删除失败，请重试')
    return
  }
  if (wasCurrent) emit('new-chat')
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

.session-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  // 重命名/删除平时藏起来，避免二十条会话堆一列图标
  .icon-btn {
    opacity: 0;
  }

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);

    .icon-btn {
      opacity: 1;
    }
  }

  &.active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.session-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
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

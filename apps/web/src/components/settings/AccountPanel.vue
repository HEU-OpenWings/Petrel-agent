<template>
  <div class="account">
    <div class="field">
      <span class="label">邮箱</span>
      <span class="value">{{ userStore.user?.email ?? '—' }}</span>
    </div>

    <a-divider />

    <h4 class="title">修改密码</h4>
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical" @finish="onSubmit">
      <a-form-item label="当前密码" name="currentPassword">
        <a-input-password v-model:value="form.currentPassword" autocomplete="current-password" />
      </a-form-item>

      <a-form-item label="新密码" name="newPassword">
        <a-input-password v-model:value="form.newPassword" autocomplete="new-password" />
      </a-form-item>

      <a-form-item label="确认新密码" name="confirmPassword">
        <a-input-password v-model:value="form.confirmPassword" autocomplete="new-password" />
      </a-form-item>

      <a-button type="primary" html-type="submit" :loading="submitting">修改密码</a-button>
    </a-form>

    <p class="note">修改密码后，其他设备上的会话会立即失效（tokenVersion 机制）。</p>

    <a-divider />

    <h4 class="title">退出所有设备</h4>
    <a-button danger :loading="loggingOutAll" @click="onLogoutAll">退出所有设备</a-button>
    <p class="note">会让所有设备（包括当前这台）立即回到登录页。</p>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useRouter } from 'vue-router'
import { changePassword, logoutAllDevices } from '@/apis/account_api'
import { useUserStore } from '@/stores/user'

/** 与后端 apps/server/src/services/auth.ts 的 PASSWORD_MIN_LENGTH 对齐，改一处要改两处 */
const PASSWORD_MIN_LENGTH = 8

const userStore = useUserStore()
const router = useRouter()
const formRef = ref(null)
const submitting = ref(false)
const loggingOutAll = ref(false)

const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const rules = {
  currentPassword: [{ required: true, message: '请输入当前密码' }],
  newPassword: [
    { required: true, message: '请输入新密码' },
    { min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码' },
    {
      validator: (_rule, value) =>
        value === form.newPassword ? Promise.resolve() : Promise.reject('两次输入的密码不一致')
    }
  ]
}

async function onSubmit() {
  submitting.value = true
  try {
    await changePassword(form.currentPassword, form.newPassword)
    message.success('密码已修改')
    // 成功后清空三个字段，包含 currentPassword——不让密码明文停留在输入框。
    // 失败时故意不清空，用户要能改一下重试
    formRef.value?.resetFields()
  } catch (error) {
    // 后端的文案更有用（「当前密码不正确」/「尝试次数过多」），原样显示。
    // 旧密码错误是 403，不会触发 http.js 只针对 401 的全局登出分支；
    // 真正的登录失效仍会正常清状态并跳转登录页
    message.error(error.message || '修改失败，请重试')
  } finally {
    submitting.value = false
  }
}

async function onLogoutAll() {
  loggingOutAll.value = true
  try {
    await logoutAllDevices()
    message.success('已退出所有设备')
    // 后端已把当前 cookie 清掉（tokenVersion 也自增了），本地状态同步清空并回登录页
    await userStore.logout()
    router.push('/login')
  } catch (error) {
    message.error(error.message || '退出失败，请重试')
  } finally {
    loggingOutAll.value = false
  }
}
</script>

<style lang="less" scoped>
.account {
  font-size: 14px;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.label {
  color: var(--text-strong);
}

.value {
  color: var(--text-muted);
}

.title {
  margin: 0 0 12px;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}

.note {
  margin: 16px 0 0;
  color: var(--text-faint);
  font-size: 12px;
}
</style>

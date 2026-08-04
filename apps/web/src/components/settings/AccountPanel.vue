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

    <!--
      写清这条局限：改完密码其他设备上的旧 token 在 7 天内仍然有效。
      JWT 无状态，彻底解决要 tokenVersion，见 CLAUDE.md「尚未实现」。
      不写的话用户会以为「改密码 = 把别人踢下线」
    -->
    <p class="note">修改密码后，其他设备上已登录的会话最长 7 天后才会失效。</p>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { changePassword } from '@/apis/account_api'
import { useUserStore } from '@/stores/user'

/** 与后端 apps/server/src/services/auth.ts 的 PASSWORD_MIN_LENGTH 对齐，改一处要改两处 */
const PASSWORD_MIN_LENGTH = 8

const userStore = useUserStore()
const formRef = ref(null)
const submitting = ref(false)

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
    // 这里不会把人踢下线：account_api 的 changePassword 带了
    // treatUnauthorizedAsRequestError，401 不走 http.js 的全局登出分支
    message.error(error.message || '修改失败，请重试')
  } finally {
    submitting.value = false
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

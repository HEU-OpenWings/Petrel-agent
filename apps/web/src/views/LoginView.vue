<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">Petrel</h1>
      <p class="login-subtitle">{{ isRegister ? '创建账号' : '登录以继续' }}</p>

      <a-form layout="vertical" :model="form" @finish="handleSubmit">
        <a-form-item label="邮箱" name="email" :rules="[{ required: true, message: '请输入邮箱' }]">
          <a-input
            v-model:value="form.email"
            type="email"
            placeholder="you@example.com"
            autocomplete="username"
            size="large"
          />
        </a-form-item>

        <a-form-item label="密码" name="password" :rules="[{ required: true, message: '请输入密码' }]">
          <a-input-password
            v-model:value="form.password"
            :placeholder="isRegister ? '至少 8 位' : ''"
            :autocomplete="isRegister ? 'new-password' : 'current-password'"
            size="large"
          />
        </a-form-item>

        <a-alert
          v-if="errorMessage"
          type="error"
          :message="errorMessage"
          show-icon
          class="login-error"
        />
        <a-alert
          v-if="successMessage"
          type="success"
          :message="successMessage"
          show-icon
          class="login-error"
        />

        <a-button type="primary" html-type="submit" size="large" block :loading="submitting">
          {{ isRegister ? '注册' : '登录' }}
        </a-button>
      </a-form>

      <div v-if="!isRegister" class="login-forgot">
        <a href="/api/auth/forgot-password">忘记密码？</a>
        <a-button
          v-if="resendVisible"
          type="link"
          size="small"
          :loading="resending"
          @click="resendVerification"
        >
          重新发送验证邮件
        </a-button>
      </div>

      <div class="login-switch">
        <span>{{ isRegister ? '已经有账号了？' : '还没有账号？' }}</span>
        <a-button type="link" @click="toggleMode">
          {{ isRegister ? '去登录' : '去注册' }}
        </a-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resendVerificationApi } from '@/apis/auth_api'
import { useUserStore } from '@/stores/user'
import { safeRedirect } from '@/utils/redirect'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const isRegister = ref(false)
const submitting = ref(false)
const resending = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const form = reactive({ email: '', password: '' })

// 后端登录被拒的 403 文案（未验证邮箱）出现时，给「重新发送验证邮件」入口
const resendVisible = computed(() => !isRegister.value && errorMessage.value.includes('邮箱尚未验证'))

function toggleMode() {
  isRegister.value = !isRegister.value
  errorMessage.value = ''
  successMessage.value = ''
}

async function handleSubmit() {
  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    if (isRegister.value) {
      const data = await userStore.register(form.email, form.password)
      // 注册不再自动登录：按后端返回区分三种情况，切回登录模式
      if (data.verificationSent) {
        successMessage.value = `验证邮件已发送到 ${form.email}，请查收后登录`
      } else if (data.user?.emailVerifiedAt) {
        // EMAIL_VERIFICATION_ENABLED=false（开发/内网演示）：注册即已验证
        successMessage.value = '注册成功，请登录'
      } else {
        successMessage.value = '注册成功，但验证邮件发送失败，可点击「重新发送验证邮件」'
      }
      isRegister.value = false
      return
    } else {
      await userStore.login(form.email, form.password)
    }
    // 守卫把原目标放在 redirect 里，登录后回到它；safeRedirect 挡开放重定向
    router.push(safeRedirect(route.query.redirect))
  } catch (error) {
    errorMessage.value = error.message || '操作失败，请重试'
  } finally {
    submitting.value = false
  }
}

async function resendVerification() {
  resending.value = true
  try {
    await resendVerificationApi(form.email)
    successMessage.value = `验证邮件已重新发送到 ${form.email}，请查收`
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = error.message || '重发失败，请稍后再试'
  } finally {
    resending.value = false
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--gray-10);
}

.login-card {
  width: 100%;
  max-width: 380px;
  padding: 40px;
  background: var(--gray-0);
  border: 1px solid var(--gray-150);
  border-radius: 24px;
  box-shadow: 0 18px 36px var(--shadow-1);
}

.login-title {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
  text-align: center;
  color: var(--main-color);
}

.login-subtitle {
  margin: 8px 0 32px;
  text-align: center;
  color: var(--gray-600);
}

.login-error {
  margin-bottom: 16px;
}

.login-forgot {
  margin-top: 12px;
  text-align: right;
  font-size: 14px;
}

.login-forgot a {
  color: var(--main-color);
}

.login-switch {
  margin-top: 16px;
  text-align: center;
  color: var(--gray-600);
}
</style>

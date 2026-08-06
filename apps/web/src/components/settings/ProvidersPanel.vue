<template>
  <div v-if="preferences.loadFailed" class="failed">
    <p>模型服务状态读取失败。</p>
    <a-button size="small" @click="retry">重试</a-button>
  </div>

  <a-spin v-else-if="!preferences.loaded" />

  <div v-else class="providers">
    <div
      v-for="provider in providerList"
      :key="provider.id"
      class="provider-row"
      :class="{ expanded: expandedId === provider.id }"
    >
      <div class="row-header" @click="toggle(provider.id)">
        <span class="provider-name">
          {{ provider.name }}
          <a-tag v-if="provider.isDefault" color="blue" size="small" class="default-tag">默认</a-tag>
        </span>
        <span class="meta">
          <template v-if="provider.configured">
            <a-tag color="green">已配置</a-tag>
          </template>
          <a-tag v-else color="default">未配置</a-tag>
        </span>
        <span class="arrow">{{ expandedId === provider.id ? '▾' : '▸' }}</span>
      </div>

      <transition name="expand">
        <div v-if="expandedId === provider.id" class="row-body">
          <!-- 已配置 -->
          <template v-if="provider.configured">
            <div class="section-title">可用模型</div>
            <div class="models">
              <a-tag v-for="model in provider.models" :key="model.id" color="blue">
                {{ model.name }}
              </a-tag>
            </div>
            <div class="source-info">
              <span class="source-label">凭据来源：</span>
              <code>{{ provider.envVars.join(' / ') }}</code>
            </div>
          </template>

          <!-- 未配置（API key 类） -->
          <template v-else-if="provider.envVars.length > 0">
            <div class="section-title">
              输入 API key 即可使用
            </div>
            <div v-if="provider.note" class="note">
              <span class="note-label">获取方式：</span>{{ provider.note }}
            </div>

            <!-- R1 凭据管理（主力） -->
            <div class="credential-section">
              <div v-if="credState(provider.id).stored" class="credential-status stored">
                当前凭据已保存
              </div>

              <div class="credential-input-row">
                <a-input-password
                  v-model:value="credState(provider.id).apiKey"
                  :placeholder="'粘贴 ' + provider.envVars[0]"
                  :disabled="credState(provider.id).saving"
                  size="small"
                  class="credential-input"
                  @keydown.enter="saveKey(provider.id)"
                />
              </div>

              <div class="credential-actions">
                <a-button
                  size="small"
                  type="primary"
                  :loading="credState(provider.id).saving"
                  :disabled="!credState(provider.id).apiKey"
                  @click.stop="saveKey(provider.id)"
                >
                  保存并测试
                </a-button>
              </div>

              <div v-if="credState(provider.id).testResult" class="test-result" :class="credState(provider.id).testResult">
                <template v-if="credState(provider.id).testResult === 'success'">
                  连接测试通过，已生效
                </template>
                <template v-else>
                  连接测试失败：{{ credState(provider.id).testError }}
                </template>
              </div>
            </div>

            <!-- .env 方式（可选，折叠） -->
            <div class="env-fallback">
              <div class="env-fallback-toggle" @click="envOpen[provider.id] = !envOpen[provider.id]">
                <span class="env-fallback-arrow">{{ envOpen[provider.id] ? '▾' : '▸' }}</span>
                通过 .env 配置（需重启服务）
              </div>
              <div v-if="envOpen[provider.id]" class="env-fallback-body">
                <div v-for="envVar in provider.envVars" :key="envVar" class="env-line">
                  <code>{{ envVar }}=&lt;your-key&gt;</code>
                  <a-button size="small" type="link" @click.stop="copyEnv(envVar)">复制</a-button>
                </div>
                <div class="action">
                  <span class="action-icon">ℹ</span>
                  配置后执行 <code>docker compose up -d</code> 生效（环境变量不热重载）
                </div>
              </div>
            </div>
          </template>

          <!-- 未配置（本地服务类，无 envVars） -->
          <template v-else>
            <div class="section-title">
              注册模型 —— 请确认本地服务已启动
            </div>
            <div v-if="provider.note" class="note">
              {{ provider.note }}
            </div>
            <div class="action">
              <span class="action-icon">ℹ</span>
              {{ provider.name }} 为本地推理服务，通常无需 API key。请确认服务已启动后执行 <code>docker compose up -d</code>
            </div>
          </template>

          <!-- 已配置的凭据管理（补充） -->
          <template v-if="provider.configured && provider.envVars.length > 0">
            <div class="credential-divider" />
            <div class="credential-section">
              <div class="section-title">凭据管理</div>

              <div v-if="credState(provider.id).stored" class="credential-status stored">
                当前凭据已保存
              </div>

              <div class="credential-input-row">
                <a-input-password
                  v-model:value="credState(provider.id).apiKey"
                  :placeholder="'输入新的 ' + provider.envVars[0] + ' 替换当前凭据'"
                  :disabled="credState(provider.id).saving"
                  size="small"
                  class="credential-input"
                  @keydown.enter="saveKey(provider.id)"
                />
              </div>

              <div class="credential-actions">
                <a-button
                  size="small"
                  type="primary"
                  :loading="credState(provider.id).saving"
                  :disabled="!credState(provider.id).apiKey"
                  @click.stop="saveKey(provider.id)"
                >
                  保存并测试
                </a-button>
                <a-button
                  size="small"
                  :loading="credState(provider.id).testing"
                  @click.stop="testKey(provider.id)"
                >
                  测试连接
                </a-button>
                <a-button
                  v-if="credState(provider.id).stored"
                  size="small"
                  danger
                  :loading="credState(provider.id).deleting"
                  @click.stop="deleteKey(provider.id)"
                >
                  删除
                </a-button>
              </div>

              <div v-if="credState(provider.id).testResult" class="test-result" :class="credState(provider.id).testResult">
                <template v-if="credState(provider.id).testResult === 'success'">
                  连接测试通过
                </template>
                <template v-else>
                  连接测试失败：{{ credState(provider.id).testError }}
                </template>
              </div>
            </div>
          </template>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { usePreferencesStore } from '@/stores/preferences'
import { deleteProviderCredential, saveProviderCredential, testProviderCredential } from '@/apis/provider_api'

/**
 * Provider 元数据。
 *
 * 当前为硬编码清单，后续后端 GET /api/providers 到位后应切换到动态数据。
 */
const PROVIDER_META = [
  { id: 'deepseek', name: 'DeepSeek', envVars: ['DEEPSEEK_API_KEY'], note: 'DeepSeek 官方 API key，在 https://platform.deepseek.com 获取' },
  { id: 'siliconflow', name: 'SiliconFlow', envVars: ['SILICONFLOW_API_KEY'], note: '硅基流动 API key，在 https://siliconflow.cn 获取' },
  { id: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'], note: 'OpenAI API key，在 https://platform.openai.com/api-keys 获取' },
  { id: 'anthropic', name: 'Anthropic', envVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'], note: 'Anthropic key（ANTHROPIC_AUTH_TOKEN 优先，也接受 ANTHROPIC_API_KEY）' },
  { id: 'google', name: 'Google', envVars: ['GEMINI_API_KEY'], note: 'Google AI / Gemini API key' },
  { id: 'moonshotai', name: 'Moonshot', envVars: ['MOONSHOT_API_KEY'], note: 'Moonshot / Kimi API key' },
  { id: 'minimax', name: 'MiniMax', envVars: ['MINIMAX_API_KEY'], note: 'MiniMax API key' },
  { id: 'zai', name: 'Z.AI', envVars: ['ZAI_API_KEY'], note: '智谱 Z.AI API key' },
  { id: 'qwen-token-plan', name: '阿里 Qwen', envVars: ['QWEN_TOKEN_PLAN_API_KEY'], note: '阿里 Qwen Token Plan API key' },
  { id: 'ollama', name: 'Ollama（本地）', envVars: [], note: '本地推理服务，请确认已启动 Ollama（默认 http://localhost:11434）并 ollama pull 模型' },
  { id: 'vllm', name: 'vLLM（本地）', envVars: [], note: '本地推理服务，通过 VLLM_BASE_URL 指定服务地址' },
]

const preferences = usePreferencesStore()
const expandedId = ref(null)

// .env 说明的折叠状态（默认折叠）
const envOpen = reactive({})

// ---- 每个 provider 的凭据管理局部状态 ----
const credentialStates = reactive({})

/** 获取或懒创建某个 provider 的凭据状态 */
function credState(providerId) {
  if (!credentialStates[providerId]) {
    credentialStates[providerId] = reactive({
      apiKey: '',
      saving: false,
      testing: false,
      deleting: false,
      stored: false,
      testResult: null, // null | 'success' | 'failure'
      testError: ''
    })
  }
  return credentialStates[providerId]
}

/** 系统默认模型对应的 provider id，用于动态计算默认标签 */
const systemDefaultProviderId = computed(() => {
  const defaultModel = preferences.models.find((m) => m.isDefault)
  return defaultModel?.provider ?? null
})

const providerList = computed(() => {
  const grouped = new Map()
  for (const model of preferences.models) {
    if (!grouped.has(model.provider)) grouped.set(model.provider, [])
    grouped.get(model.provider).push(model)
  }
  return PROVIDER_META.map((meta) => {
    const models = grouped.get(meta.id) ?? []
    return { ...meta, configured: models.length > 0, models, isDefault: meta.id === systemDefaultProviderId.value }
  })
})

function toggle(id) {
  expandedId.value = expandedId.value === id ? null : id
}

function retry() {
  void preferences.ensureLoaded()
}

async function copyEnv(envVar) {
  const text = `${envVar}=<your-key>`
  try {
    await navigator.clipboard.writeText(text)
    message.success(`已复制：${text}`)
  } catch {
    message.error('复制失败')
  }
}

// ---- R1 凭据管理操作 ----

/** 保存 API key（后端强制 test-before-save） */
async function saveKey(providerId) {
  const state = credState(providerId)
  if (!state.apiKey || state.saving) return

  state.saving = true
  state.testResult = null
  try {
    await saveProviderCredential(providerId, state.apiKey)
    state.stored = true
    state.testResult = 'success'
    message.success('已保存，凭据已生效')
  } catch (error) {
    state.testResult = 'failure'
    state.testError = error.message
    // 不吞掉错误——后端 test-before-save 失败时 key 不会落库，保留输入让用户修改
  } finally {
    state.saving = false
  }
}

/** 测试当前凭据或输入框中待保存的 key */
async function testKey(providerId) {
  const state = credState(providerId)
  if (state.testing) return

  state.testing = true
  state.testResult = null
  try {
    const candidateKey = state.apiKey || undefined
    await testProviderCredential(providerId, candidateKey)
    state.testResult = 'success'
    message.success('连接测试通过')
  } catch (error) {
    state.testResult = 'failure'
    state.testError = error.message
  } finally {
    state.testing = false
  }
}

/** 删除 DB 中的 key，回落到环境变量 */
async function deleteKey(providerId) {
  const state = credState(providerId)
  if (state.deleting) return

  state.deleting = true
  try {
    await deleteProviderCredential(providerId)
    state.stored = false
    state.apiKey = ''
    message.success('已删除。若环境变量中仍有配置则继续可用')
  } catch (error) {
    message.error(error.message || '删除失败')
  } finally {
    state.deleting = false
  }
}
</script>

<style lang="less" scoped>
.failed {
  color: var(--text-muted);
  font-size: 14px;
  p { margin: 0 0 12px; }
}

.providers {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.provider-row {
  border-bottom: 1px solid var(--border-subtle);

  &:last-child { border-bottom: none; }
}

.row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
    margin: 0 -12px;
    padding: 10px 12px;
    border-radius: 6px;
  }
}

.provider-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-strong);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.default-tag {
  font-size: 11px;
  line-height: 1;
  padding: 0 6px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.arrow {
  font-size: 12px;
  color: var(--text-muted);
  flex: 0 0 auto;
  transition: transform 0.2s ease;
}

.row-body {
  padding: 0 0 14px;
  overflow: hidden;
}

.section-title {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.source-info {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;

  code {
    padding: 2px 8px;
    font-size: 12px;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    color: var(--text-strong);
  }
}

.source-label {
  flex-shrink: 0;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

// .env 备用方式（折叠）
.env-fallback {
  margin-top: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.env-fallback-toggle {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }
}

.env-fallback-arrow {
  display: inline-block;
  width: 14px;
  font-size: 11px;
}

.env-fallback-body {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.env-line {
  display: flex;
  align-items: center;
  gap: 8px;

  code {
    padding: 4px 12px;
    font-size: 13px;
    background: var(--surface-hover);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    color: var(--text-strong);
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
}

.note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;

  .note-label {
    font-weight: 500;
    color: var(--text-secondary);
  }
}

.action {
  margin-top: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface-hover);
  border-radius: 6px;
  line-height: 1.6;

  .action-icon {
    margin-right: 4px;
  }

  code {
    padding: 1px 6px;
    font-size: 12px;
    background: var(--surface-elevated);
    border-radius: 4px;
    color: var(--text-strong);
  }
}

// ---- R1 凭据管理 ----

.credential-divider {
  margin: 14px 0 10px;
  border-top: 1px solid var(--border-subtle);
}

.credential-section {
  margin-top: 10px;

  .section-title {
    margin-bottom: 10px;
  }
}

.credential-status {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  margin-bottom: 8px;

  &.stored {
    color: #389e0d;
    background: #f6ffed;
    border: 1px solid #b7eb8f;
  }
}

.credential-input-row {
  margin-bottom: 8px;
}

.credential-input {
  width: 100%;
}

.credential-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.test-result {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 4px;
  line-height: 1.5;

  &.success {
    color: #389e0d;
    background: #f6ffed;
    border: 1px solid #b7eb8f;
  }

  &.failure {
    color: #cf1322;
    background: #fff2f0;
    border: 1px solid #ffa39e;
  }
}

// 展开/收起过渡
.expand-enter-active,
.expand-leave-active {
  transition: all 0.25s ease;
  max-height: 800px;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
}
</style>

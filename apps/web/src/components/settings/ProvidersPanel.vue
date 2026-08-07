<template>
  <div v-if="loadFailed" class="failed">
    <p>模型服务状态读取失败。</p>
    <a-button size="small" @click="load">重试</a-button>
  </div>

  <a-spin v-else-if="loading" />

  <!-- B4：空态。成功加载但无 provider 时，不能渲染成空白 -->
  <div v-else-if="providers.length === 0" class="empty">
    <p>未发现已注册的模型服务。</p>
  </div>

  <div v-else class="providers">
    <div
      v-for="provider in providers"
      :key="provider.id"
      class="provider-row"
      :class="{ expanded: expandedId === provider.id }"
    >
      <div class="row-header" @click="toggle(provider.id)">
        <span class="provider-name">
          {{ provider.name }}
          <a-tag v-if="provider.isDefault" color="blue" size="small" class="default-tag"
            >默认</a-tag
          >
        </span>
        <span class="meta">
          <!-- 严格三态：null 是「读取失败」，绝不能和 false 混为「未配置」 -->
          <template v-if="provider.configured === true">
            <a-tag color="green">已配置</a-tag>
          </template>
          <template v-else-if="provider.configured === false">
            <a-tag color="default">未配置</a-tag>
          </template>
          <template v-else>
            <a-tag color="orange">状态读取失败</a-tag>
          </template>
        </span>
        <span class="arrow">{{ expandedId === provider.id ? '▾' : '▸' }}</span>
      </div>

      <transition name="expand">
        <div v-if="expandedId === provider.id" class="row-body">
          <!-- degraded 优先提示（哪怕 configured=true，availability 查询失败也算 degraded）。
               注意「已配置」只代表凭据材料完整，不代表 key 有效或服务在线。 -->
          <div v-if="provider.runtimeStatus === 'degraded'" class="note degraded-note">
            <span class="action-icon">⚠</span>{{ provider.statusMessage }}
          </div>

          <!-- B1：支持的环境变量三态都显示（configured=null 时用户最需要排查，不能藏起来） -->
          <div v-if="provider.envVars.length > 0" class="source-info">
            <span class="source-label">支持的环境变量：</span>
            <code>{{ provider.envVars.join(' / ') }}</code>
          </div>

          <!-- 已配置：展示模型目录（懒加载，按 available 三态区分） -->
          <template v-if="provider.configured === true">
            <div class="section-title">
              模型目录（{{ provider.availableModelCount ?? '—' }} 可用 /
              {{ provider.modelCount }} 注册）
            </div>
          </template>

          <!-- 未配置（API key 类）：B2 文案改为克制的「提供凭据」，不暗示「即可使用」 -->
          <template v-else-if="provider.configured === false && provider.envVars.length > 0">
            <div class="section-title">
              未配置 — 提供凭据后可用（已注册 {{ provider.modelCount }} 个模型）
            </div>
            <div v-if="provider.note" class="note">
              <span class="note-label">获取方式：</span>{{ provider.note }}
            </div>
            <div class="env-config">
              <div v-for="envVar in provider.envVars" :key="envVar" class="env-line">
                <code>{{ envVar }}=&lt;your-key&gt;</code>
                <a-button size="small" type="link" @click.stop="copyEnv(envVar)">复制</a-button>
              </div>
              <div class="action">
                <span class="action-icon">ℹ</span>
                在 <code>.env</code> 中填入后执行
                <code>docker compose up -d</code> 生效（环境变量不热重载，不能用 restart）
              </div>
            </div>
          </template>

          <!-- 未配置（本地服务类，无凭据 envVars） -->
          <template v-else-if="provider.configured === false">
            <div class="section-title">
              本地推理服务（已注册 {{ provider.modelCount }} 个占位模型）
            </div>
            <div v-if="provider.note" class="note">{{ provider.note }}</div>
            <div class="action">
              <span class="action-icon">ℹ</span>
              配置后执行 <code>docker compose up -d</code> 生效
            </div>
          </template>

          <!-- B3：模型目录（已配置、未配置都懒加载，按 available 三态渲染） -->
          <a-spin v-if="modelsLoading[provider.id]" size="small" />
          <template v-else-if="modelsState[provider.id]">
            <div class="models">
              <a-tag
                v-for="model in modelsState[provider.id].models"
                :key="model.id"
                :color="modelTagColor(model.available)"
              >
                {{ model.name }}
                <span v-if="model.isDefault" class="model-default">（默认）</span>
              </a-tag>
            </div>
            <div v-if="provider.configured === false" class="hint">
              <span class="action-icon">ℹ</span>已注册的模型；配置凭据后可选择
            </div>
          </template>
          <!-- B3：详情请求失败 → 显式错误 + 重试，不静默吞成空数组 -->
          <div v-else-if="modelsError[provider.id]" class="failed-inline">
            <span>模型目录读取失败。</span>
            <a-button size="small" type="link" @click.stop="loadModels(provider.id)">重试</a-button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { fetchProviderModels, fetchProviders } from '@/apis/provider_api'

/**
 * 模型服务面板（R0 只读）。
 *
 * 数据源是后端 GET /api/providers（方案 C 扁平契约），不再用硬编码 provider 清单 +
 * usePreferencesStore 推导——后者列不出未配置 provider，正是 HEU-53 要补的缺口。
 *
 * 本期不含凭据管理（R1：在 UI 填 key 即时生效），那需要 admin 权限、加密落库与运行时
 * 改造，是独立的 issue。所以这里没有任何保存/测试/删除按钮。
 *
 * 文案红线（对应契约语义）：configured=true 只代表「凭据材料完整」，绝不写成「可用 /
 * 连接正常」——远端有效性需要真实模型调用才能证明，那超出 R0。
 */
const loading = ref(false)
const loadFailed = ref(false)
const providers = ref([])

const expandedId = ref(null)
// 展开某 provider 时懒加载它的模型目录，按 provider id 缓存
const modelsState = reactive({}) // { [id]: { models: ProviderModelStatus[] } }
const modelsLoading = reactive({})
const modelsError = reactive({}) // { [id]: boolean } 详情请求失败标记（与「空目录」区分）

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const data = await fetchProviders()
    providers.value = data.providers
  } catch {
    // 加载失败要显式提示 + 重试，不能用空列表冒充「无 provider」
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function loadModels(providerId) {
  if (modelsLoading[providerId]) return
  // 清掉旧的错误态，允许重试覆盖
  delete modelsError[providerId]
  delete modelsState[providerId]
  modelsLoading[providerId] = true
  try {
    const data = await fetchProviderModels(providerId)
    modelsState[providerId] = { models: data.models }
  } catch {
    // B3：详情请求失败用独立 error 状态，不静默缓存成空数组
    modelsError[providerId] = true
  } finally {
    modelsLoading[providerId] = false
  }
}

async function toggle(id) {
  expandedId.value = expandedId.value === id ? null : id
  // 展开任何 provider 都懒加载模型目录（未配置也展示「已注册但不可选」）
  if (expandedId.value === id && !modelsState[id] && !modelsError[id]) {
    loadModels(id)
  }
}

/** B3：按 available 三态选 tag 颜色。null（未知）用 orange 区别于 false（灰）。 */
function modelTagColor(available) {
  if (available === true) return 'blue'
  if (available === null) return 'orange'
  return 'default'
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

// 挂载即加载（组件只在 SettingsModal 打开「模型服务」tab 时才渲染）
load()
</script>

<style lang="less" scoped>
.failed {
  color: var(--text-muted);
  font-size: 14px;
  p {
    margin: 0 0 12px;
  }
}

.empty {
  color: var(--text-muted);
  font-size: 14px;
}

.providers {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.provider-row {
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
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
  margin: 10px 0 8px;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.model-default {
  font-size: 11px;
  opacity: 0.8;
}

.hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
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

.env-config {
  margin-top: 8px;
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

.degraded-note {
  color: #d46b08;
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 6px;

  .action-icon {
    margin-right: 4px;
  }
}

.failed-inline {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
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

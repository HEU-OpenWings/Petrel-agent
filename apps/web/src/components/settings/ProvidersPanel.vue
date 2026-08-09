<template>
  <section class="provider-panel" aria-labelledby="provider-panel-title">
    <header class="panel-heading">
      <div>
        <h2 id="provider-panel-title">模型服务</h2>
        <p>为当前账号管理个人 Provider 凭据。保存与连接测试相互独立，保存不会访问上游。</p>
      </div>
      <span v-if="capabilities" class="runtime-mode">
        {{ capabilities.storedCredentialsEnabled ? "个人凭据运行时已启用" : "仅使用系统凭据运行时" }}
      </span>
    </header>

    <div
      v-if="managementOnly"
      class="mode-notice"
      role="status"
    >
      <span class="notice-mark">i</span>
      个人凭据可以保存、测试和删除，但运行时开关尚未启用；已保存的个人凭据尚未用于对话。
    </div>

    <div v-if="loadFailed" class="failed">
      <p>模型服务状态读取失败。</p>
      <a-button size="small" @click="load()">重试</a-button>
    </div>

    <div v-else-if="loading" class="loading"><a-spin /></div>

    <div v-else-if="providers.length === 0" class="empty">
      <p>未发现已注册的模型服务。</p>
    </div>

    <div v-else class="providers">
      <article
        v-for="provider in providers"
        :key="provider.id"
        class="provider-row"
        :class="{ expanded: expandedId === provider.id }"
      >
        <button
          type="button"
          class="row-header"
          :aria-expanded="expandedId === provider.id"
          :aria-controls="`provider-details-${provider.id}`"
          @click="toggle(provider.id)"
        >
          <span class="provider-identity">
            <span class="provider-name">{{ provider.name }}</span>
            <span v-if="provider.isDefault" class="default-pill">默认</span>
          </span>

          <span class="status-cluster">
            <span class="status-pill" :class="configuredClass(provider.configured)">
              {{ configuredLabel(provider.configured) }}
            </span>
            <span
              v-if="provider.personalCredential.status === 'stored'"
              class="status-pill personal"
            >
              个人凭据 {{ provider.personalCredential.keyHint }}
            </span>
            <span class="source-label">{{ runtimeSourceLabel(provider.runtimeCredentialSource) }}</span>
          </span>

          <span class="arrow" aria-hidden="true">{{ expandedId === provider.id ? "▾" : "▸" }}</span>
        </button>

        <transition name="expand">
          <div
            v-if="expandedId === provider.id"
            :id="`provider-details-${provider.id}`"
            class="row-body"
          >
            <div v-if="provider.runtimeStatus === 'degraded'" class="degraded-note" role="status">
              <span aria-hidden="true">!</span>{{ provider.statusMessage }}
            </div>

            <dl class="credential-summary">
              <div>
                <dt>个人凭据</dt>
                <dd>{{ personalCredentialLabel(provider.personalCredential) }}</dd>
              </div>
              <div>
                <dt>对话运行时</dt>
                <dd>{{ runtimeSourceDescription(provider.runtimeCredentialSource) }}</dd>
              </div>
              <div>
                <dt>模型目录</dt>
                <dd>{{ provider.availableModelCount ?? "—" }} 可用 / {{ provider.modelCount }} 注册</dd>
              </div>
            </dl>

            <div v-if="capabilities?.credentialManagementEnabled" class="credential-card">
              <div class="credential-card-heading">
                <div>
                  <h3>个人 API Key</h3>
                  <p>密钥仅用于当前账号；草稿只保留在本设置窗口内。</p>
                </div>
                <span v-if="provider.personalCredential.updatedAt" class="updated-at">
                  更新于 {{ formatUpdatedAt(provider.personalCredential.updatedAt) }}
                </span>
              </div>

              <label class="key-label" :for="`provider-key-${provider.id}`">API Key</label>
              <a-input-password
                :id="`provider-key-${provider.id}`"
                v-model:value="draftKeys[provider.id]"
                class="key-input"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                :spellcheck="false"
                :disabled="saveLoading[provider.id] || deleteLoading[provider.id]"
                placeholder="输入新的 API Key；不会显示已保存的值"
                @input="markDraft(provider.id)"
              />

              <div class="operation-actions">
                <a-button
                  type="primary"
                  size="small"
                  :loading="saveLoading[provider.id]"
                  :disabled="!draftTouched[provider.id] || deleteLoading[provider.id]"
                  @click="save(provider.id)"
                >
                  保存或覆盖
                </a-button>
                <a-button
                  size="small"
                  :loading="testLoading[provider.id]"
                  :disabled="saveLoading[provider.id] || deleteLoading[provider.id]"
                  @click="testConnection(provider.id)"
                >
                  {{ draftTouched[provider.id] ? "测试当前草稿" : "测试当前凭据" }}
                </a-button>
                <a-popconfirm
                  title="删除当前账号保存的个人凭据？"
                  description="删除后将重新计算模型可用性与默认模型；系统环境凭据仍可能继续可用。"
                  ok-text="删除"
                  cancel-text="取消"
                  placement="topRight"
                  @confirm="remove(provider.id)"
                >
                  <a-button
                    danger
                    size="small"
                    :loading="deleteLoading[provider.id]"
                    :disabled="provider.personalCredential.status !== 'stored' || saveLoading[provider.id]"
                  >
                    删除个人凭据
                  </a-button>
                </a-popconfirm>
              </div>

              <div class="probe-warning">
                <span aria-hidden="true">!</span>
                测试会向上游发送固定的最小请求，可能产生费用、触发上游限流，并形成 Provider
                侧审计记录。测试不会保存草稿，也不消耗聊天 Token 配额。
              </div>

              <div class="operation-results" aria-live="polite">
                <p
                  v-if="saveResult[provider.id]"
                  class="operation-result"
                  :class="saveResult[provider.id].kind"
                >
                  <span>保存</span>{{ saveResult[provider.id].message }}
                </p>
                <p
                  v-if="testResult[provider.id]"
                  class="operation-result"
                  :class="testResult[provider.id].kind"
                >
                  <span>测试</span>{{ testResult[provider.id].message }}
                </p>
                <p
                  v-if="deleteResult[provider.id]"
                  class="operation-result"
                  :class="deleteResult[provider.id].kind"
                >
                  <span>删除</span>{{ deleteResult[provider.id].message }}
                </p>
              </div>
            </div>

            <div v-else class="management-disabled">
              当前已冻结个人凭据管理；现有运行时来源保持不变。
            </div>

            <div v-if="provider.envVars.length > 0" class="ambient-info">
              <span>系统环境 fallback</span>
              <code v-for="envVar in provider.envVars" :key="envVar">{{ envVar }}</code>
            </div>

            <section class="model-section" :aria-labelledby="`model-title-${provider.id}`">
              <div class="model-heading">
                <h3 :id="`model-title-${provider.id}`">注册模型</h3>
                <button
                  v-if="modelsError[provider.id]"
                  type="button"
                  class="retry-link"
                  @click.stop="loadModels(provider.id, { force: true })"
                >
                  重试
                </button>
              </div>

              <a-spin v-if="modelsLoading[provider.id]" size="small" />
              <div v-else-if="modelsState[provider.id]" class="models">
                <a-tag
                  v-for="model in modelsState[provider.id].models"
                  :key="model.id"
                  :color="modelTagColor(model.available)"
                >
                  {{ model.name }}<span v-if="model.isDefault">（默认）</span>
                </a-tag>
              </div>
              <p v-else-if="modelsError[provider.id]" class="failed-inline">模型目录读取失败。</p>
            </section>
          </div>
        </transition>
      </article>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import {
  deleteProviderCredential,
  fetchProviderModels,
  fetchProviders,
  saveProviderCredential,
  testProviderCredential,
} from "@/apis/provider_api";
import { usePreferencesStore } from "@/stores/preferences";

const props = defineProps({
  open: { type: Boolean, default: false },
  userId: { type: String, default: null },
});

const preferences = usePreferencesStore();
const loading = ref(false);
const loadFailed = ref(false);
const providers = ref([]);
const capabilities = ref(null);
const expandedId = ref(null);

const modelsState = reactive({});
const modelsLoading = reactive({});
const modelsError = reactive({});

// Key 只存在这个组件实例的局部内存，不进入 Pinia、URL 或浏览器存储。
const draftKeys = reactive({});
const draftTouched = reactive({});

const saveLoading = reactive({});
const testLoading = reactive({});
const deleteLoading = reactive({});
const saveResult = reactive({});
const testResult = reactive({});
const deleteResult = reactive({});

const listSequence = ref(0);
const modelSequence = {};
const saveSequence = {};
const testSequence = {};
const deleteSequence = {};
const mutationSequence = {};
let lifecycleGeneration = 0;

const managementOnly = computed(
  () =>
    capabilities.value?.credentialManagementEnabled === true &&
    capabilities.value?.storedCredentialsEnabled === false,
);

function clearRecord(record) {
  for (const key of Object.keys(record)) delete record[key];
}

function clearDraft(providerId) {
  delete draftKeys[providerId];
  delete draftTouched[providerId];
}

function clearSensitiveDrafts() {
  clearRecord(draftKeys);
  clearRecord(draftTouched);
}

function clearOperationState() {
  for (const record of [saveLoading, testLoading, deleteLoading, saveResult, testResult, deleteResult]) {
    clearRecord(record);
  }
}

function nextSequence(record, providerId) {
  const next = (record[providerId] ?? 0) + 1;
  record[providerId] = next;
  return next;
}

function isCurrent(boundary, sequence, record, providerId) {
  return lifecycleGeneration === boundary && record[providerId] === sequence;
}

function invalidateTest(providerId) {
  nextSequence(testSequence, providerId);
  testLoading[providerId] = false;
  delete testResult[providerId];
}

function resetBoundary() {
  lifecycleGeneration += 1;
  listSequence.value += 1;
  loading.value = false;
  loadFailed.value = false;
  providers.value = [];
  capabilities.value = null;
  expandedId.value = null;
  clearRecord(modelsState);
  clearRecord(modelsLoading);
  clearRecord(modelsError);
  clearSensitiveDrafts();
  clearOperationState();
}

async function load({ background = false } = {}) {
  const boundary = lifecycleGeneration;
  const sequence = ++listSequence.value;
  if (!background) loading.value = true;
  loadFailed.value = false;
  try {
    const data = await fetchProviders();
    if (lifecycleGeneration !== boundary || listSequence.value !== sequence) return;
    capabilities.value = data.capabilities ?? null;
    providers.value = Array.isArray(data.providers) ? data.providers : [];
  } catch {
    if (lifecycleGeneration !== boundary || listSequence.value !== sequence) return;
    loadFailed.value = true;
  } finally {
    if (lifecycleGeneration === boundary && listSequence.value === sequence) loading.value = false;
  }
}

async function loadModels(providerId, { force = false } = {}) {
  if (modelsLoading[providerId] && !force) return;
  const boundary = lifecycleGeneration;
  const sequence = nextSequence(modelSequence, providerId);
  delete modelsError[providerId];
  if (force) delete modelsState[providerId];
  modelsLoading[providerId] = true;
  try {
    const data = await fetchProviderModels(providerId);
    if (!isCurrent(boundary, sequence, modelSequence, providerId)) return;
    modelsState[providerId] = { models: Array.isArray(data.models) ? data.models : [] };
  } catch {
    if (!isCurrent(boundary, sequence, modelSequence, providerId)) return;
    modelsError[providerId] = true;
  } finally {
    if (isCurrent(boundary, sequence, modelSequence, providerId)) {
      modelsLoading[providerId] = false;
    }
  }
}

async function refreshAfterMutation(providerId, boundary, mutation) {
  if (!isCurrent(boundary, mutation, mutationSequence, providerId)) return;
  await Promise.all([
    load({ background: true }),
    loadModels(providerId, { force: true }),
    preferences.reload(),
  ]);
}

async function toggle(providerId) {
  expandedId.value = expandedId.value === providerId ? null : providerId;
  if (expandedId.value === providerId && !modelsState[providerId] && !modelsError[providerId]) {
    await loadModels(providerId);
  }
}

function markDraft(providerId) {
  draftTouched[providerId] = true;
  delete saveResult[providerId];
  invalidateTest(providerId);
}

async function save(providerId) {
  const boundary = lifecycleGeneration;
  const sequence = nextSequence(saveSequence, providerId);
  const mutation = nextSequence(mutationSequence, providerId);
  const candidate = draftKeys[providerId] ?? "";
  saveLoading[providerId] = true;
  delete saveResult[providerId];
  delete deleteResult[providerId];
  invalidateTest(providerId);
  try {
    const result = await saveProviderCredential(providerId, candidate);
    if (!isCurrent(boundary, mutation, mutationSequence, providerId)) return;
    clearDraft(providerId);
    saveResult[providerId] = {
      kind: "success",
      message: `已加密保存（${result.credential.keyHint}）；下一轮对话会重新读取当前凭据。`,
    };
    await refreshAfterMutation(providerId, boundary, mutation);
  } catch (error) {
    if (!isCurrent(boundary, mutation, mutationSequence, providerId)) return;
    saveResult[providerId] = { kind: "error", message: error.message || "保存失败，请重试。" };
  } finally {
    if (isCurrent(boundary, sequence, saveSequence, providerId)) saveLoading[providerId] = false;
  }
}

async function testConnection(providerId) {
  const boundary = lifecycleGeneration;
  const sequence = nextSequence(testSequence, providerId);
  const input = draftTouched[providerId] ? { apiKey: draftKeys[providerId] ?? "" } : {};
  testLoading[providerId] = true;
  delete testResult[providerId];
  try {
    const result = await testProviderCredential(providerId, input);
    if (!isCurrent(boundary, sequence, testSequence, providerId)) return;
    const source = {
      candidate: "当前草稿",
      personal: "已保存的个人凭据",
      ambient: "系统环境凭据",
    }[result.source];
    testResult[providerId] = {
      kind: "success",
      message: `连接成功：${source ?? "当前凭据"} · ${result.modelId}`,
    };
  } catch (error) {
    if (!isCurrent(boundary, sequence, testSequence, providerId)) return;
    testResult[providerId] = { kind: "error", message: error.message || "连接测试失败。" };
  } finally {
    if (isCurrent(boundary, sequence, testSequence, providerId)) testLoading[providerId] = false;
  }
}

async function remove(providerId) {
  const boundary = lifecycleGeneration;
  const sequence = nextSequence(deleteSequence, providerId);
  const mutation = nextSequence(mutationSequence, providerId);
  deleteLoading[providerId] = true;
  delete deleteResult[providerId];
  delete saveResult[providerId];
  clearDraft(providerId);
  invalidateTest(providerId);
  try {
    const result = await deleteProviderCredential(providerId);
    if (!isCurrent(boundary, mutation, mutationSequence, providerId)) return;
    deleteResult[providerId] = {
      kind: "success",
      message: result.defaultModelReset
        ? "个人凭据已删除；不可用的默认模型已恢复为跟随系统默认。"
        : "个人凭据已删除；当前默认模型无需调整。",
    };
    await refreshAfterMutation(providerId, boundary, mutation);
  } catch (error) {
    if (!isCurrent(boundary, mutation, mutationSequence, providerId)) return;
    deleteResult[providerId] = { kind: "error", message: error.message || "删除失败，请重试。" };
  } finally {
    if (isCurrent(boundary, sequence, deleteSequence, providerId)) deleteLoading[providerId] = false;
  }
}

function configuredLabel(configured) {
  if (configured === true) return "运行时已配置";
  if (configured === false) return "运行时未配置";
  return "运行时状态未知";
}

function configuredClass(configured) {
  if (configured === true) return "ready";
  if (configured === false) return "missing";
  return "unknown";
}

function runtimeSourceLabel(source) {
  return {
    personal: "个人凭据",
    ambient: "系统凭据",
    none: "无运行时凭据",
    unknown: "来源未知",
  }[source];
}

function runtimeSourceDescription(source) {
  return {
    personal: "下一轮对话读取当前账号的个人凭据",
    ambient: "对话使用服务端环境凭据",
    none: "当前没有可用于对话的凭据",
    unknown: "凭据来源暂时无法确认",
  }[source];
}

function personalCredentialLabel(credential) {
  if (credential.status === "stored") return `已保存 ${credential.keyHint}`;
  if (credential.status === "not_stored") return "未保存";
  if (credential.status === "unknown") return "状态读取失败";
  return "个人凭据功能已关闭";
}

function modelTagColor(available) {
  if (available === true) return "blue";
  if (available === null) return "orange";
  return "default";
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false });
}

watch(
  () => [props.open, props.userId],
  ([open, userId]) => {
    resetBoundary();
    if (open && userId) void load();
  },
  { immediate: true, flush: "sync" },
);

onBeforeUnmount(resetBoundary);
</script>

<style lang="less" scoped>
.provider-panel {
  --provider-info-bg: #e6f4ff;
  --provider-info-border: #91caff;
  --provider-info-text: #0958d9;
  --provider-warn-bg: #fffbe6;
  --provider-warn-border: #ffe58f;
  --provider-warn-text: #7c5b00;
  --provider-success-bg: #f6ffed;
  --provider-success-border: #b7eb8f;
  --provider-success-text: #237804;
  --provider-personal-bg: #f0f5ff;
  --provider-personal-border: #adc6ff;
  --provider-personal-text: #1d39c4;
  --provider-error-text: #cf1322;
  color: var(--text-strong);
}

:global(.dark) .provider-panel {
  --provider-info-bg: #111d2c;
  --provider-info-border: #1554ad;
  --provider-info-text: #69b1ff;
  --provider-warn-bg: #2b2111;
  --provider-warn-border: #7c5b00;
  --provider-warn-text: #ffd666;
  --provider-success-bg: #162312;
  --provider-success-border: #3c8618;
  --provider-success-text: #95de64;
  --provider-personal-bg: #131629;
  --provider-personal-border: #3548a8;
  --provider-personal-text: #85a5ff;
  --provider-error-text: #ff7875;
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-subtle);

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  p {
    max-width: 520px;
    margin: 5px 0 0;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.55;
  }
}

.runtime-mode {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.mode-notice,
.probe-warning,
.degraded-note,
.management-disabled {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 12px;
  padding: 9px 11px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.55;
}

.mode-notice,
.management-disabled {
  border: 1px solid var(--provider-info-border);
  background: var(--provider-info-bg);
  color: var(--provider-info-text);
}

.notice-mark {
  display: inline-grid;
  width: 16px;
  height: 16px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
}

.loading,
.failed,
.empty {
  padding: 28px 0;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;

  p {
    margin: 0 0 10px;
  }
}

.providers {
  display: flex;
  flex-direction: column;
}

.provider-row {
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: 0;
  }
}

.row-header {
  display: grid;
  width: calc(100% + 16px);
  margin: 0 -8px;
  padding: 12px 8px;
  grid-template-columns: minmax(124px, 0.8fr) minmax(240px, 1.4fr) 16px;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }

  &:focus-visible {
    outline: 2px solid #1677ff;
    outline-offset: -2px;
  }
}

.provider-identity,
.status-cluster {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.provider-name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.default-pill,
.status-pill {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.5;
}

.default-pill {
  background: var(--provider-info-bg);
  color: var(--provider-info-text);
}

.status-pill {
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);

  &.ready {
    border-color: var(--provider-success-border);
    background: var(--provider-success-bg);
    color: var(--provider-success-text);
  }

  &.unknown {
    border-color: var(--provider-warn-border);
    background: var(--provider-warn-bg);
    color: var(--provider-warn-text);
  }

  &.personal {
    border-color: var(--provider-personal-border);
    background: var(--provider-personal-bg);
    color: var(--provider-personal-text);
  }
}

.source-label {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arrow {
  color: var(--text-muted);
  font-size: 12px;
  text-align: right;
}

.row-body {
  padding: 0 4px 18px;
  overflow: hidden;
}

.degraded-note {
  border: 1px solid var(--provider-warn-border);
  background: var(--provider-warn-bg);
  color: var(--provider-warn-text);
}

.credential-summary {
  display: grid;
  margin: 12px 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--surface-hover);

  div {
    min-width: 0;
    padding: 10px 12px;
    border-right: 1px solid var(--border-subtle);

    &:last-child {
      border-right: 0;
    }
  }

  dt {
    margin-bottom: 3px;
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  dd {
    margin: 0;
    color: var(--text-strong);
    font-size: 12px;
    line-height: 1.45;
  }
}

.credential-card {
  padding: 13px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-app);
}

.credential-card-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 11px;

  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  p {
    margin: 3px 0 0;
    color: var(--text-muted);
    font-size: 11px;
  }
}

.updated-at {
  align-self: flex-start;
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.key-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-strong);
  font-size: 11px;
}

.key-input {
  width: 100%;
}

.operation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.probe-warning {
  border: 1px solid var(--provider-warn-border);
  background: var(--provider-warn-bg);
  color: var(--provider-warn-text);
}

.operation-results {
  display: grid;
  gap: 5px;
  margin-top: 9px;
}

.operation-result {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;

  span {
    flex: 0 0 auto;
    font-weight: 600;
  }

  &.success {
    color: var(--provider-success-text);
  }

  &.error {
    color: var(--provider-error-text);
  }
}

.ambient-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 11px;
  color: var(--text-muted);
  font-size: 11px;

  code {
    padding: 2px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--surface-hover);
    color: var(--text-strong);
    font-size: 10px;
  }
}

.model-section {
  margin-top: 13px;
}

.model-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;

  h3 {
    margin: 0;
    color: var(--text-strong);
    font-size: 12px;
    font-weight: 600;
  }
}

.retry-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: #1677ff;
  font-size: 11px;
  cursor: pointer;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.failed-inline {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.expand-enter-active,
.expand-leave-active {
  max-height: 980px;
  transition: max-height 0.22s ease, opacity 0.18s ease;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}

@media (max-width: 680px) {
  .panel-heading {
    flex-direction: column;
  }

  .row-header {
    grid-template-columns: minmax(0, 1fr) 16px;
  }

  .status-cluster {
    grid-column: 1 / -1;
    grid-row: 2;
    flex-wrap: wrap;
  }

  .arrow {
    grid-column: 2;
    grid-row: 1;
  }

  .credential-summary {
    grid-template-columns: 1fr;

    div {
      border-right: 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: 0;
      }
    }
  }

  .credential-card-heading {
    flex-direction: column;
  }

  .updated-at {
    white-space: normal;
  }
}

@media (prefers-reduced-motion: reduce) {
  .expand-enter-active,
  .expand-leave-active,
  .row-header {
    transition: none;
  }
}
</style>

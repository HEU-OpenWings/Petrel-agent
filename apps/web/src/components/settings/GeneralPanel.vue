<template>
  <!--
    加载失败时显示错误态而不是空表单。空表单会让用户以为设置被清空了，
    点一次保存就真的把库里的值覆盖成 null——所以保存按钮也一起禁掉
  -->
  <div v-if="preferences.loadFailed" class="failed">
    <p>设置读取失败。</p>
    <a-button size="small" @click="retry">重试</a-button>
  </div>

  <a-spin v-else-if="!preferences.loaded" />

  <div v-else class="general">
    <div class="field">
      <label class="label" for="settings-default-model">默认对话模型</label>
      <a-select
        id="settings-default-model"
        v-model:value="draftModel"
        class="control"
        :disabled="saving"
        placeholder="跟随系统默认"
      >
        <a-select-option :value="null">跟随系统默认（{{ systemDefaultName }}）</a-select-option>
        <a-select-option v-for="model in preferences.models" :key="model.id" :value="model.id">
          {{ model.name }}
        </a-select-option>
      </a-select>
    </div>

    <div class="field">
      <label class="label" for="settings-system-prompt">默认 system prompt</label>
      <a-textarea
        id="settings-system-prompt"
        v-model:value="draftPrompt"
        class="control"
        :rows="6"
        :maxlength="SYSTEM_PROMPT_LIMIT"
        :disabled="saving"
        show-count
        placeholder="留空则使用系统默认提示词"
      />
    </div>

    <div class="field row">
      <label class="label" for="settings-dark">深色主题</label>
      <!--
        主题不落库也没有「保存」按钮：它压根不走后端，切换的那一刻就已经是最终状态。
        落库的两项才需要显式提交
      -->
      <a-switch id="settings-dark" :checked="theme.isDark" @change="theme.setTheme($event)" />
    </div>

    <div class="actions">
      <a-button type="primary" :loading="saving" :disabled="!dirty" @click="onSave">保存</a-button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useThemeStore } from '@/stores/theme'

/**
 * 与后端 apps/server/src/http/routes/account.ts 的 SYSTEM_PROMPT_LENGTH_LIMIT 对齐。
 * 改这个值时**那边也要改**——目前没有共享 contracts package（frontend-plan 里
 * 「后续 package 在对应业务首次落地时创建」），为一个常量建一个包不值得，
 * 所以用这条双向注释代替编译期约束
 */
const SYSTEM_PROMPT_LIMIT = 4000

const preferences = usePreferencesStore()
const theme = useThemeStore()

/**
 * 表单绑草稿副本而不是直接绑 store：直接绑的话，用户改了一半关掉弹窗，
 * store 里已经是脏值，ChatView 下一条消息就会用上一个从未保存的设置。
 */
const draftModel = ref(null)
const draftPrompt = ref('')
/**
 * saving 期间要禁用两个输入控件，不只是给按钮加 loading。
 *
 * 否则有个窄窗口：请求在飞时用户继续改草稿 → 请求返回后 applyPreferences 把 store
 * 写成「点击那一刻」的值 → watch 触发 syncDraft 把草稿覆盖回旧值，
 * 用户在这期间的输入被静默丢弃，且没有任何提示。
 */
const saving = ref(false)

const systemDefaultName = computed(
  () => preferences.models.find((model) => model.isDefault)?.name ?? '未知'
)

/** store 里空 prompt 是 null，表单里是 ''，比较前统一 */
const dirty = computed(
  () =>
    draftModel.value !== preferences.defaultModel ||
    draftPrompt.value.trim() !== (preferences.systemPrompt ?? '')
)

function syncDraft() {
  draftModel.value = preferences.defaultModel
  draftPrompt.value = preferences.systemPrompt ?? ''
}

// immediate：store 可能在本组件挂载之前就已经加载完（ChatView 先拉过），
// 那时不会再有变化事件，只靠 watch 会让表单一直是空的
watch(() => [preferences.loaded, preferences.defaultModel, preferences.systemPrompt], syncDraft, {
  immediate: true
})

function retry() {
  void preferences.ensureLoaded()
}

async function onSave() {
  saving.value = true
  try {
    // 空串归一成 null 交给后端也会做一次，这里做是为了让 dirty 的比较基准一致
    await preferences.save({
      defaultModel: draftModel.value,
      systemPrompt: draftPrompt.value.trim() || null
    })
    message.success('设置已保存')
  } catch (error) {
    // 必须出声：静默失败的话用户以为保存成功了，下次打开发现还是旧值
    message.error(error.message || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<style lang="less" scoped>
.failed {
  color: var(--text-muted);
  font-size: 14px;

  p {
    margin: 0 0 12px;
  }
}

.general {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;

  &.row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.label {
  color: var(--text-strong);
  font-size: 14px;
}

.control {
  width: 100%;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>

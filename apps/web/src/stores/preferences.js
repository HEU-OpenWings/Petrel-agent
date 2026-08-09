import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { fetchPreferences, savePreferences } from "@/apis/account_api";
import { useUserStore } from "@/stores/user";

/**
 * 用户偏好与可用模型清单。
 *
 * 偏好只在这里持有一份，ChatView 发消息时读它、设置面板改它。
 * 主题不在这个 store 里——它不落库，留在 stores/theme.js + localStorage，
 * 因为主题必须在首帧之前生效，等一个网络往返会先闪一下白底。
 */
export const usePreferencesStore = defineStore("preferences", () => {
  const userStore = useUserStore();
  /** null = 跟随系统默认（后端的 DEFAULT_MODEL_ID） */
  const defaultModel = ref(null);
  /** null = 跟随系统默认（后端的 DEFAULT_SYSTEM_PROMPT） */
  const systemPrompt = ref(null);
  const models = ref([]);
  const loaded = ref(false);
  /**
   * 加载失败必须与「偏好为空」区分开。混在一起的话设置面板会显示一张空表单，
   * 用户以为设置被清空了、点一次保存，就真的把库里的值覆盖成 null 了。
   */
  const loadFailed = ref(false);

  /** 在飞的加载 promise，让并发的 ensureLoaded() 只发一次请求 */
  let inflight = null;
  /** 账号变化时递增，让旧账号迟到的请求结果失效 */
  let generation = 0;

  function reset() {
    generation += 1;
    defaultModel.value = null;
    systemPrompt.value = null;
    models.value = [];
    loaded.value = false;
    loadFailed.value = false;
    inflight = null;
  }

  // Pinia store 跨路由常驻；账号切换时必须同步清空，不能把上一账号的 prompt 带给下一账号。
  watch(() => userStore.user?.id, reset, { flush: "sync" });

  /** 界面上显示的模型名。没选时取后端实际会用的那个，否则界面在说谎 */
  const modelName = computed(() => {
    const selected = models.value.find((model) => model.id === defaultModel.value);
    if (selected) return selected.name;
    return models.value.find((model) => model.isDefault)?.name ?? "";
  });

  function applyPreferences(preferences) {
    const saved = preferences?.defaultModel ?? null;
    // 存着的 id 已经不在清单里就当作「跟随系统默认」。留着它是个地雷：
    // 面板显示未选择，但每条消息都在传这个失效 id，而后端对未注册的 model
    // 返回 400——对话直接失败，且用户在设置里看不出原因
    defaultModel.value = models.value.some((model) => model.id === saved) ? saved : null;
    systemPrompt.value = preferences?.systemPrompt ?? null;
  }

  async function load(startGeneration) {
    try {
      const data = await fetchPreferences();
      if (generation !== startGeneration) return;
      models.value = data.models ?? [];
      applyPreferences(data.preferences);
      loaded.value = true;
      loadFailed.value = false;
    } catch {
      if (generation !== startGeneration) return;
      // 不往上抛：偏好拉不到不该阻断对话。ChatView 读到 null 就不传
      // model / systemPrompt，后端回落到系统默认值。
      // 只留下 loadFailed 让设置面板显示错误态
      loadFailed.value = true;
    }
  }

  /**
   * 幂等加载。ChatView 与 SettingsModal 各自挂载时都会调，同时开就会打两次请求，
   * 所以用 inflight 去重。加载失败后 loaded 仍是 false，下次调用会重试。
   */
  function ensureLoaded() {
    if (loaded.value) return Promise.resolve();
    if (!inflight) {
      const request = load(generation).finally(() => {
        if (inflight === request) inflight = null;
      });
      inflight = request;
    }
    return inflight;
  }

  /**
   * 令当前快照和所有更早的在飞响应失效，再从服务端强制读取。
   *
   * Provider 保存/删除后必须走这里：模型可用性与 defaultModel 可能同时改变，
   * 继续暴露旧值会让下一轮聊天在刷新窗口内仍发送已经不可用的模型。
   */
  function reload() {
    reset();
    return ensureLoaded();
  }

  /** 全量保存。失败原样抛给调用方——吞掉的话用户会以为保存成功了 */
  async function save({ defaultModel: model, systemPrompt: prompt }) {
    const startGeneration = generation;
    const data = await savePreferences({ defaultModel: model, systemPrompt: prompt });
    if (generation !== startGeneration) return;
    applyPreferences(data.preferences);
    loaded.value = true;
    loadFailed.value = false;
  }

  return {
    defaultModel,
    systemPrompt,
    models,
    loaded,
    loadFailed,
    modelName,
    ensureLoaded,
    reload,
    save,
  };
});

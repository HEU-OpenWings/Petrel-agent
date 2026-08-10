// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPreferences, savePreferences } from "@/apis/account_api";
import { usePreferencesStore } from "./preferences.js";
import { useUserStore } from "./user.js";

vi.mock("@/apis/account_api", () => ({
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

const FLASH = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  isDefault: true,
};
const V3 = {
  id: "deepseek-ai/DeepSeek-V3",
  name: "DeepSeek-V3 (SiliconFlow)",
  provider: "siliconflow",
  providerName: "SiliconFlow",
  isDefault: false,
};
const MODELS = [FLASH, V3];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("ensureLoaded", () => {
  it("把偏好与模型清单写进 store", async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: "你是助手" },
      models: MODELS,
    });
    const store = usePreferencesStore();

    await store.ensureLoaded();

    expect(store.defaultModel).toBe(V3.id);
    expect(store.systemPrompt).toBe("你是助手");
    expect(store.models).toEqual(MODELS);
    expect(store.loaded).toBe(true);
    expect(store.loadFailed).toBe(false);
  });

  // ChatView 与 SettingsModal 都会在挂载时调它，同时开就会打两次请求
  it("并发调用只发一次请求", async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS });
    const store = usePreferencesStore();

    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()]);

    expect(fetchPreferences).toHaveBeenCalledTimes(1);
  });

  it("已加载过就不再请求", async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    await store.ensureLoaded();

    expect(fetchPreferences).toHaveBeenCalledTimes(1);
  });

  it("账号切换后清空旧偏好并重新请求", async () => {
    fetchPreferences
      .mockResolvedValueOnce({
        preferences: { defaultModel: V3.id, systemPrompt: "账号 A 的 prompt" },
        models: MODELS,
      })
      .mockResolvedValueOnce({
        preferences: { defaultModel: null, systemPrompt: "账号 B 的 prompt" },
        models: MODELS,
      });
    const userStore = useUserStore();
    userStore.user = { id: "user-a", email: "a@x.io", role: "user" };
    const store = usePreferencesStore();
    await store.ensureLoaded();

    userStore.user = { id: "user-b", email: "b@x.io", role: "user" };

    expect(store.loaded).toBe(false);
    expect(store.defaultModel).toBe(null);
    expect(store.systemPrompt).toBe(null);
    await store.ensureLoaded();
    expect(fetchPreferences).toHaveBeenCalledTimes(2);
    expect(store.systemPrompt).toBe("账号 B 的 prompt");
  });

  it("账号切换前发出的请求迟到时不会覆盖新账号", async () => {
    let resolveOldRequest;
    fetchPreferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockResolvedValueOnce({
        preferences: { defaultModel: null, systemPrompt: "账号 B 的 prompt" },
        models: MODELS,
      });
    const userStore = useUserStore();
    userStore.user = { id: "user-a", email: "a@x.io", role: "user" };
    const store = usePreferencesStore();
    const oldRequest = store.ensureLoaded();

    userStore.user = { id: "user-b", email: "b@x.io", role: "user" };
    await store.ensureLoaded();
    resolveOldRequest({
      preferences: { defaultModel: V3.id, systemPrompt: "账号 A 的 prompt" },
      models: MODELS,
    });
    await oldRequest;

    expect(store.defaultModel).toBe(null);
    expect(store.systemPrompt).toBe("账号 B 的 prompt");
  });

  /**
   * 这条与下一条一起守住：加载失败必须与「偏好为空」区分开。
   * 混在一起的后果不是看着别扭——面板显示一张空表单，用户以为设置被清空了，
   * 点一次保存就真的把库里的值覆盖成 null。
   */
  it("加载失败时置 loadFailed 而不是 loaded，且不 reject", async () => {
    fetchPreferences.mockRejectedValue(new Error("网络错误"));
    const store = usePreferencesStore();

    await expect(store.ensureLoaded()).resolves.toBeUndefined();

    expect(store.loadFailed).toBe(true);
    expect(store.loaded).toBe(false);
  });

  it("加载失败后再调会重试", async () => {
    fetchPreferences
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValueOnce({ preferences: { defaultModel: V3.id }, models: MODELS });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    await store.ensureLoaded();

    expect(fetchPreferences).toHaveBeenCalledTimes(2);
    expect(store.loadFailed).toBe(false);
    expect(store.defaultModel).toBe(V3.id);
  });

  /**
   * 存着的 id 已经下架时不能原样留着。留着就是地雷——面板显示「跟随系统默认」，
   * 但每条消息都在传这个失效 id，而后端对未注册的 model 返回 400，
   * 对话直接失败且看不出原因。
   */
  it("存着的模型已不在清单里时当作跟随系统默认", async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: "retired-model", systemPrompt: null },
      models: MODELS,
    });
    const store = usePreferencesStore();

    await store.ensureLoaded();

    expect(store.defaultModel).toBe(null);
  });

  it("reload 强制重新读取模型与偏好，即使之前已经 loaded", async () => {
    fetchPreferences
      .mockResolvedValueOnce({
        preferences: { defaultModel: V3.id, systemPrompt: "旧 prompt" },
        models: MODELS,
      })
      .mockResolvedValueOnce({
        preferences: { defaultModel: null, systemPrompt: "新 prompt" },
        models: [FLASH],
      });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    await store.reload();

    expect(fetchPreferences).toHaveBeenCalledTimes(2);
    expect(store.models).toEqual([FLASH]);
    expect(store.defaultModel).toBe(null);
    expect(store.systemPrompt).toBe("新 prompt");
  });

  it("reload 令更早的 ensureLoaded 迟到响应失效", async () => {
    let resolveOldRequest;
    fetchPreferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockResolvedValueOnce({
        preferences: { defaultModel: null, systemPrompt: "刷新后的 prompt" },
        models: [FLASH],
      });
    const store = usePreferencesStore();
    const oldRequest = store.ensureLoaded();

    await store.reload();
    resolveOldRequest({
      preferences: { defaultModel: V3.id, systemPrompt: "迟到的旧 prompt" },
      models: MODELS,
    });
    await oldRequest;

    expect(store.models).toEqual([FLASH]);
    expect(store.defaultModel).toBe(null);
    expect(store.systemPrompt).toBe("刷新后的 prompt");
  });
});

describe("modelName", () => {
  it("选了模型就显示它的名字", async () => {
    fetchPreferences.mockResolvedValue({ preferences: { defaultModel: V3.id }, models: MODELS });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    expect(store.modelName).toBe(V3.name);
  });

  // 没选时显示的必须是后端实际会用的那个，否则界面在说谎
  it("没选模型时显示 isDefault 那一项的名字", async () => {
    fetchPreferences.mockResolvedValue({ preferences: { defaultModel: null }, models: MODELS });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    expect(store.modelName).toBe(FLASH.name);
  });

  it("清单还没拉到时是空字符串，不报错", () => {
    const store = usePreferencesStore();

    expect(store.modelName).toBe("");
  });
});

describe("save", () => {
  it("调接口并用响应里的值更新 store", async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS });
    savePreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: "新 prompt" },
    });
    const store = usePreferencesStore();
    await store.ensureLoaded();

    await store.save({ defaultModel: V3.id, systemPrompt: "新 prompt" });

    expect(savePreferences).toHaveBeenCalledWith({
      defaultModel: V3.id,
      systemPrompt: "新 prompt",
    });
    expect(store.defaultModel).toBe(V3.id);
    expect(store.systemPrompt).toBe("新 prompt");
  });

  // 失败要能抛到面板去显示，不能吞掉——吞掉的话用户以为保存成功了
  it("接口失败时抛出错误且不改动 store", async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: "旧 prompt" },
      models: MODELS,
    });
    savePreferences.mockRejectedValue(new Error("保存失败"));
    const store = usePreferencesStore();
    await store.ensureLoaded();

    await expect(store.save({ defaultModel: null, systemPrompt: null })).rejects.toThrow("保存失败");

    expect(store.defaultModel).toBe(V3.id);
    expect(store.systemPrompt).toBe("旧 prompt");
  });
});

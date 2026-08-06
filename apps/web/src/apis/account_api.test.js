// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserStore } from "@/stores/user";
import { changePassword, fetchPreferences, savePreferences } from "./account_api.js";
import { setUnauthorizedHandler } from "./http.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setUnauthorizedHandler(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPreferences", () => {
  it("GET /api/account/preferences", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ preferences: {}, models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPreferences();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/account/preferences");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });
});

describe("savePreferences", () => {
  it("PUT 全量两个字段，null 照原样发出去", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ preferences: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences({ defaultModel: null, systemPrompt: "你是助手" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/preferences");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ defaultModel: null, systemPrompt: "你是助手" });
  });
});

describe("changePassword", () => {
  it("POST /api/account/password", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await changePassword("old-password", "new-password");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
  });

  it("旧密码错误的 403 不会登出、不跳转、文案原样保留", async () => {
    const userStore = useUserStore();
    userStore.user = { id: "u-1", email: "a@x.io", role: "user" };
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "当前密码不正确" } }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(changePassword("wrong-password", "new-password")).rejects.toThrow("当前密码不正确");

    expect(userStore.isLoggedIn).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    // 只发了业务请求本身，没有顺带打一次 /api/auth/logout
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("登录失效的 401 会登出并通知全局处理器", async () => {
    const userStore = useUserStore();
    userStore.user = { id: "u-1", email: "a@x.io", role: "user" };
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "未登录或登录已失效" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(changePassword("old-password", "new-password")).rejects.toThrow("登录已失效，请重新登录");

    expect(userStore.isLoggedIn).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/logout");
  });
});

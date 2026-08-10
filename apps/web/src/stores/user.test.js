// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoginApi, mockRegisterApi, mockLogoutApi, mockMeApi } = vi.hoisted(() => ({
  mockLoginApi: vi.fn(),
  mockRegisterApi: vi.fn(),
  mockLogoutApi: vi.fn(),
  mockMeApi: vi.fn(),
}));

vi.mock("@/apis/auth_api", () => ({
  loginApi: mockLoginApi,
  registerApi: mockRegisterApi,
  logoutApi: mockLogoutApi,
  meApi: mockMeApi,
}));

import { useUserStore } from "@/stores/user";

describe("userStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // computed
  // ------------------------------------------------------------------
  describe("computed", () => {
    it("isLoggedIn is false when user is null", () => {
      const store = useUserStore();
      expect(store.isLoggedIn).toBe(false);
    });

    it("isLoggedIn is true when user is set", () => {
      const store = useUserStore();
      store.user = { id: 1, email: "a@b.com", role: "user" };
      expect(store.isLoggedIn).toBe(true);
    });

    it("isAdmin is false for regular user", () => {
      const store = useUserStore();
      store.user = { id: 1, email: "a@b.com", role: "user" };
      expect(store.isAdmin).toBe(false);
    });

    it("isAdmin is true for admin", () => {
      const store = useUserStore();
      store.user = { id: 1, email: "admin@b.com", role: "admin" };
      expect(store.isAdmin).toBe(true);
    });

    it("displayName extracts prefix before @", () => {
      const store = useUserStore();
      store.user = { id: 1, email: "john@example.com", role: "user" };
      expect(store.displayName).toBe("john");
    });

    it("displayName is empty string when user is null", () => {
      const store = useUserStore();
      expect(store.displayName).toBe("");
    });
  });

  // ------------------------------------------------------------------
  // login
  // ------------------------------------------------------------------
  describe("login", () => {
    it("calls loginApi and sets user on success", async () => {
      mockLoginApi.mockResolvedValue({
        user: { id: 1, email: "a@b.com", role: "user" },
      });
      const store = useUserStore();
      const result = await store.login("a@b.com", "pw");

      expect(mockLoginApi).toHaveBeenCalledWith("a@b.com", "pw");
      expect(store.user).toEqual({ id: 1, email: "a@b.com", role: "user" });
      expect(result).toEqual({ id: 1, email: "a@b.com", role: "user" });
    });

    it("throws when loginApi fails", async () => {
      mockLoginApi.mockRejectedValue(new Error("密码错误"));
      const store = useUserStore();
      await expect(store.login("a@b.com", "wrong")).rejects.toThrow("密码错误");
      expect(store.user).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // register
  // ------------------------------------------------------------------
  describe("register", () => {
    it("calls registerApi and returns data without setting user", async () => {
      mockRegisterApi.mockResolvedValue({ verificationSent: true });
      const store = useUserStore();
      const result = await store.register("new@b.com", "pw");

      expect(mockRegisterApi).toHaveBeenCalledWith("new@b.com", "pw");
      expect(store.user).toBeNull();
      expect(result).toEqual({ verificationSent: true });
    });
  });

  // ------------------------------------------------------------------
  // logout
  // ------------------------------------------------------------------
  describe("logout", () => {
    it("clears user synchronously then calls logoutApi", async () => {
      const store = useUserStore();
      store.user = { id: 1, email: "a@b.com", role: "user" };
      await store.logout();

      expect(store.user).toBeNull();
      expect(mockLogoutApi).toHaveBeenCalled();
    });

    it("clears user even when logoutApi fails", async () => {
      mockLogoutApi.mockRejectedValue(new Error("network error"));
      const store = useUserStore();
      store.user = { id: 1, email: "a@b.com", role: "user" };

      // should not throw
      await store.logout();

      expect(store.user).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // fetchMe
  // ------------------------------------------------------------------
  describe("fetchMe", () => {
    it("calls meApi and sets user on success", async () => {
      mockMeApi.mockResolvedValue({
        user: { id: 1, email: "a@b.com", role: "user" },
      });
      const store = useUserStore();
      const result = await store.fetchMe();

      expect(mockMeApi).toHaveBeenCalled();
      expect(store.user).toEqual({ id: 1, email: "a@b.com", role: "user" });
      expect(result).toEqual({ id: 1, email: "a@b.com", role: "user" });
    });

    it("throws when meApi fails", async () => {
      mockMeApi.mockRejectedValue(new Error("network error"));
      const store = useUserStore();
      await expect(store.fetchMe()).rejects.toThrow("network error");
    });
  });
});

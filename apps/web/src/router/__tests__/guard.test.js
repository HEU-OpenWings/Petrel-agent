// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserStore } from "@/stores/user";

// Stub heavy layout .vue files so the router module loads cleanly.
// AppShell / BlankLayout are imported synchronously by router/index.js;
// child views are lazy-loaded when routes are entered.
vi.mock("@/layouts/AppShell.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/layouts/BlankLayout.vue", () => ({
  default: { template: "<div />" },
}));
// Lazy-loaded views — needed because the router resolves matched routes
// and vitest would try to compile each .vue + its deep dependency tree.
vi.mock("@/views/LoginView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/views/HomeView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/views/ChatView.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/views/AdminView.vue", () => ({
  default: { template: "<div />" },
}));

// must be imported AFTER the mocks above
import router from "@/router";

function setUser(state) {
  const store = useUserStore();
  store.user = state.user ?? null;
}

describe("router beforeEach guard", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await router.replace("/").catch(() => {});
    vi.clearAllMocks();
  });

  // helper: push and wait for redirect(s) to settle
  async function navigate(path) {
    try {
      await router.push(path);
    } catch {
      // NavigationFailure if component fails to load – guard still runs
    }
  }

  // ----------------------------------------------------------------
  // requiresAuth routes
  // ----------------------------------------------------------------
  describe("protected routes (requiresAuth)", () => {
    it("redirects to /login?redirect=... when not logged in", async () => {
      setUser({ user: null });
      await navigate("/agent");
      expect(router.currentRoute.value.path).toBe("/login");
      expect(router.currentRoute.value.query.redirect).toBe("/agent");
    });

    it("allows navigation when logged in", async () => {
      setUser({ user: { id: 1, email: "u@e.com", role: "user" } });
      await navigate("/agent");
      expect(router.currentRoute.value.path).toBe("/agent");
    });
  });

  // ----------------------------------------------------------------
  // requiresAdmin routes
  // ----------------------------------------------------------------
  describe("admin routes (requiresAdmin)", () => {
    it("redirects to /login when not logged in", async () => {
      setUser({ user: null });
      await navigate("/admin");
      expect(router.currentRoute.value.path).toBe("/login");
      expect(router.currentRoute.value.query.redirect).toBe("/admin");
    });

    it("redirects to /agent when logged in but not admin", async () => {
      setUser({ user: { id: 1, email: "u@e.com", role: "user" } });
      await navigate("/admin");
      expect(router.currentRoute.value.path).toBe("/agent");
    });

    it("allows navigation when admin", async () => {
      setUser({
        user: { id: 1, email: "admin@e.com", role: "admin" },
        token: "t",
      });
      await navigate("/admin");
      expect(router.currentRoute.value.path).toBe("/admin");
    });
  });

  // ----------------------------------------------------------------
  // login page
  // ----------------------------------------------------------------
  describe("login page", () => {
    it("allows /login when not logged in", async () => {
      setUser({ user: null });
      await navigate("/login");
      expect(router.currentRoute.value.path).toBe("/login");
    });

    it("redirects away from /login when already logged in", async () => {
      setUser({ user: { id: 1, email: "u@e.com", role: "user" } });
      await navigate("/login");
      // safeRedirect("") defaults to /agent
      expect(router.currentRoute.value.path).toBe("/agent");
    });

    it("redirects to saved redirect target when logged in with redirect param", async () => {
      setUser({ user: { id: 1, email: "u@e.com", role: "user" } });
      await navigate("/login?redirect=/agent");
      expect(router.currentRoute.value.path).toBe("/agent");
    });
  });

  // ----------------------------------------------------------------
  // public pages
  // ----------------------------------------------------------------
  describe("public pages (requiresAuth: false)", () => {
    it("allows navigation when not logged in", async () => {
      setUser({ user: null });
      await navigate("/");
      expect(router.currentRoute.value.path).toBe("/");
    });

    it("allows navigation when logged in", async () => {
      setUser({ user: { id: 1, email: "u@e.com", role: "user" } });
      await navigate("/");
      expect(router.currentRoute.value.path).toBe("/");
    });
  });
});

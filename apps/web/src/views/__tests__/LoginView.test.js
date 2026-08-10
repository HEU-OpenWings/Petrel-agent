// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginView from "@/views/LoginView.vue";

// ---- mocks ----
const mockPush = vi.fn();
const mockRoute = { query: {} };
const { mockLogin, mockRegister, mockResendVerification } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockRegister: vi.fn(),
  mockResendVerification: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => mockRoute,
}));

vi.mock("@/stores/user", () => ({
  useUserStore: () => ({
    login: mockLogin,
    register: mockRegister,
  }),
}));

vi.mock("@/apis/auth_api", () => ({
  resendVerificationApi: mockResendVerification,
}));

function buildStubs() {
  return {
    "a-form": {
      template: `<form @submit.prevent="$emit('finish')"><slot /></form>`,
      props: ["layout", "model"],
    },
    "a-form-item": {
      template: `<div><slot /></div>`,
      props: ["label", "name", "rules"],
    },
    "a-input": {
      template: `<input :value="value" @input="$emit('update:value', $event.target.value)" :placeholder="placeholder" :type="type" />`,
      props: ["value", "placeholder", "type", "size", "autocomplete"],
    },
    "a-input-password": {
      template: `<input type="password" :value="value" @input="$emit('update:value', $event.target.value)" :placeholder="placeholder" />`,
      props: ["value", "placeholder", "size", "autocomplete"],
    },
    "a-button": {
      template: `<button :type="htmlType" :disabled="loading"><slot /></button>`,
      props: ["type", "htmlType", "size", "block", "loading"],
    },
    "a-alert": {
      template: `<div v-if="message" class="login-error">{{ message }}</div>`,
      props: ["message", "type", "showIcon"],
    },
  };
}

function mountLoginView() {
  return mount(LoginView, {
    global: { stubs: buildStubs() },
  });
}

// ---- helpers ----
async function submitForm(wrapper, email, password) {
  await wrapper.findAll("input")[0].setValue(email);
  await wrapper.findAll("input")[1].setValue(password);
  await wrapper.find("form").trigger("submit.prevent");
  await wrapper.vm.$nextTick();
}

async function toggleToRegister(wrapper) {
  await wrapper.find(".login-switch button").trigger("click");
  await wrapper.vm.$nextTick();
}

describe("LoginView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoute.query = {};
  });

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------
  describe("rendering", () => {
    it("shows login mode by default", () => {
      const wrapper = mountLoginView();
      expect(wrapper.text()).toContain("登录以继续");
      expect(wrapper.text()).toContain("还没有账号？");
      expect(wrapper.find("button[type='submit']").text()).toBe("登录");
    });

    it("has email and password fields", () => {
      const wrapper = mountLoginView();
      const inputs = wrapper.findAll("input");
      expect(inputs.length).toBe(2);
      expect(inputs[0].attributes("type")).toBe("email");
      expect(inputs[1].attributes("type")).toBe("password");
    });

    it("does not render error when errorMessage is empty", () => {
      const wrapper = mountLoginView();
      expect(wrapper.find(".login-error").exists()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // toggle mode
  // ------------------------------------------------------------------
  describe("toggle mode", () => {
    it("switches to register mode UI on toggle click", async () => {
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      expect(wrapper.text()).toContain("创建账号");
      expect(wrapper.text()).toContain("已经有账号了？");
      expect(wrapper.find("button[type='submit']").text()).toBe("注册");
    });

    it("switches back to login mode on second click", async () => {
      const wrapper = mountLoginView();
      const toggle = wrapper.find(".login-switch button");
      await toggle.trigger("click");
      await wrapper.vm.$nextTick();
      await toggle.trigger("click");
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toContain("登录以继续");
      expect(wrapper.find("button[type='submit']").text()).toBe("登录");
    });

    it("clears error when toggling mode", async () => {
      mockLogin.mockRejectedValueOnce(new Error("密码错误"));
      const wrapper = mountLoginView();
      await submitForm(wrapper, "u@e.com", "pw");
      expect(wrapper.find(".login-error").exists()).toBe(true);

      await wrapper.find(".login-switch button").trigger("click");
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".login-error").exists()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // submit
  // ------------------------------------------------------------------
  describe("submit", () => {
    it("calls userStore.login when form finishes in login mode", async () => {
      mockLogin.mockResolvedValue({});
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "password123");

      expect(mockLogin).toHaveBeenCalledTimes(1);
      expect(mockLogin).toHaveBeenCalledWith("a@b.com", "password123");
    });

    it("calls userStore.register when form finishes in register mode", async () => {
      mockRegister.mockResolvedValue({});
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      await submitForm(wrapper, "new@u.com", "password123");

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith("new@u.com", "password123");
    });

    it("redirects to saved path after successful login", async () => {
      mockLogin.mockResolvedValue({});
      mockRoute.query = { redirect: "/agent" };
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      expect(mockPush).toHaveBeenCalledWith("/agent");
    });

    it("defaults redirect to /agent when query.redirect is missing", async () => {
      mockLogin.mockResolvedValue({});
      mockRoute.query = {};
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      expect(mockPush).toHaveBeenCalledWith("/agent");
    });

    it("shows error alert on login failure", async () => {
      mockLogin.mockRejectedValue(new Error("密码错误"));
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "wrong");

      expect(wrapper.find(".login-error").exists()).toBe(true);
    });

    it("shows default error message when error has no message", async () => {
      mockLogin.mockRejectedValue({});
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      expect(wrapper.text()).toContain("操作失败，请重试");
    });
  });

  // ------------------------------------------------------------------
  // register success messages
  // ------------------------------------------------------------------
  describe("register success", () => {
    it("shows verification-sent message and switches back to login", async () => {
      mockRegister.mockResolvedValue({ verificationSent: true });
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      await submitForm(wrapper, "new@u.com", "password123");

      expect(wrapper.text()).toContain("验证邮件已发送");
      // switched back to login mode
      expect(wrapper.find("button[type='submit']").text()).toBe("登录");
    });

    it("shows email-verified registration success", async () => {
      mockRegister.mockResolvedValue({
        user: { emailVerifiedAt: "2024-01-01T00:00:00Z" },
      });
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      await submitForm(wrapper, "new@u.com", "password123");

      expect(wrapper.text()).toContain("注册成功，请登录");
    });

    it("shows email-send-failure message and makes resend visible", async () => {
      mockRegister.mockResolvedValue({});
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      await submitForm(wrapper, "new@u.com", "password123");

      expect(wrapper.text()).toContain("验证邮件发送失败");
      // resendVisible should be true: !isRegister (we're back in login)
      // && successMessage includes "验证邮件发送失败"
      expect(wrapper.text()).toContain("重新发送验证邮件");
    });
  });

  // ------------------------------------------------------------------
  // resend verification
  // ------------------------------------------------------------------
  describe("resend verification", () => {
    it("shows resend button when 403 error says email not verified", async () => {
      mockLogin.mockRejectedValueOnce(new Error("邮箱尚未验证，请查看邮件"));
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      expect(wrapper.text()).toContain("重新发送验证邮件");
    });

    it("shows resend button after registration mail-send failure", async () => {
      mockRegister.mockResolvedValue({});
      const wrapper = mountLoginView();
      await toggleToRegister(wrapper);
      await submitForm(wrapper, "new@u.com", "password123");

      expect(wrapper.text()).toContain("重新发送验证邮件");
    });

    it("calls resendVerificationApi and shows success on resend", async () => {
      mockResendVerification.mockResolvedValue({});
      mockLogin.mockRejectedValueOnce(new Error("邮箱尚未验证，请查看邮件"));
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      // click the resend button inside .login-forgot
      const resendBtn = wrapper.find(".login-forgot button");
      await resendBtn.trigger("click");
      await wrapper.vm.$nextTick();

      expect(mockResendVerification).toHaveBeenCalledWith("a@b.com");
      expect(wrapper.text()).toContain("验证邮件已重新发送");
    });

    it("shows error when resend fails", async () => {
      mockResendVerification.mockRejectedValue(new Error("SMTP down"));
      mockLogin.mockRejectedValueOnce(new Error("邮箱尚未验证，请查看邮件"));
      const wrapper = mountLoginView();
      await submitForm(wrapper, "a@b.com", "pw");

      const resendBtn = wrapper.find(".login-forgot button");
      await resendBtn.trigger("click");
      await wrapper.vm.$nextTick();

      expect(wrapper.find(".login-error").exists()).toBe(true);
    });
  });
});

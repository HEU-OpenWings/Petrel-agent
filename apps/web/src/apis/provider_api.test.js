import { beforeEach, describe, expect, it, vi } from "vitest";
import { del, get, post, put } from "@/apis/http";
import {
  deleteProviderCredential,
  fetchProviderModels,
  saveProviderCredential,
  testProviderCredential,
} from "./provider_api.js";

vi.mock("@/apis/http", () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider credential API", () => {
  it("所有 providerId 都经过 encodeURIComponent", async () => {
    get.mockResolvedValue({ models: [] });
    put.mockResolvedValue({});
    post.mockResolvedValue({});
    del.mockResolvedValue({});
    const providerId = "custom/provider id";
    const encoded = "custom%2Fprovider%20id";

    await fetchProviderModels(providerId);
    await saveProviderCredential(providerId, "candidate-value");
    await testProviderCredential(providerId, { apiKey: "candidate-value" });
    await deleteProviderCredential(providerId);

    expect(get).toHaveBeenCalledWith(`/api/providers/${encoded}/models`);
    expect(put).toHaveBeenCalledWith(`/api/providers/${encoded}/credential`, {
      apiKey: "candidate-value",
    });
    expect(post).toHaveBeenCalledWith(`/api/providers/${encoded}/test`, {
      apiKey: "candidate-value",
    });
    expect(del).toHaveBeenCalledWith(`/api/providers/${encoded}/credential`);
  });

  it("candidate 属性存在且为空时仍发送空字符串", async () => {
    post.mockResolvedValue({});

    await testProviderCredential("deepseek", { apiKey: "" });

    expect(post).toHaveBeenCalledWith("/api/providers/deepseek/test", { apiKey: "" });
  });

  it("candidate 缺省时发送空对象，让服务端选择 personal/ambient", async () => {
    post.mockResolvedValue({});

    await testProviderCredential("deepseek");

    expect(post).toHaveBeenCalledWith("/api/providers/deepseek/test", {});
  });
});

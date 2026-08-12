import { MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "../errors.ts";
import { embed, isEmbeddingConfigured } from "./client.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ apiKey: "test-key", timeoutMs: 10_000 }));

// vi.stubEnv 改不了已导入的 env，所以 mock @petrel/config，用 getter 动态读 state
vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        baseUrl: "https://embedding.test/v1",
        model: "BAAI/bge-m3",
        get apiKey() {
          return state.apiKey;
        },
        get timeoutMs() {
          return state.timeoutMs;
        },
      },
    },
  };
});

function vectorOf(value: number): number[] {
  return new Array<number>(MEMORY_EMBEDDING_DIM).fill(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  state.apiKey = "test-key";
  state.timeoutMs = 10_000;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embed", () => {
  it("未配置 API key 时抛错，且不发请求", async () => {
    state.apiKey = "";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(embed(["你好"])).rejects.toThrow(EmbeddingError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("空数组直接返回，不发请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * 乱序不会报错，只会让「记忆 A 的内容配上记忆 B 的向量」，
   * 表现是检索永远不准——所以必须钉住排序。
   */
  it("按 index 排回入参顺序", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: vectorOf(0.2) },
            { index: 0, embedding: vectorOf(0.1) },
          ],
        }),
      ),
    );

    const vectors = await embed(["第一条", "第二条"]);

    expect(vectors[0]?.[0]).toBe(0.1);
    expect(vectors[1]?.[0]).toBe(0.2);
  });

  it("维度不符时抛 EmbeddingError，且错误信息不含请求文本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] })),
    );

    await expect(embed(["用户的私密记忆"])).rejects.toThrow(/维度不符/);
    await expect(embed(["用户的私密记忆"])).rejects.not.toThrow(/私密/);
  });

  it("非 2xx 时抛错，且不透传响应体", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "your input was 用户的私密记忆" }, 500)),
    );

    await expect(embed(["用户的私密记忆"])).rejects.toThrow(/500/);
    await expect(embed(["用户的私密记忆"])).rejects.not.toThrow(/私密/);
  });

  /**
   * 条数对但 index 不是 0..n-1 时，光排序是排不出错的：
   * 第 2 条会拿到 index 2 的向量，不报错、只是检索不准。
   */
  it("index 不连续时抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 0, embedding: vectorOf(0.1) },
            { index: 2, embedding: vectorOf(0.2) },
          ],
        }),
      ),
    );

    await expect(embed(["一", "二"])).rejects.toThrow(/index/);
  });

  it("index 重复时抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 0, embedding: vectorOf(0.1) },
            { index: 0, embedding: vectorOf(0.2) },
          ],
        }),
      ),
    );

    await expect(embed(["一", "二"])).rejects.toThrow(/index/);
  });

  it("返回条数与入参不符时抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: vectorOf(0.1) }] })),
    );

    await expect(embed(["一", "二"])).rejects.toThrow(/条数不符/);
  });

  it("调用方的 signal 中止时抛错", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        controller.abort();
        init.signal?.throwIfAborted();
        return jsonResponse({ data: [] });
      }),
    );

    await expect(embed(["你好"], { signal: controller.signal })).rejects.toThrow(EmbeddingError);
  });
});

describe("isEmbeddingConfigured", () => {
  it("有 key 为 true，无 key 为 false", () => {
    expect(isEmbeddingConfigured()).toBe(true);
    state.apiKey = "";
    expect(isEmbeddingConfigured()).toBe(false);
  });
});

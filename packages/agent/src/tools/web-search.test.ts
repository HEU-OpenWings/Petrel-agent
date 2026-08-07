import { type AgentHarnessEvent, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";
import { createWebSearchTool } from "./web-search.ts";

const FAKE_KEY = "tvly-fake-key";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** createWebSearchTool 在 key 非空时一定返回工具对象，帮测试省掉判空 */
function mustCreate(apiKey: string = FAKE_KEY) {
  const tool = createWebSearchTool(apiKey);
  if (!tool) throw new Error("createWebSearchTool 理应返回工具对象");
  return tool;
}

/** 从 pi AgentToolResult 的 content 中提取第一个 text 块并 JSON.parse */
function parseTextContent(result: { content: readonly { type: string; text?: string }[] }) {
  const block = result.content.find((b) => b.type === "text" && typeof b.text === "string");
  if (!block?.text) throw new Error("content 中没有 text 块");
  return JSON.parse(block.text) as Record<string, unknown>;
}

/** 用 fauxProvider + 内存 session + web_search 工具装配 harness */
async function fauxHarnessWithWebSearch() {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({
    session,
    models,
    model: faux.getModel(),
    tools: [mustCreate()],
    toolContext: () => ({ userId: "test-user", sessionId: SESSION_ID }),
  });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, session, events };
}

describe("createWebSearchTool", () => {
  it("未配置 API key 时返回 undefined", () => {
    expect(createWebSearchTool("")).toBeUndefined();
  });

  it("配置了 key 时返回工具对象", () => {
    expect(mustCreate().name).toBe("web_search");
  });
});

describe("web_search 工具执行", () => {
  it("成功搜索返回匹配前端卡片的数据形状", async () => {
    const tool = mustCreate();
    const fakeResponse = {
      query: "TypeScript",
      response_time: 0.35,
      results: [
        {
          title: "TypeScript 官网",
          url: "https://www.typescriptlang.org",
          content: "TypeScript is JavaScript with syntax for types.",
          score: 0.98,
          published_date: "2024-01-15",
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => fakeResponse,
      } as Response;
    }) as typeof fetch;

    try {
      const result = await tool.execute("tc-1", { query: "TypeScript" }, undefined, undefined, {
        userId: "u1",
        sessionId: "s1",
      });

      const parsed = parseTextContent(result);
      expect(parsed.query).toBe("TypeScript");
      expect(parsed.response_time).toBe(0.35);
      expect(Array.isArray(parsed.results)).toBe(true);
      const results = parsed.results as Record<string, unknown>[];
      expect(results).toHaveLength(1);
      const first = results[0];
      if (!first) throw new Error("results[0] 不应为空");
      expect(first.url).toBe("https://www.typescriptlang.org");
      expect(first.title).toBe("TypeScript 官网");
      expect(first.score).toBe(0.98);
      expect(first.content).toBeDefined();

      expect((result.details as { resultCount: number }).resultCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("API 返回非 200 时不抛异常，返回 isError 形状", async () => {
    const tool = mustCreate();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await tool.execute("tc-2", { query: "test" }, undefined, undefined, {
        userId: "u1",
        sessionId: "s1",
      });

      const parsed = parseTextContent(result);
      expect(parsed.error).toContain("429");
      expect(parsed.results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("网络异常时不抛异常，返回错误信息", async () => {
    const tool = mustCreate();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as typeof fetch;

    try {
      const result = await tool.execute("tc-3", { query: "test" }, undefined, undefined, {
        userId: "u1",
        sessionId: "s1",
      });

      const parsed = parseTextContent(result);
      expect(parsed.error).toContain("Network error");
      expect(parsed.results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("web_search harness 集成（fauxProvider 真实 agent loop）", () => {
  it("模型自主调用 web_search → 收到结果 → 基于结果作答", async () => {
    const { faux, harness, session, events } = await fauxHarnessWithWebSearch();

    // mock Tavily 返回
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          query: "今天天气",
          response_time: 0.3,
          results: [
            {
              title: "天气预报",
              url: "https://weather.example.com",
              content: "今天晴，最高温 25°C。",
              score: 0.95,
              published_date: "2026-08-07",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      // 第一轮：模型决定调 web_search
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("web_search", { query: "今天天气" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("根据搜索结果，今天天气晴朗，最高气温 25°C。")]),
      ]);

      await harness.prompt("今天天气怎么样");

      // toolResult 条目也落进 session
      const entries = await session.getEntries();
      const roles = entries
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: { role: string } }).message.role);
      expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);

      // 工具调用完成且 isError 为 false
      const toolEnd = events.filter((e) => e.type === "tool_execution_end");
      expect(toolEnd.length).toBeGreaterThanOrEqual(1);
      for (const e of toolEnd) {
        if (e.type === "tool_execution_end") {
          expect(e.isError).toBe(false);
        }
      }

      // 模型基于搜索结果作答
      const text = JSON.stringify(entries);
      expect(text).toContain("根据搜索结果");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("web_search 返回错误时对话不中断，模型继续作答", async () => {
    const { faux, harness, session } = await fauxHarnessWithWebSearch();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response;
    }) as typeof fetch;

    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("web_search", { query: "测试" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("搜索暂时不可用，我根据已有知识回答……")]),
      ]);

      await harness.prompt("搜索测试");

      const entries = await session.getEntries();
      const roles = entries
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: { role: string } }).message.role);
      // 仍旧有完整的四段：user → assistant(toolUse) → toolResult → assistant
      expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);

      // 模型没有因为工具失败而中断，仍然给出了回答
      const text = JSON.stringify(entries);
      expect(text).toContain("搜索暂时不可用");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("web_search signal 取消", () => {
  it("signal 触发后 fetch 被取消，不留悬挂请求", async () => {
    const tool = mustCreate();

    const controller = new AbortController();
    const signal = controller.signal;

    // mock fetch：查 signal 状态，被 abort 后抛 AbortError
    const originalFetch = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = (async (_url, init) => {
      fetchWasCalled = true;
      const fetchSignal = (init as { signal?: AbortSignal })?.signal;
      // 等 signal 被触发
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort);
        if (fetchSignal?.aborted) {
          signal.removeEventListener("abort", onAbort);
          reject(new DOMException("Aborted", "AbortError"));
        }
      });
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;

    try {
      const resultPromise = tool.execute("tc-abort", { query: "test" }, signal, undefined, {
        userId: "u1",
        sessionId: "s1",
      });

      // 稍等一下让 fetch 开始
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchWasCalled).toBe(true);

      // 触发取消
      controller.abort();

      const result = await resultPromise;
      // 不应该抛异常，而是返回 isError 的结果
      const parsed = parseTextContent(result);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

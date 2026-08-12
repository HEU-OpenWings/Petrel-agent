import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../harness.ts";
import { currentTime } from "./current-time.ts";
import { listToolNames, registerTool, resetRegistry, selectTools } from "./registry.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ apiKey: "test-key" }));

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        ...actual.env.embedding,
        get apiKey() {
          return state.apiKey;
        },
      },
    },
  };
});

/** 极简测试工具，仅用来测注册表行为 */
function makeDummyTool(name: string): AgentHarnessTool<ToolContext> {
  return {
    name,
    label: `Dummy ${name}`,
    description: "测试用工具",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: name }],
      details: { name },
    }),
  };
}

// 每个用例前后清掉注册表再恢复内置工具，避免跨用例污染
beforeEach(() => {
  resetRegistry();
});

afterEach(() => {
  resetRegistry();
  registerTool("get_current_time", currentTime);
});

describe("registerTool", () => {
  it("注册后出现在 selectTools 的默认列表里", () => {
    registerTool("a", makeDummyTool("a"));
    expect(selectTools().map((t) => t.name)).toContain("a");
  });

  it("同名工具重复注册抛错", () => {
    registerTool("dup", makeDummyTool("dup"));
    expect(() => registerTool("dup", makeDummyTool("dup"))).toThrow("工具名重复");
  });

  it("disabled 工具不出现在列表里", () => {
    registerTool("hidden", makeDummyTool("hidden"), false);
    expect(selectTools().map((t) => t.name)).not.toContain("hidden");
    expect(listToolNames()).not.toContain("hidden");
  });
});

describe("selectTools", () => {
  it("undefined 时返回全部 enabled 工具", () => {
    registerTool("a", makeDummyTool("a"));
    registerTool("b", makeDummyTool("b"));
    expect(selectTools(undefined).map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("传了名字列表只返回匹配的", () => {
    registerTool("a", makeDummyTool("a"));
    registerTool("b", makeDummyTool("b"));
    registerTool("c", makeDummyTool("c"));
    expect(selectTools(["a", "c"]).map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("未注册的名字静默跳过", () => {
    registerTool("a", makeDummyTool("a"));
    expect(selectTools(["a", "nonexistent"]).map((t) => t.name)).toEqual(["a"]);
  });

  it("disabled 工具即使传了名字也不返回", () => {
    registerTool("a", makeDummyTool("a"), false);
    expect(selectTools(["a"])).toEqual([]);
  });
});

describe("listToolNames", () => {
  it("只列出 enabled 的工具", () => {
    registerTool("enabled", makeDummyTool("enabled"), true);
    registerTool("disabled", makeDummyTool("disabled"), false);
    expect(listToolNames()).toEqual(["enabled"]);
  });
});

/**
 * 记忆工具在模块加载期就按 env 决定进不进注册表，所以两条都要重新加载模块来验证：
 * 静态 import 的那份注册表已经被 beforeEach 清空了，改 state.apiKey 也已经晚了。
 */
describe("记忆工具的条件注册", () => {
  afterEach(() => {
    state.apiKey = "test-key";
    vi.resetModules();
  });

  it("配置了 embedding 时两个记忆工具都在", async () => {
    vi.resetModules();
    const fresh = await import("./registry.ts");

    expect(fresh.listToolNames()).toEqual(expect.arrayContaining(["memory_search", "memory_write"]));
  });

  // 模型看到一个必然失败的工具会反复重试，每次重试都是一次真实的模型调用
  it("未配置 embedding 时记忆工具不进注册表", async () => {
    state.apiKey = "";
    vi.resetModules();
    const fresh = await import("./registry.ts");

    expect(fresh.listToolNames()).not.toContain("memory_search");
    expect(fresh.listToolNames()).not.toContain("memory_write");
  });
});

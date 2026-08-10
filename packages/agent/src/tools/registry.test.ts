import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../harness.ts";
import { currentTime } from "./current-time.ts";
import { listToolNames, registerTool, resetRegistry, selectTools } from "./registry.ts";

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

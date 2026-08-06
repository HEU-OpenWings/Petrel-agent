import { describe, expect, it } from "vitest";
import { extractToolResultText, formatToolArgs, TOOL_STATE_TEXT } from "./toolCall.js";

describe("TOOL_STATE_TEXT", () => {
  it("覆盖四种执行状态", () => {
    expect(TOOL_STATE_TEXT).toEqual({
      running: "执行中",
      done: "完成",
      error: "失败",
      pending: "待执行",
    });
  });
});

describe("formatToolArgs", () => {
  it("空参数显示占位文案", () => {
    expect(formatToolArgs(null)).toBe("(无)");
    expect(formatToolArgs(undefined)).toBe("(无)");
  });

  it("字符串参数原样返回", () => {
    expect(formatToolArgs("raw")).toBe("raw");
  });

  it("对象参数格式化为缩进 JSON", () => {
    expect(formatToolArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("extractToolResultText", () => {
  it("没有结果时返回空串", () => {
    expect(extractToolResultText(null)).toBe("");
  });

  it("从 pi 的 content block 数组里取文本并按行拼接", () => {
    const result = {
      content: [
        { type: "text", text: "第一行" },
        { type: "image", data: "ignored" },
        { type: "text", text: "第二行" },
      ],
    };
    expect(extractToolResultText(result)).toBe("第一行\n第二行");
  });

  it("没有文本块时回退到原始 JSON", () => {
    const result = { content: [{ type: "image", data: "x" }] };
    expect(extractToolResultText(result)).toContain('"type": "image"');
  });
});

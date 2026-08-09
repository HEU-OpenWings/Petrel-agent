import { describe, expect, it, vi } from "vitest";
import { filterCommands, useCommandPalette } from "./useCommandPalette.js";

const COMMANDS = [
  { name: "new", description: "新对话", run: () => {} },
  { name: "workspace", description: "开合右栏", keywords: ["引用"], run: () => {} },
  { name: "sidebar", description: "开合左栏", run: () => {} },
];

describe("filterCommands", () => {
  it("空查询返回全部命令", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(3);
  });

  it("按命令名匹配且大小写不敏感", () => {
    expect(filterCommands(COMMANDS, "WOR").map((c) => c.name)).toEqual(["workspace"]);
  });

  it("也匹配描述和补充关键词，供 Ctrl+K 用自然语言搜索", () => {
    expect(filterCommands(COMMANDS, "右栏").map((c) => c.name)).toEqual(["workspace"]);
    expect(filterCommands(COMMANDS, "引用").map((c) => c.name)).toEqual(["workspace"]);
  });

  it("无匹配时返回空数组", () => {
    expect(filterCommands(COMMANDS, "zzz")).toEqual([]);
  });
});

describe("useCommandPalette", () => {
  it("openWith 打开面板并重置选中项", () => {
    const palette = useCommandPalette(COMMANDS);
    palette.openWith("");
    expect(palette.open.value).toBe(true);
    expect(palette.activeIndex.value).toBe(0);
  });

  it("没有匹配项时自动关闭，避免拦截正常输入", () => {
    const palette = useCommandPalette(COMMANDS);
    palette.openWith("zzz");
    expect(palette.open.value).toBe(false);
  });

  it("全局面板可以保留空结果态", () => {
    const palette = useCommandPalette(COMMANDS);
    palette.openWith("zzz", { keepOpen: true });
    expect(palette.open.value).toBe(true);
    expect(palette.filtered.value).toEqual([]);
  });

  it("moveDown 到底部后回到第一项", () => {
    const palette = useCommandPalette(COMMANDS);
    palette.openWith("");
    palette.moveDown();
    palette.moveDown();
    palette.moveDown();
    expect(palette.activeIndex.value).toBe(0);
  });

  it("moveUp 从第一项跳到最后一项", () => {
    const palette = useCommandPalette(COMMANDS);
    palette.openWith("");
    palette.moveUp();
    expect(palette.activeIndex.value).toBe(2);
  });

  it("pick 执行当前选中命令并关闭面板", () => {
    const run = vi.fn();
    const palette = useCommandPalette([{ name: "new", description: "新对话", run }]);
    palette.openWith("");
    palette.pick();
    expect(run).toHaveBeenCalledOnce();
    expect(palette.open.value).toBe(false);
  });

  it("面板关闭时 pick 不执行任何命令", () => {
    const run = vi.fn();
    const palette = useCommandPalette([{ name: "new", description: "新对话", run }]);
    palette.pick();
    expect(run).not.toHaveBeenCalled();
  });
});

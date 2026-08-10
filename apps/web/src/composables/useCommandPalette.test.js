import { describe, expect, it, vi } from "vitest";
import { filterCommands, isCommandPaletteShortcut, useCommandPalette } from "./useCommandPalette.js";

const COMMANDS = [
  { name: "new", description: "新对话", run: () => {} },
  { name: "workspace", description: "开合右栏", keywords: ["引用"], run: () => {} },
  { name: "sidebar", description: "开合左栏", run: () => {} },
];

describe("filterCommands", () => {
  it("空查询返回全部命令", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(3);
  });

  it("斜杠命令按名称前缀匹配且大小写不敏感", () => {
    expect(filterCommands(COMMANDS, "WOR").map((c) => c.name)).toEqual(["workspace"]);
  });

  it("斜杠命令不做子串或自然语言匹配，避免劫持普通输入", () => {
    expect(filterCommands(COMMANDS, "e")).toEqual([]);
    expect(filterCommands(COMMANDS, "右栏")).toEqual([]);
    expect(filterCommands(COMMANDS, "引用")).toEqual([]);
  });

  it("/c 保留 compact 为首选，clear 只有输入 /cl 才会成为唯一匹配", () => {
    const commands = [
      { name: "compact", description: "压缩上下文", run: () => {} },
      { name: "context", description: "查看上下文", run: () => {} },
      { name: "clear", description: "清空上下文", run: () => {} },
    ];
    expect(filterCommands(commands, "c").map((command) => command.name)).toEqual([
      "compact",
      "context",
      "clear",
    ]);
    expect(filterCommands(commands, "cl").map((command) => command.name)).toEqual(["clear"]);
  });

  it("Ctrl+K 面板显式启用全字段搜索", () => {
    const options = { searchAll: true };
    expect(filterCommands(COMMANDS, "右栏", options).map((c) => c.name)).toEqual(["workspace"]);
    expect(filterCommands(COMMANDS, "引用", options).map((c) => c.name)).toEqual(["workspace"]);
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
    const palette = useCommandPalette(COMMANDS, { searchAll: true });
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

describe("isCommandPaletteShortcut", () => {
  const keyEvent = (overrides = {}) => ({
    key: "k",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("接受 Ctrl+K 与 Cmd+K", () => {
    expect(isCommandPaletteShortcut(keyEvent())).toBe(true);
    expect(isCommandPaletteShortcut(keyEvent({ ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it("不吞掉带 Shift / Alt 的浏览器快捷键", () => {
    expect(isCommandPaletteShortcut(keyEvent({ shiftKey: true }))).toBe(false);
    expect(isCommandPaletteShortcut(keyEvent({ altKey: true }))).toBe(false);
  });
});

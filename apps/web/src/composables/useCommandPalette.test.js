import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import {
  filterCommands,
  isCommandPaletteShortcut,
  parseSkillCommand,
  useCommandPalette,
} from "./useCommandPalette.js";

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

  // skill 补全项是异步拉来的，命令来源必须能是响应式的 ref/getter
  it("命令来源是 ref 时随其变化过滤（供 skill 补全动态注入）", () => {
    const commands = ref([{ name: "new", description: "新对话", run: () => {} }]);
    const palette = useCommandPalette(commands);
    palette.openWith("skill:");
    expect(palette.filtered.value).toEqual([]);

    commands.value = [
      ...commands.value,
      { name: "skill:root-cause-analysis", description: "根因分析", run: () => {} },
    ];
    palette.openWith("skill:");
    expect(palette.filtered.value.map((command) => command.name)).toEqual(["skill:root-cause-analysis"]);
  });
});

describe("parseSkillCommand", () => {
  it("解析 /skill:name args", () => {
    expect(parseSkillCommand("/skill:root-cause-analysis 看这个 bug")).toEqual({
      name: "root-cause-analysis",
      args: "看这个 bug",
    });
  });

  it("只有 name 时 args 为 undefined", () => {
    expect(parseSkillCommand("/skill:root-cause-analysis")).toEqual({
      name: "root-cause-analysis",
      args: undefined,
    });
  });

  it("name 后只有空白时 args 为 undefined", () => {
    expect(parseSkillCommand("/skill:root-cause-analysis   ")).toEqual({
      name: "root-cause-analysis",
      args: undefined,
    });
  });

  it("不是 /skill: 开头返回 null（按普通消息处理）", () => {
    expect(parseSkillCommand("你好")).toBeNull();
    expect(parseSkillCommand("/compact")).toBeNull();
    expect(parseSkillCommand("/skill")).toBeNull();
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

// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampWidth,
  DEFAULT_RIGHT_WIDTH,
  MAX_RIGHT_WIDTH,
  MIN_RIGHT_WIDTH,
  STORAGE_KEY,
  useLayoutStore,
} from "./layout.js";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe("clampWidth", () => {
  it("把超出范围的宽度钳制到边界", () => {
    expect(clampWidth(9999)).toBe(MAX_RIGHT_WIDTH);
    expect(clampWidth(10)).toBe(MIN_RIGHT_WIDTH);
    expect(clampWidth(400)).toBe(400);
  });

  it("非有限数回落到默认宽度", () => {
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_RIGHT_WIDTH);
    expect(clampWidth(undefined)).toBe(DEFAULT_RIGHT_WIDTH);
  });
});

describe("useLayoutStore", () => {
  it("没有持久化数据时用默认值", () => {
    const layout = useLayoutStore();
    expect(layout.leftCollapsed).toBe(false);
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
  });

  it("首次加载时视口窄于 1024 则默认折叠右栏", () => {
    vi.stubGlobal("innerWidth", 800);
    const layout = useLayoutStore();
    expect(layout.rightCollapsed).toBe(true);
    vi.unstubAllGlobals();
  });

  it("持久化数据损坏时静默回落默认值", () => {
    localStorage.setItem(STORAGE_KEY, "{ 这不是 JSON");
    const layout = useLayoutStore();
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
  });

  it("schema 版本不符时丢弃旧数据", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 99, rightWidth: 500 }));
    const layout = useLayoutStore();
    expect(layout.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
  });

  it("读回上次持久化的状态", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, leftCollapsed: true, rightCollapsed: false, rightWidth: 420 }),
    );
    const layout = useLayoutStore();
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.rightWidth).toBe(420);
  });

  it("toggleLeft 立刻写入 localStorage", () => {
    const layout = useLayoutStore();
    layout.toggleLeft();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).leftCollapsed).toBe(true);
  });

  it("setRightWidth 写入前先钳制", () => {
    const layout = useLayoutStore();
    layout.setRightWidth(9999);
    expect(layout.rightWidth).toBe(MAX_RIGHT_WIDTH);
  });

  it("localStorage 不可写时不抛异常", () => {
    const layout = useLayoutStore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => layout.toggleRight()).not.toThrow();
    vi.restoreAllMocks();
  });
});

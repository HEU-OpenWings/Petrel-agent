import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect.js";

describe("safeRedirect", () => {
  // 不用 '/agent' 断言：它恰好等于默认 fallback，那样写单看是恒真的
  it("放行站内路径", () => {
    expect(safeRedirect("/knowledge")).toBe("/knowledge");
    expect(safeRedirect("/")).toBe("/");
  });

  it("拦截 /login 自身，避免守卫来回重定向打转", () => {
    expect(safeRedirect("/login")).toBe("/agent");
    expect(safeRedirect("/login?x=1")).toBe("/agent");
    expect(safeRedirect("/login#a")).toBe("/agent");
    // 只比 path 段，/loginxxx 是正常路径
    expect(safeRedirect("/loginxxx")).toBe("/loginxxx");
  });

  it("保留 query 与 hash（守卫存进去的是 fullPath）", () => {
    expect(safeRedirect("/knowledge?tab=1#x")).toBe("/knowledge?tab=1#x");
  });

  it("拦截协议相对 URL", () => {
    expect(safeRedirect("//evil.com")).toBe("/agent");
  });

  it("拦截反斜杠变体的协议相对 URL", () => {
    expect(safeRedirect("/\\evil.com")).toBe("/agent");
  });

  it("拦截绝对 URL", () => {
    expect(safeRedirect("https://evil.com")).toBe("/agent");
    expect(safeRedirect("http://evil.com")).toBe("/agent");
  });

  it("拦截不以 / 开头的相对路径", () => {
    expect(safeRedirect("agent")).toBe("/agent");
  });

  it("空值回落", () => {
    expect(safeRedirect(undefined)).toBe("/agent");
    expect(safeRedirect("")).toBe("/agent");
  });

  it("拦截控制字符（浏览器会静默剥离 TAB/LF/CR，剥完就成了 //evil.com）", () => {
    expect(safeRedirect("/\t//evil.com")).toBe("/agent");
    expect(safeRedirect("/\n//evil.com")).toBe("/agent");
    expect(safeRedirect("/\r//evil.com")).toBe("/agent");
    expect(safeRedirect("/\0//evil.com")).toBe("/agent");
  });

  // fallback 用 '/x' 而不是默认值：默认值恰好等于 '/agent'，
  // 用默认值断言的话删掉 typeof 判断也不会红
  it("数组回落（URL 里重复同名参数时 vue-router 给的形态）", () => {
    expect(safeRedirect(["/a"], "/x")).toBe("/x");
    expect(safeRedirect(["/agent", "https://evil.com"], "/x")).toBe("/x");
    expect(safeRedirect([], "/x")).toBe("/x");
  });

  it("自定义 fallback 生效", () => {
    expect(safeRedirect("https://evil.com", "/")).toBe("/");
    expect(safeRedirect(null, "/login")).toBe("/login");
  });
});

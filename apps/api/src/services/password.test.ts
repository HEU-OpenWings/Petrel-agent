import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("hashPassword", () => {
  it("同一个密码两次哈希结果不同（salt 随机）", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
  });

  it("输出是 scrypt$salt$hash 三段", async () => {
    const hash = await hashPassword("hunter2hunter2");
    const parts = hash.split("$");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
  });
});

describe("verifyPassword", () => {
  it("正确密码通过", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("错误密码不通过", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password here", hash)).resolves.toBe(false);
  });

  // 默认用户与将来任何「不可登录」的账号都存这个值，必须安全地返回 false 而不是抛错
  it.each([
    { name: "占位哈希", stored: "!" },
    { name: "空字符串", stored: "" },
    { name: "段数不对", stored: "scrypt$onlytwo" },
    { name: "算法前缀不对", stored: "bcrypt$c2FsdA==$aGFzaA==" },
    { name: "salt 不是合法 base64 长度", stored: "scrypt$$aGFzaA==" },
  ])("$name 返回 false 而不抛错", async ({ stored }) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });
});

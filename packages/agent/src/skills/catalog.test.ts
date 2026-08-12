import type { Skill } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { findSkill, getSkills, initSkills, setSkillsForTest } from "./catalog.ts";
import { skillsSystemPromptBlock } from "./system-prompt.ts";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "demo",
    description: "示例 skill",
    content: "正文",
    filePath: "/skills/demo/SKILL.md",
    disableModelInvocation: false,
    ...overrides,
  };
}

// initSkills 会覆盖进程级目录，用例之间彼此不该串
afterEach(() => setSkillsForTest([]));

describe("initSkills 加载捆绑 skill", () => {
  it("能读到内置的 root-cause-analysis，且无告警", async () => {
    const { count, diagnostics } = await initSkills();

    expect(count).toBeGreaterThanOrEqual(1);
    expect(diagnostics).toEqual([]);
    const skill = getSkills().find((s) => s.name === "root-cause-analysis");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("根");
    expect(skill?.content).toContain("根因");
    // filePath 指向真实文件，供 formatSkillInvocation 的 location 用
    expect(skill?.filePath).toMatch(/root-cause-analysis\/SKILL\.md$/);
  });
});

describe("findSkill", () => {
  it("命中返回对应 skill，未命中返回 undefined", () => {
    setSkillsForTest([fakeSkill({ name: "a" }), fakeSkill({ name: "b" })]);
    expect(findSkill("a")?.name).toBe("a");
    expect(findSkill("nope")).toBeUndefined();
  });
});

describe("skillsSystemPromptBlock", () => {
  it("列出可见 skill 的 name 与 description，并指示调用 read_skill", () => {
    setSkillsForTest([fakeSkill({ name: "alpha", description: "第一个" })]);
    const block = skillsSystemPromptBlock();

    expect(block).toContain("read_skill");
    expect(block).toContain("<name>alpha</name>");
    expect(block).toContain("<description>第一个</description>");
  });

  it("排除 disableModelInvocation 的 skill", () => {
    setSkillsForTest([
      fakeSkill({ name: "visible" }),
      fakeSkill({ name: "hidden", disableModelInvocation: true }),
    ]);
    const block = skillsSystemPromptBlock();

    expect(block).toContain("<name>visible</name>");
    expect(block).not.toContain("hidden");
  });

  it("没有可见 skill 时返回空串（拼接时不多出空块）", () => {
    expect(skillsSystemPromptBlock([])).toBe("");
    setSkillsForTest([fakeSkill({ disableModelInvocation: true })]);
    expect(skillsSystemPromptBlock()).toBe("");
  });

  it("对 name/description 里的 XML 特殊字符转义", () => {
    setSkillsForTest([fakeSkill({ name: "a&b", description: "<x>" })]);
    const block = skillsSystemPromptBlock();

    expect(block).toContain("a&amp;b");
    expect(block).toContain("&lt;x&gt;");
  });
});

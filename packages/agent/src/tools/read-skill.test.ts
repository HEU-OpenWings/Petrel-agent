import { type AgentHarnessEvent, InMemorySessionRepo, type Skill } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";
import { setSkillsForTest } from "../skills/catalog.ts";
import { currentTime } from "./current-time.ts";
import { readSkill } from "./read-skill.ts";
import { listToolNames, registerSkillTool, registerTool, resetRegistry } from "./registry.ts";

const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "root-cause-analysis",
    description: "结构化根因分析",
    content: "先复现再定位，逐层追问为什么",
    filePath: "/skills/root-cause-analysis/SKILL.md",
    disableModelInvocation: false,
    ...overrides,
  };
}

const ctx = { userId: "u", sessionId: SESSION_ID };

afterEach(() => setSkillsForTest([]));

describe("read_skill 工具", () => {
  it("命中时返回 skill 正文（含 name 与 content）", async () => {
    setSkillsForTest([fakeSkill()]);
    const result = await readSkill.execute(
      "call-1",
      { name: "root-cause-analysis" },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");

    expect(text).toContain("先复现再定位");
    expect(text).toContain("root-cause-analysis");
  });

  it("未知 skill 抛错（pi 会转成 isError result，对话不中断）", async () => {
    setSkillsForTest([fakeSkill()]);
    await expect(readSkill.execute("call-2", { name: "nope" }, undefined, undefined, ctx)).rejects.toThrow(
      "未知 skill",
    );
  });

  it("disableModelInvocation 的 skill 模型不可加载（当作不存在）", async () => {
    setSkillsForTest([fakeSkill({ disableModelInvocation: true })]);
    await expect(
      readSkill.execute("call-3", { name: "root-cause-analysis" }, undefined, undefined, ctx),
    ).rejects.toThrow("未知 skill");
  });
});

describe("registerSkillTool 条件注册", () => {
  afterEach(() => {
    resetRegistry();
    registerTool("get_current_time", currentTime);
  });

  it("有 skill 时注册 read_skill", () => {
    resetRegistry();
    setSkillsForTest([fakeSkill()]);
    registerSkillTool();
    expect(listToolNames()).toContain("read_skill");
  });

  it("没有任何 skill 时不注册（不给模型一个空工具）", () => {
    resetRegistry();
    setSkillsForTest([]);
    registerSkillTool();
    expect(listToolNames()).not.toContain("read_skill");
  });

  it("重复调用幂等，不撞名冲突", () => {
    resetRegistry();
    setSkillsForTest([fakeSkill()]);
    registerSkillTool();
    expect(() => registerSkillTool()).not.toThrow();
    expect(listToolNames().filter((n) => n === "read_skill")).toHaveLength(1);
  });
});

describe("read_skill 跑在真实 agent loop 上", () => {
  it("模型调 read_skill 后拿到 skill 正文", async () => {
    setSkillsForTest([fakeSkill()]);
    resetRegistry();
    registerTool("get_current_time", currentTime);
    registerSkillTool();

    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
    const events: AgentHarnessEvent[] = [];
    const harness = createHarness({
      session,
      models,
      model: faux.getModel(),
      toolContext: () => ctx,
    });
    harness.subscribe((event) => {
      events.push(event);
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_skill", { name: "root-cause-analysis" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("按 skill 指令来")]),
    ]);
    await harness.prompt("帮我查这个 bug 的根因");

    const end = events.find((e) => e.type === "tool_execution_end") as
      | { isError: boolean; result: { content: { text?: string }[] } }
      | undefined;
    expect(end?.isError).toBe(false);
    expect(end?.result.content.map((b) => b.text).join("")).toContain("先复现再定位");
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
  });
});

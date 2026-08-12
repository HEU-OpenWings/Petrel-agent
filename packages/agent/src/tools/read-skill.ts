import { type AgentHarnessTool, formatSkillInvocation } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { ToolContext } from "../harness.ts";
import { findSkill } from "../skills/catalog.ts";

const ReadSkillParams = Type.Object({
  name: Type.String({ description: "要加载的 skill 名称，取系统提示 available_skills 列出的 name" }),
});

/**
 * 加载一个 skill 的完整指令。
 *
 * 这是服务端版的「渐进披露」：系统提示只列 skill 的 name/description，模型判断任务
 * 匹配时调本工具拿正文，正文作为 tool result 进入上下文。pi 原生的渐进披露靠模型自己
 * `read` 磁盘上的 SKILL.md，但多租户服务端不给模型文件系统权限——按名查表的工具既复刻了
 * 渐进披露，又没有路径遍历攻击面。
 *
 * skill 是全局静态资源，不看调用者身份，所以忽略 context（同 get_current_time）。
 *
 * 失败靠 throw：AgentToolResult 没有 isError 字段，pi 在 agent-loop 的 try/catch 里
 * 捕获异常并生成 isError 的 tool result，对话不中断（见 memory-search.ts 注释）。
 */
export const readSkill: AgentHarnessTool<ToolContext> = {
  name: "read_skill",
  label: "加载 skill",
  description:
    "加载某个 skill 的完整指令。当任务匹配系统提示 available_skills 里某个 skill 的描述时，" +
    "先调用它取回该 skill 的指令，再按指令完成任务。",
  parameters: ReadSkillParams,
  execute: async (_toolCallId, params: Static<typeof ReadSkillParams>, _signal, _onUpdate, _context) => {
    const skill = findSkill(params.name);
    // disableModelInvocation 的 skill 对模型不可见（不在 available_skills 里），
    // 也不允许模型主动加载——它只留给用户的 /skill: 显式调用。当作「不存在」处理。
    if (!skill || skill.disableModelInvocation) {
      throw new Error(`未知 skill：${params.name}`);
    }
    const text = formatSkillInvocation(skill);
    return { content: [{ type: "text", text }], details: { name: skill.name } };
  },
};

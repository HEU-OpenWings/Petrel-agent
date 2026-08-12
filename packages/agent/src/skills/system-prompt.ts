import type { Skill } from "@earendil-works/pi-agent-core";
import { getSkills } from "./catalog.ts";

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 生成注入系统提示的 skill 列表块。
 *
 * 不复用 pi 的 formatSkillsForSystemPrompt：它输出 `<location>{filePath}</location>` 并指示
 * 模型去 `read` 磁盘上的文件——服务端不给模型文件系统权限，那条路是死的。这里改成指示模型调
 * read_skill(name) 拿正文（渐进披露的服务端版本）。
 *
 * 只列可见 skill：disableModelInvocation 的 skill 对模型隐藏，只留给用户 /skill: 显式调用。
 * 没有可见 skill 时返回空串，调用方拼接时不会多出空块。
 */
export function skillsSystemPromptBlock(skills: Skill[] = getSkills()): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "以下 skill 提供针对特定任务的专门指令。",
    "当任务匹配某个 skill 的描述时，先调用 read_skill(name) 加载它的完整指令，再按指令完成任务。",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

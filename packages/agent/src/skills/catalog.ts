import { fileURLToPath } from "node:url";
import { loadSkills, type Skill, type SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * 内置捆绑 skill 的目录。
 *
 * 相对本模块解析而不是相对 cwd：dev 下 tsx 从 `src/skills/catalog.ts` 跑、
 * 构建后从 `dist/skills/catalog.js` 跑，两者的 `../../skills` 都指向
 * `packages/agent/skills`（skills 目录是 src / dist 的同级兄弟，不进编译）。
 */
const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/**
 * 进程级 skill 目录。启动时由 initSkills() 一次性填充，之后只读。
 *
 * skill 是内置捆绑、全用户共享的静态资源，所以一份常驻目录足够——
 * 与按 sessionId 常驻的 harness 不同，这里没有 per-user 状态。
 */
let catalog: Skill[] = [];

/**
 * 加载捆绑 skill。仿 initMcpTools 在 apps/server 启动时调用一次。
 *
 * loadSkills 是异步的（读文件系统 + 解析 frontmatter），不能在模块顶层同步做。
 * 返回 diagnostics 让调用方（持有 logger 的 apps/server）打日志——packages/agent
 * 沿用 initMcpTools 的做法不依赖 logger。坏掉的单个 skill 文件只是不出现在目录里，
 * 不该拖垮进程启动。
 */
export async function initSkills(): Promise<{ count: number; diagnostics: SkillDiagnostic[] }> {
  const env = new NodeExecutionEnv({ cwd: SKILLS_DIR });
  const { skills, diagnostics } = await loadSkills(env, SKILLS_DIR);
  catalog = skills;
  return { count: skills.length, diagnostics };
}

/** 全部已加载的 skill。供 createHarness 的 resources.skills 与 read_skill 工具读同一份。 */
export function getSkills(): Skill[] {
  return catalog;
}

/** 按名查找 skill；找不到返回 undefined。 */
export function findSkill(name: string): Skill | undefined {
  return catalog.find((skill) => skill.name === name);
}

/** 仅供测试：直接注入目录，跳过文件系统加载。 */
export function setSkillsForTest(skills: Skill[]): void {
  catalog = skills;
}

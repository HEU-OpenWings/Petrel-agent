# CLAUDE.md

本文档用于约束 Claude Code 在本仓库中的开发行为。

## 项目概览

Petrel Agent 是一个自托管 AI Agent 对话系统，基于 Hono、Vue 3、PostgreSQL 和
[pi](https://github.com/earendil-works/pi) 构建。项目采用 TypeScript ESM、Node 24 与
pnpm workspace，并通过 Docker Compose 运行开发环境。

## 开发原则

- 开始前明确需求、假设和验收标准；存在关键歧义时先询问。
- 只实现明确要求，优先选择最简单、直接的方案，避免过度抽象和防御性回退。
- 仅修改与任务相关的代码，遵循现有风格，不顺手重构或清理无关内容。
- 修复缺陷时优先补充回归测试；完成后按改动范围验证。
- 代码应职责清晰、便于顺序阅读，避免将简单逻辑拆成大量细碎 helper。
- 配额、持久化等关键故障保持 fail-closed，不得静默降级或放行。

## 架构约束

- 依赖方向固定为 `apps → packages`，package 之间不得形成循环依赖。
- pi 相关接线仅允许位于 `packages/agent`；上层通过 `@petrel/agent` 提供的
  harness 与类型访问。
- 仅 `packages/config` 可直接读取 `process.env`；模型 API key 的 pi-ai 认证机制除外。
- `apps/server/src/http/app.ts` 中只有 `system` 和 `auth` 是公开前缀；业务路由必须挂载在
  `requireAuth` 之后。
- 新增 package 时同步更新 Docker Compose 源码挂载、`tsconfig.base.json` paths 和
  `vitest.config.ts` alias。

## 开发流程

应用统一通过 Docker Compose 运行。源码支持热重载，不要在宿主机另起前端开发服务。

```bash
cp .env.template .env
docker compose up -d

pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

- 修改源码后通常无需重启容器。
- 修改 `.env` 或生成数据库 migration 后，执行 `docker compose up -d` 重新创建容器。
- 修改 schema 后运行 `pnpm --filter @petrel/database run db:generate`，不要直接运行
  `drizzle-kit migrate`。
- 提交前按 `lint → typecheck → test → build` 顺序检查；小改动可先运行相关测试，再决定是否全量验证。

## 测试与 Review

- 测试文件与源码就近放置，优先验证真实行为、关键路径和回归风险。
- 单文件测试：`pnpm vitest run <file>`；单用例可使用 `-t "<name>"`。
- 在仓库根目录运行全量 Vitest 时，排除 `.claude` 工作树：
  `pnpm vitest run --exclude '**/.claude/**'`。
- Review 优先级：功能正确性、安全与数据风险、方案复杂度、可维护性、测试有效性。
- 不直接改写存在取舍的实现；先说明问题、影响和建议。

## 提交规范

- 使用简洁明确的中文提交信息，说明改动内容和原因。
- PR 描述应包含行为变化、配置影响、验证结果和未验证项。
- Review 意见逐项标记 `fixed`、`deferred` 或 `rejected`，并说明理由。

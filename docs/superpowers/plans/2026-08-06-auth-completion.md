# 认证补全实施计划（注册限流 · 邮箱验证 · 密码重置）

> **For agentic workers:** 建议按任务顺序执行；每步结束后跑对应测试，最后全量 `typecheck` / `lint` / `test` / `build` + 容器冒烟。

对应设计：[2026-08-06-auth-completion-design.md](../specs/2026-08-06-auth-completion-design.md)

## 完成情况

| # | 任务 | 状态 |
| --- | --- | --- |
| 1 | config：邮件与限流配置 + 测试 | ✅ |
| 2 | database：users 5 列 + migration + repository + 测试 | ✅ |
| 3 | server：mailer（nodemailer SMTP / console） | ✅ |
| 4 | server：rate-limit（固定窗口内存计数） | ✅ |
| 5 | server：auth service（注册发信、登录门禁、验证、忘记/重置、重发） | ✅ |
| 6 | server：auth 路由新端点 + HTML 页面 | ✅ |
| 7 | 测试：更新既有 register→cookie 用例；新增验证/重置/限流用例 | ✅ |
| 8 | 前端：LoginView 注册成功提示 + 忘记密码入口；user store 不再自动登录 | ✅ |
| 9 | 文档：.env.template / CLAUDE.md / backend-plan.md | ✅ |
| 10 | 全量检查 + docker 冒烟 | ✅ |

全量检查：typecheck ✅ · lint ✅（14 个既有风格警告）· test 551 passed / 2 skipped ✅ ·
build ✅。容器冒烟：注册 → 未验证登录 403 → 验证链接 → 登录 → 忘记密码 → 重置 → 旧密码失效；
注册限流第 6 次 429；前端 HMR 生效。

## 约束

- `@petrel/config` 是全仓唯一读 `process.env` 的位置；
- 依赖方向固定 `server → database → config`；
- 邮箱/密码在服务层统一 `toLowerCase()`；
- 注释与提交信息用中文；
- 测试命令 `pnpm vitest run <path>`，检查命令 `pnpm run typecheck` / `pnpm run lint`；
- `apps/web` 没有 typecheck/lint，靠 vitest 与手工验证。

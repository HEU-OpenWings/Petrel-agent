# 会话与设置前端人工验收（2026-08-10）

## 范围与环境

- 首轮基线：`origin/main` `023f29f`
- 最新主干复核基线：`origin/main` `cab8fae`（PR #23 合入后重新 rebase 并复验）
- 页面：`http://localhost:5173/agent`
- 运行方式：`docker compose` 的真实 web / api / PostgreSQL
- 账号：隔离的 `codex.qa.*` 本地 QA 账号
- 流式语义：临时接入本地 OpenAI-compatible 慢流，验完已恢复默认 compose 配置并删除临时服务

这轮只验证浏览器可见行为，不重复后端计划中已经通过的 11 项 HTTP + psql 契约测试。PR #23
在首轮验收后合入并改动了 `ChatView`、`useAgentStream` 与 abort 状态机，因此相关路径又在
`cab8fae` 上完整重跑，不能直接沿用旧基线结论。

## 验收结果

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 会话操作图标只在 hover 出现 | ✅ | 首项 hover 前重命名/删除按钮 `opacity=0`，hover 后均为 `1`；截图确认布局没有抖动 |
| active 高亮与双会话切换 | ✅ | A/B 往返后仅当前项带 `session-item active`，背景从透明变为 `rgb(236, 236, 234)`；正文分别恢复 `A-OK` / `B-OK`，没有串会话 |
| 刷新恢复历史 | ✅ | 刷新后会话列表恢复；重新选择会话后完整 transcript 恢复 |
| 新建会话不发消息不入列表 | ✅ | 连点两次“新对话”，列表数量保持 `6 → 6`，无 active 历史项 |
| 中断后的半截回答 | ✅ | 450 ms 时页面已有 10 个片段；点击停止后按钮恢复发送态，正文保留半截并显示 `Request was aborted` |
| 停止走显式 abort | ✅ | api 日志出现 `POST /api/chat/abort 200`；数据库 assistant 的 `stopReason=aborted`，只落一条半截消息 |
| 切换会话只断本地接收 | ✅ | 切走期间没有 `/api/chat/abort`；返回后读取到 100 个片段及 `<<BACKGROUND_COMPLETE>>`，数据库完整消息 `aborted=0` |
| 离开 Agent 后继续生成 | ✅ | 生成中进入 Dashboard，返回 Agent 后会话在列表中，完整回答与结束标记均可恢复 |
| 设置 tab、表单校验 | ✅ | 通用/模型服务/账号三 tab 正常切换；空密码、少于 8 位、两次密码不一致均显示对应校验文案 |
| 保存期间输入禁用 | ✅ | PostgreSQL 暂停制造在飞请求时，system prompt 与模型下拉均不可编辑；恢复后保存成功并重新启用 |
| 设置加载失败与重试 | ✅ | 临时让偏好端点返回 503，面板显示“设置读取失败”与重试按钮；恢复端点后重试回到完整表单 |
| `prompt` / `confirm` / `alert` 原生弹窗视觉 | ⚠️ 环境受限 | 代码路径仍分别调用 `window.prompt` / `window.confirm` / `window.alert`；Codex 内置浏览器会自动关闭原生 JS dialog，`getJsDialog()` 无法捕获，因此本轮不能诚实标为人眼通过 |

## PR #23 合入后的复验

- 成功中断：450 ms 时已有 16 个片段；停止后没有完成标记，按钮恢复发送态，页面保留半截回答并显示
  `Request was aborted`。API 只有一次 `POST /api/chat/abort 200`，数据库只有一条 assistant，
  `stopReason=aborted`。
- 停止请求在飞：暂停 API 后按钮切为“正在停止回答”并禁用；刻意让请求超过 10 秒后，界面复位并显示
  超时错误。对应的重复点击只发一次、失败后可重试行为另由 `useAgentStream.test.js` 覆盖。
- 切换会话：切走时已有 14 个片段；90 秒日志窗口内 abort 次数为 0。返回后恢复 600 个片段与
  `<<CURRENT_MAIN_COMPLETE>>`，数据库 assistant 为 `stopReason=stop`。
- 离开 Agent：进入 Dashboard 时已有 15 个片段；返回后同样恢复 600 个片段与完成标记，日志无 abort，
  数据库 assistant 为 `stopReason=stop`。
- 未受 PR #23 影响的基础路径也做了抽查：设置三 tab 与空密码校验通过；连续新建空会话后列表
  `17 → 17`，且没有 active 历史项。
- `useAgentStream`、`chat_api`、session store、preferences store 针对性回归：4 files / 54 tests passed。

## 结论

除原生 JS dialog 的浏览器环境限制外，清单中的会话、设置与中断语义均通过；没有发现需要修改业务代码的缺陷。

原生弹窗仍需在普通 Chrome / Edge 中补一次可见性确认：重命名 prompt、删除 confirm，以及让重命名或删除接口失败后的 alert。本轮再次尝试连接 Chrome 与 Edge，当前环境均不可用。组件测试基建合入后，应把三条分支改为自动化回归，减少对浏览器原生弹窗能力的依赖。

## 质量门禁

- `pnpm run lint`：通过（258 files）；保留主干已有的 2 条 `harness-registry.ts` unused warning
- `pnpm run typecheck`：通过
- `pnpm vitest run --exclude '**/.claude/**' --testTimeout 15000`：44 files passed / 1 skipped；725 passed / 2 skipped
- `pnpm run build`：通过；仅有既有的 Vite chunk size warning

默认 5 秒测试超时下，`packages/agent/src/tools/mcp.test.ts` 的“不存在的 host 也降级为无工具”在本机 DNS 失败返回较慢，约 10.7 秒后通过；因此全量回归只放宽测试超时，没有修改该用例或 MCP 业务代码。

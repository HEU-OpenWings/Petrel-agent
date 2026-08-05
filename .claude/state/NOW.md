# NOW.md — HEU-40 配额与 token 计量

## 目标
Linear HEU-40（https://linear.app/fzb/issue/HEU-40）：每次 run 的 usage 归属到 user 落库；用户/时间窗配额超限明确拒绝；配额口径与 Dashboard 对齐。公开注册的前置。

## 已完成（2026-08-05）
- 分支 `feat/quota-usage-metering`，改动 15 已跟踪文件 + 8 新文件（+614/-31）
- 数据模型：
  - `token_usage`（append-only 事实表）：entry_id 幂等 PK、user_id 级联、session_id **无级联外键**（防删会话恢复额度）、CHECK 钉死 total=四分量之和、numeric(20,12) cost、3 索引
  - `user_quota_limits`（用户覆盖额度，无窗口状态）：token_limit 覆盖 env 默认
- 计量：`PgSessionStorage.appendEntry` 内事务双写 session_entries + token_usage（entry_id 幂等，覆盖 message/compaction/branch_summary）
- usage 提取：`packages/agent/src/session/usage.ts`（Pick<Usage> 编译期钉字段名，不读 usage.totalTokens）
- 配额拦截：`chat.ts` acquire 后/streamSSE 前检查；软阈值（事后结算 + 下轮拦截）；429 + Retry-After；admin 豁免拒绝但仍计量
- fail-closed：memory 降级 → 503 不调用模型（对旧「能聊不落库」的有意行为变更）
- config：QUOTA_TOKEN_LIMIT / QUOTA_WINDOW_HOURS / QUOTA_ENFORCEMENT（默认 enforcement=false，分阶段上线）
- admin 端点：PUT/DELETE /api/admin/users/:id/quota
- migration 0006 生成（schema-only，无 CONCURRENTLY）

## 验证状态（全绿）
- typecheck：7 包全过
- lint：0 error（18 warning 均为既有文件无关）
- 全量测试：448 passed | 2 skipped（含 PGlite 跑 0006 migration、双写事务、幂等、CHECK、删会话保留额度、getSessionStats 一致、配额 429、fail-closed 503、admin 端点鉴权）
- 关键回归：构造 totalTokens 与四分量不一致的非零 usage，断言不读 usage.totalTokens（防 pi 升级归零）

## 关键决策（用户已拍板）
- 配额：可配置 env + 滚动 24h + dev 默认 1_000_000；生产值开放注册前据用量分布再定；enforcement 开关分阶段
- admin：豁免 429 拒绝但仍完整计量
- 并发：软阈值，接受微量超额；**不宣称严格硬上限**
- 降级：fail-closed 503

## 待办
- 提交并开 PR（进行中）
- **.env.template 因权限限制未能编辑**——需手动加 3 项：QUOTA_TOKEN_LIMIT / QUOTA_WINDOW_HOURS / QUOTA_ENFORCEMENT（PR 说明已标注）

## 已知限制
- 软阈值非严格硬上限（并发 in-flight 可超额）
- DB run 中途故障当轮成本可能无法提交（入口 fail-closed 降概率）
- Retry-After 算不出时省略 header（不返回伪值）
- 历史回填：enforcement 启用首个窗口会低估（建议回填当前窗口）
- acquire 拒绝时可能已留空 session 行（不调模型，可接受）

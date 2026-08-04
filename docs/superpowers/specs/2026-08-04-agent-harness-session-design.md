# Agent 内核升级：AgentHarness + Postgres 会话树（设计）

日期：2026-08-04 · 状态：待实施 · 对应 Linear：HEU-10 收尾 / M2 内核

本文是 agent 核心能力升级的**第一个**子项目（下称 **A**）的设计。它只做内核替换与会话存储改造，
不新增用户可见功能。上下文管理、tool/skill 管理、记忆系统各有自己的 spec。

## 1. 背景：pi 已有一整层我们没接

`packages/agent` 当前 41 行：裸 `new Agent()` + 一个 `get_current_time` 工具。
而 `@earendil-works/pi-agent-core@0.83.0` 里有一层 `AgentHarness`，
把「上下文压缩 / skills / 工具子集 / hooks / 会话树 / 消息队列」都实现了：

| 能力 | pi 提供的东西 | 位置 |
| --- | --- | --- |
| 上下文压缩 | `estimateContextTokens` · `shouldCompact` · `findCutPoint` · `compact()` · `DEFAULT_COMPACTION_SETTINGS` | `harness/compaction/*` |
| 分支摘要 | `navigateTree()` · `generateBranchSummary` | `harness/compaction/branch-summarization` |
| skills | `Skill` · `loadSkills()` · `formatSkillsForSystemPrompt()` · `harness.skill(name)` | `harness/skills.ts` |
| 工具管理 | `setTools()` · `setActiveTools()`（活跃子集） | `harness/agent-harness.ts` |
| 人工审批 | `tool_call` hook 可返回 `{ block, reason }` | `harness/types.ts` |
| 会话存储 | `SessionStorage` / `SessionRepo` **是接口**，自带 jsonl 与 memory 两个实现 | `harness/session/*` |
| 长期记忆 | **没有** | — |

**硬约束**：pi 的压缩吃 `SessionTreeEntry[]`（`prepareCompaction(pathEntries, settings)`），
不是 `AgentMessage[]`；skills、hooks、工具子集全挂在 `AgentHarness` 上。
所以上下文管理与 tool/skill 管理都不可能在现有的裸 `Agent` + 线性 `messages` 表上做，
必须先有 Postgres 版 `SessionStorage`。这就是 A 存在的理由，也是它必须排在最前的理由。

### 子项目分解

- **A（本文）**：`AgentHarness` + Postgres 会话树，替换现有落库逻辑
- **B**：上下文管理（自动压缩触发、阈值策略、context 用量透出前端）
- **C**：tool / skill 管理（工具注册表、活跃子集、skill 来源、`tool_call` hook 做人工审批 = HEU-8）
- **D**：记忆系统（跨会话长期记忆，pi 无对应能力）

## 2. 核对过的 pi 行为（勿凭文档记忆）

以下四条来自读 `0.83.0` 的 dist 源码，其中两条与官方文档说法不一致。行号指
`node_modules/.../pi-agent-core/dist/harness/agent-harness.js`。

1. **压缩只能手动触发，且阈值硬编码**（`:649`）。`compact()` 内部写死
   `DEFAULT_COMPACTION_SETTINGS`，不接受自定义 settings，且要求 `phase === "idle"`
   （只能在 turn 之外调）。文档里「超过 `contextWindow - reserveTokens` 自动触发」与
   `~/.pi/agent/settings.json` 都是 **pi CLI 层**的实现，harness 里没有。
   → B 要自己写自动触发；自定义阈值只能通过 `session_before_compact` hook 接管摘要生成。
2. **`followUp()` 在 `phase === "idle"` 时抛 `invalid_state`**（`:617`）。
   所以「busy 就 followUp」存在竞态，必须在调用侧串行化，见 §5。
3. **`followUp` 的消息在同一个 run 内被 drain**（`getFollowUpMessages`，`:407`），
   整个 run 只在最后发一次 `agent_end`，紧跟 `settled`（`:479`）。
   → SSE 连接「活到 `settled`」是正确的收尾条件。
4. **落库在 `handleAgentEvent` 里直接 `await session.appendMessage()`，外面没有 try/catch**
   （`:456`）。写库抛错会冒泡进 agent loop，**整轮对话失败**。
   → CLAUDE.md 那条「仓储写失败不中断对话」的不变式在 A 之后不再自动成立，见 §6。

另外 skills 的「渐进披露」是靠模型自己 `read` 文件正文（系统提示只放 name / description /
filePath），官方文档明说 `models don't always do this`。服务端不会给多用户 agent 文件系统权限，
所以 C 里 skill 正文必须换一条注入路径——这是 C 的问题，A 不涉及。

## 3. 既定决策

| 决策项 | 结论 | 理由 |
| --- | --- | --- |
| 数据模型 | 新建 `session_entries`，**废弃 `messages` 表** | 树模型与线性 `seq` 模型不兼容，硬塞会同时破坏两边 |
| 旧数据 | 直接丢弃重建，**不写数据搬运**（schema migration 照常有：建 `session_entries` + 删 `messages`） | dev 库里是测试数据 |
| 请求里的 `systemPrompt` | 只在**首次装配**该会话的 harness 时生效，缓存命中时忽略 | `AgentHarness` 没有 `setSystemPrompt()`，见 §5 |
| `PgSessionStorage` 放哪 | `packages/agent`，新增 `agent → database` 边 | 它是 pi 接口的实现，按「pi 接线只在 agent/ai」就该在这；`database` 更底层，无环 |
| harness 生命周期 | 按 `sessionId` 缓存常驻实例 | 换来「关页面不丢回答」与并发天然串行化 |
| 连接断开 | **不 abort**，跑完并落库 | 断线/关页面不再丢回答 |
| 显式停止 | 新增 `POST /api/chat/abort` | 关连接不再等于停止 |
| 同会话并发请求 | 进 `followUp` 队列，当轮结束自动接上 | 用上常驻实例的能力，避免多标签页报错 |
| 增量重连 | **不做**（留给后续） | 需要前端重连状态机，是另一个量级 |
| 写库失败 | 分级降级，见 §6 | 缺条目 = 下一轮上下文有洞，不能静默 |
| `interruptedSeqs` | 从 `GET /:id/messages` 契约**移除** | 已 grep 确认 `apps/web` 从未消费；中断由消息自带 `stopReason: "aborted"` 表达 |
| `sessions` 表 | 保持原样不动 | 左栏列表要 `title` / `updated_at` / `user_id`，从 entries 扫既慢又绕 |

## 4. 架构

### 4.1 `session_entries` 表（`packages/database`）

```
id            uuid PK              -- pi 的 createEntryId() 生成（uuidv7，自身单调递增）
session_id    uuid NOT NULL FK → sessions.id ON DELETE CASCADE
parent_id     uuid NULL            -- 定序靠它，不再有 seq 锁
entry_seq     bigserial            -- 仅供 getEntries({ afterEntrySeq }) 游标分页，不参与语义定序
type          text NOT NULL        -- message / compaction / model_change / leaf / label / …
payload       jsonb NOT NULL       -- 该类型条目的其余字段，pi 结构原样存
created_at    timestamptz NOT NULL DEFAULT now()

index (session_id, entry_seq)      -- 游标分页与全量读
index (session_id, type)           -- findEntries(type)
```

`payload` 存 jsonb 而不拆字段，与现在 `messages.message` 的理由相同：pi 仍在快速演进，
拆字段等于把它的内部结构固化进表结构。11 种条目类型见 `harness/types.d.ts`
（`message` · `compaction` · `branch_summary` · `model_change` · `thinking_level_change` ·
`active_tools_change` · `label` · `session_info` · `leaf` · `custom` · `custom_message`）。

**一并删除**：`messages` 表、`createMessageRepository`、`interrupted` 列、
`append()` 里那个 `SELECT ... FOR UPDATE` 事务，以及 `messages.test.ts` /
`messages.integration.test.ts`。

### 4.2 `createEntryRepository(db)`（`packages/database`）

只写 SQL，**不 import 任何 pi 类型**（这是 §3 依赖方向决策能成立的前提）：

- `append(entry)` · `byId(id)` · `byType(sessionId, type)`
- `pathToRootOrCompaction(sessionId, leafId)` — 从叶子沿 `parent_id` 上溯，遇 `compaction` 停
- `listAfter(sessionId, afterSeq, limit)` — 游标分页
- `latestLeaf(sessionId)` · `stats(sessionId)`

### 4.3 `PgSessionStorage` / `PgSessionRepo`（`packages/agent/src/session/`）

`PgSessionStorage implements SessionStorage`：把 pi 的 12 个方法翻译成 4.2 的调用。
**这里是唯一懂「11 种条目类型怎么拆进 `type` + `payload`」的地方。**

`PgSessionRepo implements SessionRepo`：`create` / `open` 真实现；
`list` / `delete` 委托给现有 `sessionRepo`（它有 `userId` 收窄，是唯一该管归属的地方）；
`fork` 抛 not supported——A 不做分支，等真要分支 UI 时再实现（见 §9、§11.2）。
调用方（`HarnessRegistry`）实际只用到 `create` / `open`，另三个方法是为满足接口而存在。

### 4.4 `createHarness()`（`packages/agent`）

替换 `createAgent()`。注意 `AgentHarnessOptions` 要 **`models: Models`** 而不是 `streamFn`
（与现在 `createAgent` 传 `streamFn: models.streamSimple.bind(models)` 不同）。
装配 `session` · `models` · `model` · `tools` · `systemPrompt`。
**pi 的接线仍然只在 `agent` 与 `ai` 两个 package。**

### 4.5 `HarnessRegistry`（`apps/server/src/services/`）

`Map<sessionId, { harness, lastUsedAt, refCount, chain }>`，职责：

- `acquire(sessionId, userId)` — 归属校验 → 命中复用 / 未命中装配
- 每会话一条 promise 链（`chain`），串行化 `prompt` / `followUp` 的选择
- `abort(sessionId)` · `evict(sessionId)`
- idle TTL 回收（建议 5 分钟）、容量上限淘汰

**放 server 而不是 agent**：它管的是进程内运行时状态与 HTTP 生命周期；`agent` 保持
「纯装配，可用 `fauxProvider` + `InMemorySessionRepo` 独立测试」。

### 4.6 删除 `attachPersistence`

`services/session.ts` 里那 70 行——`partial` 变量、`aborted` 去重、模型报错重复落库那个
修过的坑——**整体消失**。harness 通过 `Session` 自己落库（`:456` 的 `appendMessage` 与
`pendingSessionWrites` / `flushPendingSessionWrites`），不再有第二个落库路径。
`services/session.ts` 保留 `buildTitle` / `ensureSession` / `list` / `rename` / `remove` / `touch`。

CLAUDE.md 的硬约束 5（「模型报错那条同样走 `message_end`，只把 `aborted` 当特例会重复落库」）
在 A 之后不再有消费方，可以从文档里退役。

### 4.7 依赖方向

`server → agent → { ai, database }`、`server → database`、`server → logger`。无环。
`agent` 的 `package.json` 新增 `@petrel/database` 依赖，同步改 `tsconfig.base.json` paths
与 `vitest.config.ts` alias（新增 package 才需要改 compose 挂载，这里没有新 package）。

## 5. 数据流与生命周期

```
POST /api/chat { message, sessionId, systemPrompt? }
  ↓ requireAuth（照旧，每请求查库确认用户存在且未禁用）
  ↓ registry.acquire(sessionId, userId)
      ├─ sessionRepo.upsert(id, userId, title)   ← 归属校验仍在这里，冲突 → 403
      ├─ 缓存命中 → 复用 harness
      └─ 未命中 → PgSessionRepo.open/create → createHarness(session)
  ↓ streamSSE 打开 → harness.subscribe(推事件)，退订函数存起来，refCount++
  ↓ 经该会话的 promise 链：phase === "idle" ? prompt(message) : followUp(message)
  ↓ 事件流 … message_end（harness 自己落库）… agent_end → settled
  ↓ 收到 settled → 退订、refCount--、关闭 SSE
```

SSE 事件体仍是 pi 的 `AgentEvent` 原样透传，前端 `useAgentStream` 不需要改归约逻辑。

**串行入口**：`prompt` / `followUp` 的判断与调用在同一条 promise 链上执行，
第二个请求插不进中间，§2.2 的 `invalid_state` 竞态从结构上消失——不靠「捕获异常再重试」。

**连接断开**：只退订，不 abort。harness 跑完并落库，用户刷新后 `GET /:id/messages` 拿到完整结果。

**显式停止**：`POST /api/chat/abort { sessionId }` → 校验归属 → `harness.abort()`。
已结束的会话幂等返回 200；不属于自己的会话 403。
前端「停止」按钮从「关闭 fetch 流」改为调这个接口——**这是 A 里唯一必须动的前端改动**
（`apis/chat_api.js` 与停止按钮）。

**事件推送范围**：`subscribe` 是会话级的，两个连接都会看到彼此那一轮的事件。
**有意接受**：它们本来就是同一会话的消息，前端按消息 id 归约，多标签页因此自动同步。

**`systemPrompt` 的作用范围**：`AgentHarness` 只在构造时接受 `systemPrompt`，**没有
`setSystemPrompt()`**（`agent-harness.d.ts` 已核对；它只有 `setModel` / `setTools` /
`setResources` / `setThinkingLevel` / `setStreamOptions`）。所以请求体里的 `systemPrompt`
只在该会话首次装配 harness 时生效，缓存命中时被忽略。
这是常驻实例带来的行为变化，必须在 `chat.test.ts` 里显式钉住一条用例，
否则将来有人传了不同的 systemPrompt 却查不出为什么没生效。
（若 B/C 需要每轮改系统提示，正确的挂点是 `before_agent_start` hook 的
`BeforeAgentStartResult.systemPrompt`，不是重建实例。）

**实例回收**：`settled` 后开始计 idle，超 TTL（5 分钟）移除；`refCount > 0` 不回收；
会话被删除或用户被禁用时立即 `abort` + `evict`。
Map 容量上限 **200 个会话**（按单副本内部使用估：每实例常驻的是一颗上下文树的引用，
量级取决于会话长度，200 是「够用且出问题能在日志里看出来」的量，不是实测值——
压测后按实际内存调整，调整时同步改这里）。到顶时按 `lastUsedAt` 淘汰最旧的 idle 实例；
**没有 idle 可淘汰就拒绝新会话（503）而不是无限增长**——否则这层缓存是个内存炸弹。

**历史读取**：`GET /:id/messages` → `pathToRootOrCompaction(leafId)` → `buildSessionContext()`
投影出 `AgentMessage[]`。返回体 `{ messages }`，去掉 `interruptedSeqs`。
会话不存在仍返回 200 + 空数组（理由不变：新会话 id 是前端本地生成的）。

**title 生成**：仍在 `registry.acquire` 里的 `sessionRepo.upsert` 完成（首条消息前 30 字），
不迁进 entries。

## 6. 错误处理与降级

**写库失败分两级处置**（§2.4 的直接后果）：

- **开流前**：`open` / `create` session 失败 → 降级用 pi 自带的 `InMemorySessionRepo` 装配，
  本轮照常对话但不落库，与今天的降级语义一致（「能用但记不住好过不能用」）。
- **开流后**：`appendEntry` 失败 → 整轮失败，SSE 发 `event: error`，日志记 error。
  **不吞**：harness 的后续上下文正是从这颗树读的，缺条目等于下一轮拿到有洞的历史。

注意与认证的既有交互（CLAUDE.md 已记）：`requireAuth` 每请求查库，
**整库不可用时请求在中间件就 500**，根本进不到 handler。上面的开流前降级只覆盖
「auth 库可用但 entries 写失败」这类局部故障。

**其余路径**：

- **模型报错**：`emitRunFailure` 造 failure 消息，走完整 `message_start → message_end →
  turn_end → agent_end` 并落库一条。行为与今天一致，但**不再需要任何去重代码**。
- **`busy`**：串行入口已消除竞态，保留一层兜底 → 409。
- **会话删除 / 用户禁用**：`DELETE /:id` 与 admin 禁用路径必须 `registry.evict`，
  否则内存里还有个活 harness 往已删会话写，报错发生在没有请求上下文的地方，日志极难查。
- **越权**：缓存 key 是 `sessionId`，`acquire` 必须先过 `upsert` 的 `userId` 检查才返回实例。
  这是常驻缓存引入的**新**攻击面（拿到别人的活 harness 比拿到数据行更严重），必须有专门用例。

## 7. 测试

- **`PgSessionStorage` 契约测试**：同一套断言同时跑 PGlite 版与 pi 自带的
  `InMemorySessionRepo`（双实现对照）。语义等价是这个类唯一的正确性标准，
  对照实现比自己写期望值可靠。
- **真实 Postgres 集成测试保留**：树模型下并发不再靠 `FOR UPDATE`，但「两个请求基于同一
  leaf 追加」的行为要在真 Postgres 上钉住，沿用 `describe.skipIf(!process.env.DATABASE_URL)`。
  PGlite 结构性测不出并发这条坑仍然有效。
- **harness 装配**：`fauxProvider` + `InMemorySessionRepo` 跑真实 agent loop，
  验证工具循环与落库的条目序列（沿用现有模式，不需要数据库）。
- **`HarnessRegistry`**：idle TTL 回收、`refCount` 保护、容量上限淘汰、归属校验、
  串行入口（并发两个请求只产生一条 run，第二条走 followUp）。
- **`chat.test.ts` 重写**：删掉 `partial` / `aborted` 去重那批用例（对象已不存在），
  新增「断开连接后回答仍完整落库」「同会话连发两条自动排队」「abort 接口」
  「写 entries 失败时整轮失败并发 error」。`isolation.test.ts` 的挂载顺序用例不动。

## 8. 验收标准

1. `pnpm run build` / `typecheck` / `lint` / `test` 全绿；带 `DATABASE_URL` 的集成测试全绿
2. 容器里跑通现有 11 项端到端验收中与中断无关的 9 项：首次启动自动建表 · 发消息后刷新历史在 ·
   左栏出现会话且标题取首句 · 两个会话不串 · 重命名后保持 · 删除会话消息一并消失 ·
   工具调用后刷新三条消息齐全 · 旧会话发消息跳顶 · 新建不发消息不产生空会话
3. 新行为：关掉浏览器后回答仍完整落库；同会话连发两条自动排队；`POST /api/chat/abort` 能停
4. `messages` 表与 `attachPersistence` 已删除，全仓无引用
5. `packages/agent` 的测试仍然不需要数据库凭据即可跑（`fauxProvider` + 内存 session）

## 9. A 不做什么

- **不做自动压缩**：`compact()` 一行不调。B 做。
- **不做分支 UI**：`navigateTree` / `fork` 不接（`PgSessionRepo.fork` 抛 not supported）。
  树模型天然支持，但没有消费方就不实现。
- **不做 skills / 工具扩充**：工具集仍是 `get_current_time` 一个。C 做。
- **不做记忆系统**：D 做。
- **不做增量重连**：`getEntries({ afterEntrySeq })` 的游标已备好，前端重连状态机留给后续。
- **不做 steer**：`steer()` 不接，前端没有运行中插话的 UI。
- **不改 SSE 事件格式**：仍是 `AgentEvent` 原样透传。

## 10. 给 B / C / D 留的接口

不为它们写任何代码，只确认路已通：

- **B**：`session_before_compact` hook 可接管摘要生成（绕过硬编码的
  `DEFAULT_COMPACTION_SETTINGS`）；`estimateContextTokens` + `getSessionStats()` 提供用量数据；
  自动触发要在 `phase === "idle"` 时调 `compact()`，即 `prompt()` 之前。
- **C**：`harness.setTools` / `setActiveTools` 已在常驻实例上可用；`tool_call` hook 返回
  `{ block, reason }` 即 HEU-8 的人工审批挂点；skill 正文的注入路径需 C 自己设计
  （服务端不给文件系统权限）。
- **D**：`custom` / `custom_message` 条目类型可用于把记忆写进会话树；
  `before_agent_start` 与 `context` hook 可在每轮注入记忆块；archival 检索走 pgvector
  （compose 里已是 `pgvector/pgvector:pg17`）。

## 11. 风险

1. **常驻实例的内存与亲和性**。多副本部署需要会话亲和，否则第二个请求落到别的副本会
   新建实例、两个实例并发写同一颗树（结果是分叉而不是丢消息，但仍是缺陷）。
   → 当前单副本，§5 的容量上限与 TTL 是硬要求；多副本部署前必须先解决亲和性，
   记入 backend-plan 的待办。
2. **`fork` 未实现**。将来做分支 UI 时要补，且 `fork` 语义（复制 entries 还是共享前缀）
   要与 pi 的 jsonl 实现对齐。
3. **契约变更点两处**：`GET /:id/messages` 去掉 `interruptedSeqs`、停止按钮改调接口。
   前者已确认无消费方，后者要与前端同 PR 改完。
4. **pi 0.83 的 harness 尚无官方文档覆盖**。本文四条核对结论来自读 dist 源码，
   升级 pi 版本时必须重新核对（尤其 `:456` 的无 try/catch 与 `:649` 的硬编码 settings）。

# 用户级长期记忆系统（设计）

日期：2026-08-09 · 状态：待实施 · 对应 Linear：待建 issue

本文是 `2026-08-04-agent-harness-session-design.md` 里分解出的 **D（记忆系统）** 的总设计。
它定义整体架构、数据模型与共享决策，并把实施拆成 4 个可独立验收的切片（M0–M3），
每个切片实施前各写一份 plan。

**范围**：跨会话的**用户级长期记忆**——用户画像、偏好、稳定事实。条目量级是每人几十到几百条，
结构化、用户可查可删。写入由模型显式调工具发起，检索走 pgvector 语义检索。

**不做**（本轮明确排除）：

| 不做 | 理由 |
| --- | --- |
| 会话档案记忆（archival，把被压缩掉的历史原文存起来供回溯） | 量级差两个数量级（每会话上千块）、非结构化，与用户级记忆的数据模型和检索策略都不同，混在一起会互相拖累。它是独立的一轮 |
| 常驻上下文注入（每轮把记忆拼进 system prompt） | 本轮选纯检索。见 §9 风险 1——如果实测召回不行，补它**不需要改表结构** |
| 会话后异步抽取记忆 | 需要后台任务机制（仓库现在没有）、额外的模型调用与失败重试、以及这部分 token 的配额归属。本轮靠模型在对话中显式写 |
| `memory_update` 与自动去重 | v1 只有 write / search / 用户手删。见 §9 风险 3 |
| embedding 调用的配额扣减 | 与 HEU-40 口径一致：本轮不做配额，但不留下事后无法归属的实现。成本闸门是每用户条数上限 |

## 1. 核对过的仓库事实（勿凭记忆）

以下均为动笔前从当前代码与 `node_modules` 核实，不是文档记忆。

| # | 事实 | 依据 |
| --- | --- | --- |
| 1 | `createHarness()` 的工具类型是 `AgentHarnessTool<undefined>[]`，**工具执行时拿不到任何身份信息** | `packages/agent/src/harness.ts:33` |
| 2 | `tools` 无注册表，默认值硬编码为 `[currentTime]` | `packages/agent/src/harness.ts:89` |
| 3 | `harness-registry` 的 `build()` 调 `createRealHarness({ session, systemPrompt, modelId })`，**不传 tools**；而 `userId` 已在该函数作用域内 | `apps/server/src/services/harness-registry.ts:266-285`（另一处同样的装配在 `:376`） |
| 4 | `drizzle-orm@0.45.2` 带 pgvector 列类型（`pg-core/columns/vector_extension/` 目录存在） | `node_modules/.pnpm/drizzle-orm@*/` |
| 5 | **`@electric-sql/pglite@0.5.4` 不含 pgvector**：全包 `find -iname "*vector*"` 零命中，`exports` 里也没有 `./vector` | 实测 |
| 6 | pgvector 的 `./vector` export 存在于 pglite `0.2.x`–`0.4.0`，`0.4.11` 起被移除 | 逐版本 `pnpm view` |
| 7 | 扩展被拆成独立包：**`@electric-sql/pglite-pgvector@0.0.5`**，`peerDependencies` 精确锁 `@electric-sql/pglite@0.5.4`——正是仓库装的版本 | `pnpm view` |
| 8 | `createTestDb()` 用 PGlite 跑**全量 migration**，被 **18 个测试文件**依赖 | `packages/database/src/testing.ts:42`；`grep -rl createTestDb` |
| 9 | 已有真实 Postgres 的集成测试模式：`describe.skipIf(!DATABASE_URL)`，默认跳过 | `packages/database/src/repositories/entries.integration.test.ts:20` |
| 10 | compose 的 db 已是 `pgvector/pgvector:pg17` | `docker-compose.yml:5` |

### 事实 5–8 的合并结论：这是本轮最容易炸的地方

`createTestDb()` 跑的是全量 migration，而它被 18 个测试文件用着。
**一旦 `packages/database/drizzle/` 里出现 `CREATE EXTENSION vector`，PGlite 找不到该扩展 →
`migrate()` 抛错 → 这 18 个文件全部崩溃**，而不只是新增的记忆测试。
`IF NOT EXISTS` 救不了：扩展在 PGlite 里根本不存在。

**处置**：M1 的第一步必须是「给 `packages/database` 加 `@electric-sql/pglite-pgvector` devDependency，
在 `createTestDb()` 里 `new PGlite({ extensions: { vector } })`」，
**并且这一步要先于任何 vector migration 落地、单独验证 18 个文件仍全绿**。

## 2. 决策与取舍

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 记忆类型 | 用户级长期记忆 | 见开头范围 |
| 写入方式 | 模型显式调工具 | 无需后台任务；写入天然发生在请求上下文里（`userId` 可归属、token 已计量）；写入动作对用户可见 |
| 检索方式 | pgvector 语义检索 | 中文场景下 Postgres 的 `tsvector` **没有可用分词**（需 zhparser/pg_jieba，pgvector 镜像里没有），"先做关键词检索"实际会退化到 `ILIKE`。且这套基础设施知识库（HEU-21）要复用 |
| 包边界 | 新建 `packages/memory` | 已落地，见 §4 |
| 工具定义位置 | 留在 `packages/agent/src/tools/` | CLAUDE.md 规定「pi 相关接线仅允许位于 `packages/agent`」。`packages/memory` 不出现任何 pi 类型，只导出纯函数 |
| SQL 位置 | 全部在 `@petrel/database` 的 repository | `packages/memory` 只做「embed 文本 → 调 repo」的编排，不直接对表发查询 |

## 3. 交付切片

| 切片 | 内容 | 验收 | 依赖 |
| --- | --- | --- | --- |
| **M0** 工具身份上下文与注册表 | `AgentToolContext { userId, sessionId }`；`createHarness` 的 `TContext` 从 `undefined` 改成它；工具注册表，重名启动即失败 | 同进程内 A/B 两用户各自会话各调一次工具，断言各自拿到自己的 `userId` | 无 |
| **M1** 存储地基 | PGlite vector 扩展装载（先做，见 §1）→ `CREATE EXTENSION vector` migration → `user_memories` 表 + HNSW 索引 → repo（CRUD + KNN） | ① 18 个既有测试文件仍全绿；② repo 测试喂**手造向量**验证 KNN 排序正确、跨用户查不到 | 无（与 M0 可并行） |
| **M2** embedding 与编排 | `packages/memory` 的 embedding 客户端与 write/search 编排；`packages/config` 新增配置；REST `/api/memories`；前端设置页最小管理（列表 + 删除） | 真实 embedding 写入→检索闭环；用户能看到并删除自己的记忆；跨用户访问 404 | M1 |
| **M3** 工具接入 | `memory_write` / `memory_search` 两个 pi 工具 + 系统提示 | `fauxProvider` 跑真实 agent loop：A 写入的记忆 B 检索不到 | M0 + M2 |

M1 刻意不依赖 embedding provider：手造向量就能把 pgvector 这层完整测掉。

## 4. 目录结构

`packages/memory` 的骨架已于 2026-08-09 建立并通过 lint / typecheck / build / test。

```
packages/memory/                         # 已建
  package.json                           # deps: @petrel/config + @petrel/database
  tsconfig.json / tsconfig.check.json
  src/
    index.ts                             # 已建（空模块 + 边界注释）
    types.ts                             # M2：Memory / MemorySearchHit / EmbeddingError
    embedding/
      client.ts                          # M2：HTTP 客户端，维度校验、超时、signal
      client.test.ts
    search.ts                            # M2：embed(query) → repo.searchByEmbedding
    write.ts                             # M2：条数上限检查 → embed(content) → repo.insert

packages/database/src/
  schema.ts                              # M1：新增 userMemories
  testing.ts                             # M1：createTestDb 装载 vector 扩展（第一步）
  repositories/memories.ts               # M1：CRUD + searchByEmbedding，所有方法首参 userId
  drizzle/00XX_*.sql                     # M1：CREATE EXTENSION vector + 建表 + 手加 HNSW 索引

packages/agent/src/
  harness.ts                             # M0：TContext = AgentToolContext（破坏性改动）
  tools/
    context.ts                           # M0：AgentToolContext
    index.ts                             # M0：注册表，重名 throw
    current-time.ts                      # M0：适配新签名
    memory-write.ts / memory-search.ts   # M3：薄壳，调 @petrel/memory

packages/config/src/index.ts             # M2：embedding 配置 + 记忆条数上限
apps/server/src/
  services/harness-registry.ts           # M0：注入 () => ({ userId, sessionId })
  http/app.ts                            # M2：挂载 memories 路由（requireAuth 之后）
  http/routes/memories.ts                # M2：GET 列表 / DELETE 单条
apps/web/src/                            # M2：设置弹窗新增「记忆」tab
```

**新增包的 4 处同步已完成**：`docker-compose.yml`（源码挂载）、`tsconfig.base.json`（paths）、
`vitest.config.ts`（alias）。`pnpm-workspace.yaml` 用 `packages/*` 通配、
`apps/server/Dockerfile` 走 `pnpm fetch`，两者都无需改。
compose 改了挂载，**容器需 `docker compose up -d` 重建才生效**。

`src/embedding/` 与记忆域零耦合（只认「文本进、向量出」），知识库落地时可整目录平移。

## 5. 数据模型

```ts
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceSessionId: uuid("source_session_id"),   // 只读来源维度，不做级联外键
    createdAt: timestamp(...).notNull().defaultNow(),
    updatedAt: timestamp(...).notNull().defaultNow(),
  },
  (t) => [
    index("user_memories_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("user_memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
```

四个刻意的取舍：

- **`embedding` 是 `notNull`**。没有向量的记忆检索不到，等于写了条查不到的东西——静默失效，
  正是 CLAUDE.md 要求 fail-closed 的那类。embedding 失败就不落库。
- **`source_session_id` 不做级联外键**，与 `token_usage.session_id` 同理：删会话不该让记忆消失。
  记忆是用户级的，不是会话级的。副作用见 §9 风险 4。
- **只有 `content` 一个内容字段**，不预建 title / tags / priority。YAGNI，真需要时加列很便宜。
- **维度 1024 硬约束**，与 backend-plan 里知识库的统一列宽一致。换 embedding 模型 = 全量重新索引。

## 6. embedding provider：硅基流动 BAAI/bge-m3

凭据与地址经 `packages/config`，**不在工具或客户端里读 `process.env`**
（pi-ai 直读 env 的那个例外只给模型凭据）。

```
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_TIMEOUT_MS=10000
MEMORY_MAX_PER_USER=200
MEMORY_SEARCH_LIMIT=5
```

- **维度不做成环境变量**（M2 设计里收敛掉了本文初稿的 `EMBEDDING_DIM`）：
  它是表的列宽，换模型要全量重建索引，做成运行时可配等于允许配出一个必然
  INSERT 失败的组合。改为在 `packages/database/src/schema.ts` 导出
  `MEMORY_EMBEDDING_DIM = 1024`，列定义与 embedding 响应校验共用同一个常量。
- `MEMORY_MAX_PER_USER` 默认 200。它是**成本闸门**：embedding 按次计费而写入由模型驱动，
  没有上限等于成本可被无限放大。

**关于 bge-m3 的三条待核实项**（写错都是静默降低召回，不会报错，所以必须实测而非照抄）：

| # | 待核实 | 怎么核实 | 写错的后果 |
| --- | --- | --- | --- |
| 1 | dense 向量确为 1024 维 | 客户端本就要做维度断言（fail-closed），一次真实请求即可确认 | INSERT 报错，会立刻暴露，风险低 |
| 2 | query 与 document 是否需要非对称前缀 | 对同一组文本分别加/不加前缀，比较检索排序 | 召回静默变差，**不报错** |
| 3 | 输出是否已 L2 归一化 | 算一条返回向量的模长 | 影响 cosine / inner product 的等价性。索引选 `vector_cosine_ops` 在两种情况下都正确，故为安全默认 |

## 7. 失败语义

> **本节已按 pi 0.83 的 dist 修正。** 初稿照搬了 HEU-13 PRD 的「工具返回 `isError`、
> 不要抛异常」，那是错的：`AgentToolResult` 上**没有 `isError` 字段**
> （`dist/types.d.ts`），`throw` 是工具表达失败的唯一途径，而且 pi 在
> `agent-loop.js:467-475` 的 `try/catch` 里捕获它、生成 `isError` 的 tool result
> 并让 agent loop 继续——**不会**中断对话。详见 [M3 设计 §1](./2026-08-09-memory-m3-tools-design.md)。

| 场景 | 行为 | 理由 |
| --- | --- | --- |
| 未配置 embedding 凭据 | 两个记忆工具**不进注册表**，模型看不到 | 与 HEU-13 对 `web_search` 的口径一致：模型看到一个必然失败的工具会反复重试 |
| embedding provider 不可用（写入） | 工具 `throw EmbeddingError`，**不落库**；pi 转成 `isError` 结果，对话不中断 | 落一条没有向量的记忆是静默失效 |
| embedding provider 不可用（检索） | 同上 | 模型拿到错误结果后可以改口或换个做法 |
| 记忆条数超上限 | `throw MemoryQuotaError`，消息里给出「请先删除一些记忆」这个可执行建议 | 成本闸门，见 §6。消息会被模型看到并转述给用户 |
| 数据库写入失败 | 异常上抛，不静默吞 | 持久化 fail-closed |
| 用户点停止 | 进行中的 embedding 请求响应 `signal` 取消 | 不留悬挂请求 |

**附带的硬约束**：`error.message` 会原样进入模型上下文（pi 用它构造 tool result），
所以异常信息里不能有凭据、provider 的原始响应体或用户的记忆原文。

## 8. 安全边界与测试策略

**用户隔离是本轮的安全核心**：

- repo 层所有方法**首参 `userId`**，不提供无 `userId` 的查询入口——让「忘记收窄」在类型层就写不出来。
- 工具的 `userId` 只能来自 `context`，**不接受模型传参**。模型的参数来自对话内容，
  等价于让用户自己指定读谁的数据，是标准越权。
- `TContext` **必须用函数形式** `() => TContext` 而非静态值：harness 按 `sessionId` 常驻，
  静态值会把首次装配那一刻的身份冻住。M0 的验收用例就是钉这个。
- REST 路由挂在 `requireAuth` 之后，接进现成的 `apps/server/src/http/routes/isolation.test.ts` 模式。

**测试策略**：

- 数据层：PGlite + 手造向量（`createTestDb()` 装载 `@electric-sql/pglite-pgvector`）。
- embedding 客户端：打桩 HTTP，覆盖维度不符、超时、非 200、`signal` 取消。
- 工具层：`fauxProvider` 跑真实 agent loop，与 `harness.test.ts` 同一模式，不 mock 内部。
- 真实 pgvector 的 HNSW 行为（见 §9 风险 2）用 `describe.skipIf(!DATABASE_URL)` 的集成测试覆盖。
- 仓库根跑全量测试要加 `--exclude '**/.claude/**'`。

## 9. 风险

1. **纯检索、无常驻注入 → 模型可能根本不去搜。** 记忆能否被用上完全取决于模型判断。
   缓解：系统提示里显式要求「回答与用户相关的问题前先 `memory_search`」，M3 验收实测召回。
   若不达标，最小补救是加「常驻注入最近 N 条」——**表结构不用动**。
2. **HNSW 是近似索引，带 `WHERE user_id = ?` 过滤时可能 over-filter 导致召回不足。**
   这是 pgvector 的已知行为。缓解：条数上限 200 意味着单用户数据量极小，
   必要时用 `(user_id, embedding)` 的复合策略或 iterative scan；实施时用集成测试实测。
3. **模型重复写同一件事。** v1 不做自动去重，靠提示词 + 用户手删。
   实测很脏的话再加「写入前先 search，相似度超阈值则改为更新」。
4. **隐私暗坑：删除会话不会删除由它产生的记忆。** 这是 §5 的有意取舍，
   但**必须在前端记忆管理界面上写清楚**，否则用户会以为删了会话就删干净了。
5. **模型驱动的付费出网请求。** embedding 调用由模型的输出触发，与「我们自己发起的请求」性质不同。
   本轮不做配额扣减，但 `user_memories.user_id` 保证事后可归属。

## 10. 未决问题

| # | 问题 | 谁定 | 影响 |
| --- | --- | --- | --- |
| 1 | bge-m3 的三条待核实项（§6） | 实施时实测 | 2、3 写错会静默降低召回 |
| 2 | HNSW + `WHERE` 过滤的真实召回行为 | 实施时实测 | 决定索引策略 |
| 3 | `MEMORY_MAX_PER_USER=200` 是否合适 | 上线后据真实分布调整 | 太小会让模型频繁写失败 |
| 4 | 记忆系统是否要建独立 Linear issue / 拆 4 个 | 需要定 | 影响 PR 粒度 |

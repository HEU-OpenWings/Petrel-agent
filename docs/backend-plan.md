# 后端（apps/server）重构升级计划

Petrel（原 Yuxi）v0.4（Python + FastAPI + LangGraph）→ v0.5（TypeScript + Hono + pi agent harness）的后端重构计划与进度。
前端计划见 [frontend-plan.md](frontend-plan.md)。

任务跟踪在 Linear 的 **HEU-OpenWings / Agent base 重构升级** 项目，下文的 `HEU-x` 均指对应 issue。

## 1. 目标与既定决策

| 决策项 | 结论 |
| --- | --- |
| Agent 内核 | pi（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`），替代 LangGraph |
| 代码组织 | Monorepo + pnpm workspace + package 模块化 |
| 知识库 | 全量 TS 重写，不保留 Python 运行时 |
| 文档解析 | 只保留 MinerU（独立 HTTP 服务，TS 侧只写客户端） |
| 向量库 | PostgreSQL + pgvector（移除 Milvus / Chroma / etcd） |
| 保留功能 | 知识库管理 + RAG 检索、Dashboard + 评测 |
| 移除功能 | 知识图谱（Neo4j）、思维导图、LightRAG 图模式 |
| 仓库拆分 | 前后端两个独立仓库 |

### 基础设施收敛

| 服务 | v0.4 | v0.5 |
| --- | --- | --- |
| Postgres | 被注释掉，实际用 SQLite | **必需**，业务数据 + pgvector 向量 |
| Milvus / etcd / Neo4j / PaddleX | 必需 | **删除** |
| MinIO | Milvus 的依赖 | 保留，独立作为文件存储 |
| mineru-api | 可选 | 保留，成为唯一解析器 |

## 2. 当前架构

```
petrel-agent/
├─ apps/
│  ├─ server/                  # Hono HTTP 应用
│  └─ web/                     # Vue 3 前端
├─ packages/
│  ├─ agent/              # pi Agent 装配与内置工具
│  ├─ ai/                      # 模型 provider 注册（SiliconFlow，OpenAI 兼容）
│  ├─ config/                  # 环境配置；全仓唯一读取 process.env
│  ├─ database/                # Drizzle schema 与 repository；测试用 PGlite
│  └─ logger/                  # pino 日志与 HTTP 请求日志
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

依赖方向固定为 `apps → packages`，package 之间只允许指向更底层的 package。当前是
`server → agent → ai → config`、`server → database → config` 与 `server → logger → config`。

**pi 的接线只出现在 `agent` 与 `ai` 两个 package**，上层只依赖 `createAgent()` 与 Agent 的
事件流。这层薄封装是有意为之：pi 仍在快速演进（包名近期从 `@mariozechner/*` 迁到
`@earendil-works/*`），将来换内核时改动范围可控。

后续 package（`knowledge` 等）在对应业务首次落地时创建，不提前维护空 package。
异步任务成为独立进程时再增加 `apps/worker`。

## 3. 已完成

### M1 骨架（HEU-4，已交付）
pnpm + TS(ESM) + Hono + pino + Biome + vitest + 多阶段 Dockerfile + compose，
`GET /api/system/health`，`src/env.ts` 作为唯一读取 `process.env` 的位置。

### M2 Agent 内核（HEU-9 / HEU-11 完成，HEU-10 / HEU-13 部分完成）

- **`packages/ai`**：SiliconFlow 不在 pi 内置的 30 个 provider 里，用 `createProvider` +
  `openai-completions.lazy` + `envApiKeyAuth` 注册，默认模型 `deepseek-ai/DeepSeek-V3`
- **`packages/agent`**：`createAgent()` 装配 pi `Agent`，内置极简工具 `get_current_time`
- **`POST /api/chat`**：SSE，事件体为 pi 的 `AgentEvent` 原样透传，`stream.onAbort → agent.abort()`
- **测试**：用 pi 自带的 `fauxProvider` 跑真实 agent loop，不需要模型凭据也不 mock 内部，
  覆盖单轮流式事件序列与工具循环

端到端实测（真实模型 + 真实工具循环）：2 轮 turn、25 个 `message_update`、
`tool_execution_start/end` 正常，零错误。

### M1 数据层 + M2 会话持久化（HEU-6 / HEU-10 主体，2026-08-02 交付）

**`packages/database`**：Drizzle schema（`users` · `sessions` · `messages`）+ 进程级连接池单例 +
启动时执行的 migration + 两个 repository。compose 增加 `pgvector/pgvector:pg17` 服务——本轮用不到
向量，但知识库那轮要，现在用普通 postgres 镜像到时候换镜像得重建数据卷。

**`POST /api/chat`** 请求体变为 `{ message, sessionId, systemPrompt? }`，SSE 响应格式不变。
进流之前先 upsert 会话、把已存的历史原样回灌进 `initialState.messages`，然后订阅 agent 事件
按 `message_end` 增量落库。**用户消息不需要手动存**：pi 的事件序列里它同样走 `message_end`，
订阅一处就收下了，手动再存一遍会写重复。数据库不可用时整段降级——对话照常流式输出，
只是这一轮不落库、多轮上下文退化成单轮，能用但记不住好过直接不能用。

**`/api/sessions`** 四个接口：`GET /`（列表）· `GET /:id/messages`（历史）·
`PATCH /:id`（重命名）· `DELETE /:id`。

三个与下文 §4 原计划不同的设计决定，都是有意的：

1. **没建 `tool_calls` 表**。pi 的工具结果是一条独立的 `toolResult` 类型 `AgentMessage`，
   存进 `messages` 已经完整。单独的表是给 Dashboard 统计做的反范式，等 HEU-28 再加。
2. **没做 `persisted` 事件**。它是断线重连的幂等去重手段，而断线重连需要前端重连状态机，
   是另一个量级的复杂度，单独一轮做。
3. **session id 由前端生成**（对照 Vercel ai-chatbot 的做法），因此 SSE 不必新增事件类型回传 id。

**`GET /:id/messages` 对不存在的会话返回 200 + 空数组**，与 `PATCH` / `DELETE` 的 404 有意不一致：
新会话的 id 是前端 `crypto.randomUUID()` 本地生成的，用户切进去时后端还没有这一行，
这里返回 404 会让刚新建的会话直接打不开。

**消息排序用整数 `seq` 而不是 `created_at`**：agent 一轮会连续产出 assistant 与 toolResult
多条消息，插入时间戳可能落在同一毫秒。OpenAI Agents SDK 的 SQLAlchemySession 用 `created_at` 主 +
`id` 次排序，本质是在打这个补丁；`seq` 一步到位。

**但 `seq` 必须由数据库在事务内分配，不能由应用层维护**——这是本轮返工过的地方。
最初路由在请求开始时从历史算出 `startSeq` 交给订阅闭包自增，实测会在并发下**静默丢掉整轮消息**，
而且「点停止 → 立即重发」一键可达：上一轮 `agent_end` 的落库发生在 HTTP 响应关闭之后，
下一个请求此刻读到的最大序号已经过期；撞上 `messages_session_seq_unique` 之后写入失败被
listener 的 catch 吞掉，而闭包里的计数器不前进，于是本轮后面每一条都撞同一个号。
现在 `append()` 在一个事务里先 `SELECT ... FOR UPDATE` 锁住会话行，再
`INSERT ... (SELECT COALESCE(MAX(seq), 0) + 1 ...)`。**那条 `FOR UPDATE` 既不能省，也不能与
INSERT 合成一条语句**：READ COMMITTED 下每条语句各取一次快照，必须先锁住行、再让下一条语句
重新取快照去算 `MAX(seq)`，才看得到并发事务刚提交的消息。真实 Postgres 上 12 路并发实测——
带锁 12/12 全部成功且 seq 连续无洞，把锁删掉只活下来 2~3 条。

**中断的半截回答不能从 `state.streamingMessage` 取**（原计划是这么写的）。实测 pi 0.83 在触发
`agent_end` listener 之前已经把它清成了 `undefined`。实际做法是订阅闭包用一个 `partial` 变量在
`message_start` / `message_update` 时持续记录，`agent_end` 时判断本轮确实中断了才把它标记
`interrupted` 写下。另外中断时 `message_end` 还会补发一条 `stopReason: "aborted"` 的助手消息，
**它的内容不为空**——就是中断瞬间已经吐出的那部分，与 `partial` 是同一条消息的两个副本。
所以 `message_end` 里要跳过它，理由是**重复**而不是「它是空的」；依赖「空」这个前提写断言
会写出一条永远通过的假测试。

**数据层测试用 PGlite（Node 内的 WASM Postgres）而不是 testcontainers**：CI 不需要 Docker，
而外键、级联、唯一约束、事务这些语义都是真的。但它有两个坑，本轮都踩到了：

1. **它不是「毫秒级启动」**。实例化空载就要约 1 秒，CPU 被打满时超线性劣化到十几秒。
   所以实例按测试文件复用（`beforeAll` 建、`beforeEach` 用 `TRUNCATE ... RESTART IDENTITY CASCADE`
   清表隔离、`afterAll` 关），并在 `vitest.config.ts` 配 `hookTimeout: 30_000`，给这个已知昂贵的
   一次性 hook 一个有依据的预算。
2. **它结构性地测不出并发问题**。PGlite 是单后端 WASM Postgres，JS 侧并行发出去的语句会被排队
   串行执行——把 `append()` 里那条 `FOR UPDATE` 删掉，全部 PGlite 用例照样全绿。一行锁被误删、
   CI 毫无反应、线上开始静默丢消息，是这个仓库里最坏的一类缺口。为此补了
   `messages.integration.test.ts` 连真实 Postgres，`describe.skipIf(!process.env.DATABASE_URL)`，
   默认跳过：

   ```bash
   docker compose up -d db
   pnpm --filter @petrel/database exec drizzle-kit migrate   # 首次建表
   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
   ```

**顺带修掉一个排序 bug**：`sessions` 的 `upsert` / `rename` / `touch` 原本用 JS 的 `new Date()`
（毫秒精度），而 INSERT 走 schema 的 `defaultNow()`（真实 Postgres 是微秒）。同一毫秒内
insert + touch 会让刚 touch 过的会话**排到后面**，正好打在「在旧会话里发消息后它跳到顶部」
这条验收上。三处已统一成 SQL 侧的 `now()`。PGlite 的 `now()` 只有毫秒分辨率，这个 bug 在测试
环境里表现为时间戳相等而不是翻转，所以守卫是断言生成的 SQL 里出现 `now()` 而不是参数占位符。

### 会话持久化的验收状态（2026-08-03 更新：容器与端到端验收已完成）

计划 Task 12 的 11 项人工验收**已全部在容器里跑通**（下方「2026-08-03」小节），
只剩浏览器观感那几项还需要人眼确认。原先阻塞的两件事都已解除：镜像构建成功、
`SILICONFLOW_API_KEY` 已配置。

**已验证：**

- `pnpm run build`（后端 tsc + 前端 vite）全部通过
- `pnpm run typecheck` 零 error；`pnpm run lint`（Biome，51 个文件）零 error 零 warning
- `pnpm test` 不带 `DATABASE_URL`：17 passed | 1 skipped（18 个文件）/ 171 passed | 2 skipped；
  带 `DATABASE_URL` 连真实 Postgres：18 files / 173 tests 全部通过
- 数据层并发正确性：真实 Postgres 上 12 路并发 append 同一会话，seq 连续无洞一条不丢；
  把 `FOR UPDATE` 删掉后集成测试立刻变红
- **migration 链路已验证，但只在宿主机上**：新建一个空库 `petrel_migtest`，用
  `DATABASE_URL=…/petrel_migtest tsx apps/server/src/index.ts` 直接起 api，日志输出
  `database migrations applied` 与 `agent-server listening`，三张表被自动建出、默认用户被播种
  （**「默认用户播种」这段已随 HEU-7 废止**：认证落地时删掉了默认用户与 `username` 列，
  现在只建表不播种）。
  **这不等于容器内验证通过**——计划 Task 4 Step 8 要求的是 `docker compose up -d` 之后看
  `docker logs petrel-api-dev`，那一步因为下面的构建失败仍然没做。两者的差别在于镜像构建、
  compose 的环境变量注入、`depends_on: service_healthy` 这几段都还没跑过

**2026-08-03 补做：容器内 11 项端到端验收**

三个容器（`petrel-db-dev` / `petrel-api-dev` / `petrel-web-dev`）都起来了，api 日志有
`database migrations applied`。11 项逐条走的是真实模型 + 真实 Postgres，验证方式是
HTTP 接口 + `psql` 查表（不是浏览器点击）：

> **这张表跑在认证落地之前**，其中第 1 项的「默认用户播种」与第 11 项的结论都已被 HEU-7 改变，
> 见每条后面的注。

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 首次启动自动建表 | ✅ 另建空库 `petrel_fresh` 起 api，三张表建出、默认用户播种（**播种已随 HEU-7 删除**） |
| 2 | 发消息后刷新对话还在 | ✅ `GET /:id/messages` 返回完整 transcript |
| 3 | 左栏出现会话，标题取首句 | ✅ 标题 = `用一句话介绍你自己` |
| 4 | 两个会话不串 | ✅ A / B 各 4 条，互不可见（后端层面） |
| 5 | 重命名后保持 | ✅ 改名后再发消息，标题没被打回首句 |
| 6 | 删除会话消息一并消失 | ✅ 6 → 0 行级联删除，重复删返回 404 |
| 7 | 中途停止能看到半截回答 | ✅ 3 秒掐断连接，落库一条 `interrupted = true` 的半截散文，**没有重复写** |
| 8 | 工具调用后刷新能重建 | ✅ `assistant(text+toolCall)` → `toolResult` → `assistant` 三条齐全 |
| 9 | 旧会话发消息跳顶 | ✅ A 从第 2 位回到第 1 位 |
| 10 | 新建不发消息不产生空会话 | ✅ 只 GET 一个陌生 id 不建行 |
| 11 | 停掉 db 仍能流式输出 | ✅ 600 行 SSE 正常收完、有 `agent_end`、无 `event: error`，api 日志记下落库失败。**该结论限认证落地前**：挂上 `requireAuth` 后鉴权自己要查库，整库挂掉时请求在中间件就 500，根本流不出 SSE（`chat.test.ts` 有用例断言 500）。「仅会话/消息仓储写失败不中断对话」这条不变式仍然成立，见 CLAUDE.md 的认证一节 |

第 11 项还额外确认了一件事：`ensureSession` 本身失败时**不会**留下空会话行（下方已知问题 2
说的是 `ensureSession` 成功而 `loadHistory` 失败那条路径，两者不是一回事）。

**2026-08-10 浏览器人工验收：**

- 会话 hover 操作、active 高亮、双会话切换、刷新恢复、空新会话不入列、中断半截回答均通过。
- 设置三 tab、密码表单校验、保存期间输入禁用、加载失败与重试均通过。
- 停止按钮确认命中 `POST /api/chat/abort`；切换会话与离开 Agent 没有发 abort，后台回答完整落库，返回后可恢复。
- `prompt` / `confirm` / `alert` 的代码路径已复核，但 Codex 内置浏览器会自动关闭原生 JS dialog，
  仍需在普通 Chrome / Edge 补一次可见性确认。完整证据见
  [会话与设置前端人工验收](tech/frontend-session-settings-qa-2026-08-10.md)。
**默认模型换成 DeepSeek 官方的 `deepseek-v4-flash`（2026-08-03）**

起因是 SiliconFlow 的 `deepseek-ai/DeepSeek-V3` 被平台限流（`code 50609 / System is too busy`，
连试 6 次全 429，账号本身正常）。新增 DeepSeek 官方 provider：

- **走 Responses API**（`openai-responses.lazy`），因为 DeepSeek 官方**只提供 `/responses`**，
  没有 chat/completions。base URL `https://api.deepseek.com`，凭据取 `DEEPSEEK_API_KEY`。
- SiliconFlow provider 与 `DeepSeek-V3` 保留着做备选，`defaultModel()` 指回去即可。
- `reasoning: true` 之外还要写 `thinkingLevelMap: { off: null }`：pi 在调用方没指定 effort 时
  会主动发 `reasoning: { effort: "none" }` 把思考关掉，映射成 `null` 才会让它什么都不发、
  沿用 DeepSeek 自己的默认值。实测不加这条，落库的助手消息里就没有 `thinking` 块。
- 价格按官方定价（¥1 / ¥2 每百万 token，缓存命中 ¥0.02）折成美元，与 SiliconFlow 那条口径一致。

已实测通过：带工具调用的完整一轮（`thinking` → `toolCall` → `toolResult` → `thinking` + 回答
四条消息全部落库）、中途掐断连接只落一条 `interrupted` 的半截回答。

### 会话持久化的已知问题

> 第 0 条是 2026-08-03 端到端验收时发现的真 bug，**当天已修**（保留记录是因为踩点值得记）。
> 其余都是有意留下的。

0. **模型调用失败时，同一条助手消息会被落库两次**（验收时发现，✅ 已修）。
   触发条件：模型返回错误（实测是 SiliconFlow 的 429）。现象是每一轮在 `messages` 表里留下
   两行**逐字节相同**的助手消息（连 `timestamp` 都一样），其中第二行还被错误地标成
   `interrupted = true`。

   根因在 `services/session.ts` 的 `attachPersistence`：

   - `message_end` 只跳过 `stopReason === "aborted"` 的消息，而模型报错那条的
     `stopReason` 是 `"error"`，于是它被正常写入；
   - `agent_end` 里 `interrupted` 的判定是
     `agent.state.errorMessage !== undefined || last?.stopReason === "aborted"`，
     **把「模型报错」也算成了中断**，于是闭包里的 `partial` 又被当成半截消息补写一遍。

   这是 pi 的「模型失败不抛异常、把原因写进 `errorMessage`」这条约束（见 `CLAUDE.md`）
   在落库侧的漏网。现有测试没覆盖：`chat.test.ts` 与 `session.test.ts` 的中断用例走的是
   `abort()` 路径（`stopReason: "aborted"`），错误路径一条都没有。

   影响：transcript 里多出重复消息，回灌给模型时也是重复的；`interrupted` 标记的语义被污染。

   **修法**：不再去猜 state 的 `stopReason` / `errorMessage`，改成在 `message_end` 落库前
   先把 `partial` 清空。于是 `agent_end` 时「`partial` 还在」就等价于「这条消息发过
   `message_start` 却没等到 `message_end`」，也就是本轮真被打断了——正常完成与模型报错
   都会经过 `message_end` 那个分支被清掉。清空放在 `await` 之前，是为了让写入失败时
   `agent_end` 不再拿同一条重试。
   新增用例 `模型报错时只落一条助手消息，且不标 interrupted`（用
   `fauxAssistantMessage([], { stopReason: "error", errorMessage })` 造报错响应），
   修之前它复现出 3 条消息。**中断路径没有这个问题**——验收第 7 项与既有用例都确认只落一条。

1. ~~**中断后重发会让 transcript 的顺序错乱**~~ —— **已随 Agent 内核升级解决**（2026-08-04）。
   根因是 `seq` 反映「写入时刻」而对话的逻辑顺序是「轮次」；换成会话树之后顺序由 `parent_id`
   决定，与写入时刻无关，半截消息落库再晚也不会排到下一轮用户消息之后。
   原先钉住错误行为的那条 `【已知问题】` 用例已随 `messages` 表一并删除。
   **连带解除的风险**：Anthropic Messages API 严格要求 user / assistant 交替，原先换 provider 会
   直接 400，现在不会。原记录如下：

   `seq` 反映的是「写入时刻」，
   而对话的逻辑顺序是「轮次」。被打断的半截助手消息在 `agent_end` 才落库，那时 HTTP 响应早就关了，
   于是它必然排到**下一轮用户消息之后**，回灌给模型的序列变成 `user, user, assistant, assistant`。
   这不是「seq 改由数据库分配」带来的退化——改之前这一轮是整个丢掉的，比顺序错更糟；
   它是修好丢消息之后才浮出来的。**影响面**：SiliconFlow 走 OpenAI 兼容接口，容忍连续同角色消息，
   所以今天不炸；但 Anthropic Messages API 严格要求 user / assistant 交替，**换 provider 会直接 400**。
   `chat.test.ts` 里有一条 `【已知问题】` 用例把当前（错误的）行为钉住，谁改动半截消息的落库时机
   都会立刻变红。可行的修法是把半截消息的落库从 `agent_end` 提前到 `message_end` 里那条 aborted 消息，
   但要先在**真实模型**上确认 aborted 消息的内容确实等于 `partial`——faux provider 的行为不能直接外推。
2. **`prepareSession` 只做了半降级**。`ensureSession` 成功、`loadHistory` 失败时，会话行已经提交
   （`updatedAt` 被顶起；如果是新会话，还会带着标题被建出来），但本轮 0 条消息落库——
   左栏会出现一个排在最上面的空会话。当前有意推迟：这需要把两步包进一个事务，或者失败时回滚
   刚建出的会话行，两种都比现在这段代码复杂。
3. ~~**认证完全没做（HEU-7），而且现在就埋着一个现成的 IDOR**~~ —— **已交付**（HEU-7，见下方
   「认证与越权收口」）。原记录：四个会话路由没有任何认证，且 `rename` / `remove` /
   `loadHistory` **不按 `userId` 收窄**，只按 id 定位，认证一落地就是「换个 id 就能改删别人的会话」。
   现在这三处都按 `userId` 收窄了；**设计阶段还新发现了第四处越权**——
   `sessions.upsert`：会话 id 由前端生成，猜到别人的 id 就能顶起对方会话的 `updatedAt`、
   甚至把自己的消息写进去。修法是 `onConflictDoUpdate` 加
   `setWhere: eq(sessions.userId, input.userId)`，冲突且不属于自己时 DO UPDATE 不执行、
   `returning()` 为空，service 据此让本次请求失败。

### 认证与越权收口（HEU-7，2026-08-03 交付）

设计文档见 [superpowers/specs/2026-08-03-auth-design.md](superpowers/specs/2026-08-03-auth-design.md)。

- **零第三方认证依赖**：密码用 Node 内置 `scrypt`（`N=65536, r=8, p=1`，`maxmem` 必须显式给到
  128MB，否则抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`），JWT 用 Hono 内置 `hono/jwt`（HS256）。
- **token 存 httpOnly cookie**（`petrel_token`，`SameSite=Strict`，7 天，`secure` 只在生产开），
  前端读不到也不需要读，代价是刷新后要调一次 `/api/auth/me`。
- **`requireAuth` 每次请求查库**，不只验签：token 里的 role 是签发瞬间的快照，
  而禁用一个滥用者必须立即生效。角色与禁用状态一律以库里为准。
- **`app.ts` 的挂载顺序是安全边界**：`system` 与 `auth` 是仅有的两个公开前缀，
  之后 `app.use("/api/*", requireAuth)`，`admin` 再叠 `requireAdmin`。
  `routes/isolation.test.ts` 有用例钉住这个顺序。
- **`ADMIN_EMAILS`** 名单里的邮箱在注册与每次登录时提权为 admin，不做反向降级
  （误编辑 `.env` 不应一次性清空管理权限）。
- **登录端点的防枚举**：账号不存在也走一次哈希校验拉平耗时；「不存在」与「密码错」共用同一句
  文案；`disabled` 的判定排在密码校验之后。失败 5 次锁 15 分钟，计数在**单实例内存**里。
- 接口：`POST /api/auth/register|login|logout` · `GET /api/auth/me` ·
  `GET /api/admin/users` · `PATCH /api/admin/users/:id`（禁用/解禁，不能禁自己）。

### 认证补全：注册限流 · 邮箱验证 · 密码重置（2026-08-06 交付）

设计文档见 [superpowers/specs/2026-08-06-auth-completion-design.md](superpowers/specs/2026-08-06-auth-completion-design.md)。

- **注册限流**：按 IP 固定窗口（默认 5 次/15 分钟），在 scrypt 之前拦截；
  忘记密码/重发验证按邮箱（默认 3 次/15 分钟）。仍是单实例内存，多副本共享在风控轮做 Redis。
- **邮箱验证**：注册即发验证邮件、不再自动登录；未验证登录在校验密码之后返回 403（不构成枚举）。
  验证链接 24h 有效、可重复点击；`POST /api/auth/resend-verification` 可重发（恒 200 防枚举）。
- **密码重置**：`POST /api/auth/forgot-password`（恒 200）→ 邮件链接（30min、一次性）→
  `POST /api/auth/reset-password`；重置成功顺带标记邮箱已验证（兜住验证邮件丢失的情况）。
- **邮件通道**：nodemailer + SMTP，开发/测试默认 console 传输（邮件打到日志含链接），
  生产强制 smtp。验证/忘记/重置的浏览器页面由后端渲染最小 HTML。
- **token 只存哈希**：`users` 表新增 `email_verified_at` 与两对 token 哈希/过期列，
  migration 把存量用户回填为已验证。
- 接口：`GET /api/auth/verify-email` · `POST /api/auth/resend-verification` ·
  `GET|POST /api/auth/forgot-password` · `GET|POST /api/auth/reset-password`。

### 用户偏好与账号（2026-08-04 交付）

`user_preferences` 表一人一行（`user_id` 主键），`default_model` 与 `system_prompt`
两列可空，`null` 表示跟随系统默认。`/api/account` 挂在 `requireAuth` 之下：
`GET /preferences`（偏好 + 可用模型清单，合成一个响应因为消费者重合：设置面板要渲染
下拉、ChatView 要显示当前模型名）· `PUT /preferences`（全量语义，字段缺失与空串都
归一成 `null`）· `POST /password`。

偏好由**前端读出后随 `/api/chat` 请求体上传**，后端只校验 `model` 在 `listModels()`
白名单里，不在则 400（不静默回落——用户选的模型被悄悄换掉，账单和输出都变了却没有
任何信号）。这样 chat 每轮不多一次查询，也不用给已有的 `systemPrompt` 参数额外定
优先级规则。

模型清单由 `packages/ai` 的 `listModels()` 从 `models` 注册表派生（不另存一份硬编码
清单，否则往 provider 的 `models: [...]` 里加模型时漏改就是「模型能跑但前端选不到」），
经 `packages/agent` 转出给 server——`apps/server` 不依赖 `@petrel/ai`，守住「pi 的接线
只在 agent 与 ai」这条约束。

### Agent 内核升级：AgentHarness + Postgres 会话树（2026-08-04 交付）

设计文档见 [superpowers/specs/2026-08-04-agent-harness-session-design.md](superpowers/specs/2026-08-04-agent-harness-session-design.md)，
实施计划见 [superpowers/plans/2026-08-04-agent-harness-session.md](superpowers/plans/2026-08-04-agent-harness-session.md)。

起因是 pi 0.83 里有一整层 `AgentHarness` 我们没接，而**上下文压缩、skills、工具子集、hooks
全都挂在它上面**：压缩吃的是 `SessionTreeEntry[]` 而不是 `AgentMessage[]`，所以后续的上下文
管理、tool/skill 管理、记忆系统都必须先有这层地基。本轮只做内核替换，不新增用户可见功能。

- **`messages` 表退役，换成 `session_entries`**：一条会话是一棵 append-only 条目树，
  顺序由 `parent_id` 决定，`entry_seq` 只做游标分页。**那个 `SELECT ... FOR UPDATE` +
  `MAX(seq)+1` 的事务因此整体消失**——树模型的 `parent_id` 在插入前就已知，不需要读-改-写。
  dev 数据直接丢弃，只写了建表/删表 migration，没写数据搬运。
- **`attachPersistence` 整体删除**（约 70 行）：落库由 harness 通过 `Session` 自己完成。
  `partial` 变量、`aborted` 去重、模型报错重复落库那个修过的坑，连土壤一起没了。
- **harness 按 `sessionId` 常驻**（`services/harness-registry.ts`）：idle TTL 5 分钟、
  容量上限 200、归属校验在装配之前、会话表故障时降级成一次性内存会话。
  换来「关页面不丢回答」，代价是新增 `POST /api/chat/abort` 作为唯一的停止入口。
- **同会话并发消息进 registry 自己的队列**（HEU-37 已接管 pi 的 followUp 队列），
  settled 后由 drain 逐个重新 `prompt()`；drain/send/compact 共用 promise 链保护「判断 + 发起」
  临界区，排队条目携带各自的模型与 systemPrompt，并共享 overflow 补救压缩。
- 分层：SQL 在 `packages/database`（不认识 pi）→ pi 语义在 `packages/agent`
  （`PgSessionStorage`）→ 运行时状态在 `apps/server`（registry）。新增 `agent → database` 边。

**这一轮的审查抓出 7 个真缺陷，其中 4 个出在实施计划自己的代码里**，值得记
（最严重的那个——SSE 背压——单列在下一小节）：

1. `getLeafId()` 只读 `leaf` 类型条目是错的——pi 的 `appendEntry()` 对**任意**类型条目都会推进
   leaf 指针（`leafIdAfterEntry`），而 `Session.appendMessage()` 从不调 `setLeafId()`。
   照原样写会让 parent 链断掉、`buildContext()` 返回空。**双实现契约测试**（同一套断言同时跑
   pi 自带的 `InMemorySessionRepo` 与 pg 版）就是为抓这类问题存在的，它确实抓到了。
2. `getSessionStats()` 用的四个 usage 字段名全都不存在（真实的是 `input` / `output` /
   `cacheRead` / `cacheWrite` / `cost.total`），`?? 0` 静默吞掉，方法永远返回全零。
3. `acquire()` 首次装配有并发竞态：同一新会话被并发 acquire 会各自装配一个 harness，
   `entries.set` 只留后者，前者成为孤儿却仍在写同一份历史——正是这个设计要避免的会话分叉。
   修法是 in-flight 去重（`building` Map）。
4. registry 在 service 层抛 `HTTPException`，与 `services/auth.ts` 的 `AuthError` 分层不一致，
   改成纯错误类型由路由翻译。
5. `evict` 失败会让**已经成功**的删除/禁用报 500，客户端据此重试撞 404。两处改成 catch 记日志。
6. 前端 `abort()` 被切换会话的兜底路径共用，导致「切走就掐断上一轮」，与本轮
   「关页面不丢回答」的语义直接矛盾。拆成「真正停止」与「只断本地接收」两个函数。

#### 本轮修掉的一个可利用缺陷：SSE 背压卡死共享 harness

pi 的 `emitAny` / `emitOwn` **串行 `await` 每个订阅回调且无超时**，而路由原本在回调里
`await stream.writeSSE(...)`。hono 的 `streamSSE` 用 highWaterMark 为 1 的 `TransformStream`，
所以客户端不读流时，一两个事件之后写入就永不 resolve，直接把 agent loop 卡住。

连锁后果：`settled` 收不到 → `running` 永为 true；`send()` 不返回 → `refCount` 不释放 →
sweep 与容量淘汰都跳过它；同会话其他连接卡在 promise 链上；**`POST /api/chat/abort` 也挂住**
（它内部 `await waitForIdle()`，而 abort signal 解不开 `writer.write()` 的阻塞）。

于是任何登录用户 `curl` 一个 `/api/chat` 不读流就能冻结该会话，重复 200 次占满容量后
**所有用户的新会话一律 503**。旧架构（每请求一个 `Agent`）下同样的慢客户端只卡自己那一个 run——
是常驻 harness 把局部问题放大成了全服务 DoS，所以本轮必须修。

修法：`http/sse-queue.ts` —— 订阅回调只做同步入队，独立的 pump 循环做真正的 I/O，
有界队列（2000 条）溢出时只断开那一个连接。**教训：pi 的订阅回调里永远不能有网络 I/O。**

#### 本轮留下的已知问题

1. ~~**首轮以 `error` / `aborted` 收尾时，排队的 `followUp` 消息会丢**~~ —— **已交付**
   （HEU-37，设计见 superpowers/specs/2026-08-08-heu37-followup-loss-design.md）：
   registry 不再用 `harness.followUp()`，自己维护 `pending` 队列，`settled` 后
   `setImmediate` 调度 drain 逐个重新 `prompt()`——error / aborted 收尾同样发 settled，
   两条路径都不丢。drain 与 send/compact 共用 chain 互斥，且排队 run 同样处理 overflow
   补救压缩与请求自己的模型/systemPrompt。**abort 语义明确定义为「只停当前轮，排队消息
   照常处理」**；evict 时剩余排队条目 reject（客户端收到 event:error，不挂连接）。
2. **常驻 harness 在多副本部署下需要会话亲和**。否则同一会话的两个请求落到不同副本，
   各自持有一个实例并发写同一颗树——结果是分叉而非丢消息，但仍是缺陷。
   当前单副本，§5 的容量上限与 TTL 是硬要求；**多副本部署前必须先解决亲和性**。
3. **`session_entries` 的 `getEntries()` 在不带游标时会全量读**。前端历史展示本来就要全量，
   当前可接受；将来会话很长时要么分页要么靠压缩收敛。

#### 与「用户偏好」那一轮合并时的两处衔接

两轮并行开发，合并时有两件事值得记：

1. **migration 编号撞车**。两个分支都生成了 `0003`。处理方式是**以先合入 main 的那个为基线，
   本轮删掉自己的 0003/0004 重新 `drizzle-kit generate`**，绝不手工改 `_journal.json`
   （snapshot 链会断）。重新生成时 drizzle-kit 会因为「`messages` 消失 + `session_entries`
   出现」而弹交互提示问是不是 rename，非交互环境直接崩——**分两步生成**可以绕开：
   先只加新表（`0004_add_session_entries`），再只删旧表（`0005_drop_messages`）。
2. **偏好与常驻实例**。偏好那轮让 `/api/chat` 每轮带 `model` 与 `systemPrompt`，而本轮 harness
   是常驻的。模型在偏好确实变化且当前不在跑时调 `setModel()`；`undefined` 也表示明确恢复
   系统默认。systemPrompt 没有 setter，改由 `before_agent_start` hook 在每个新 run 注入，
   因此两种偏好都不必等实例回收才生效。

## 4. 待办

### M1 剩余
- **HEU-6 Drizzle schema 剩余的表**：会话相关的 `users` · `sessions` · `messages` 已交付（见 §3；
  表名是 `sessions` 而不是原计划的 `conversations`，`tool_calls` 决定不建）。
  `kb_*` · `eval_*` · `jobs` 与 `kb_chunks.embedding vector(1024)` + HNSW 随各自业务落地时再加
- **HEU-2 / HEU-3 决策**：认证范围**已定**——最小 JWT + 邮箱密码 + admin 名单提权，
  已随 HEU-7 交付（见 §3）。剩下的是被删除能力清单确认
- **配额与 token 计量**：当前任何登录用户都能无限调模型，成本无上限也无归属。
  这是**公开注册的前置**——在它落地之前不能开放注册，只能内部名单使用
- **认证补全（2026-08-06 已交付，见 §3 末尾「认证补全」）**：注册限流、邮箱验证、
  密码重置、邮件通道（nodemailer + SMTP / dev 用 console）。剩余两项单列：
  限流计数仍是单实例内存（多副本共享在风控轮做 Redis）、验证/重置的浏览器页面还是
  后端渲染的最小 HTML（SPA 页面待补）。
- ~~**token 版本号**：改密码不会失效其他设备上的旧 token~~ —— **已交付**：
  `users.token_version` 签发时写进 JWT payload 的 `tv`，`requireAuth` 每请求比对
  （复用既有查库，不增加查询）；改密码（`changePassword`）与重置密码
  （`resetPassword`）都自增；`POST /api/account/logout-all` 自增实现「退出所有设备」。
  migration `0008_tiny_the_order`。
- **`toHttpException` 有两份**：`routes/auth.ts` 与 `routes/account.ts` 各写了一个同名
  同作用的函数。等第三处重复出现时提取到共享位置（现在提取牵动两个既有文件，
  收益不足）。
- **`services/auth.test.ts` 的「成功登录清零计数」有 flake 风险**：它要跑 11 次
  N=65536 的 scrypt，却用 vitest 默认的 5s 超时。全量并行下复现过一次超时，单独跑
  稳定。CI 上若再现，给它单独设 `testTimeout` 而不是调全局。
- **待确认：成本与 token 数是否该暴露给客户端**。`GET /api/sessions/:id/messages` 把落库的 pi
  `AssistantMessage` 原样吐出，其中的 `usage`（含 `cost`）、`model`、`provider`、`api` 一并透传。
  不做转换是有意的（`chat.ts` 的 SSE 也是原样透传 AgentEvent，两边保持同一份形状，
  前端才能复用同一套归约逻辑），但「让终端用户看到单次请求的美元成本与所用模型」
  是否符合预期，需要产品侧确认；不符合的话就要在这一层做投影，并连带改前端归约

### M2 剩余
- **HEU-10 会话持久化剩余部分**：落库与历史读取已交付（见 §3，2026-08-04 起走会话树）。
  剩下的是 SSE 的 `persisted` 事件与前端断线重连——两者要一起做，单独加事件没有消费方。
  **地基已就位**：`SessionStorage.getEntries({ afterEntrySeq, limit })` 的游标就是为增量推送
  准备的，而且现在「连接断开 agent 继续跑完」已经成立，重连只需要补齐 `afterEntrySeq` 之后的条目
- **记忆系统（后续）**：pi 没有跨会话记忆。`custom` / `custom_message` 条目类型可以把记忆写进
  会话树，`before_agent_start` 与 `context` hook 可在每轮注入；archival 检索走 pgvector
  （compose 里已是 `pgvector/pgvector:pg17`）。业界共识是「工作记忆是上下文预算问题、
  长期记忆才是检索问题」，两者别混
- **HEU-12 agent 注册表**：从 v0.4 的「目录扫描 + metadata.toml」改为显式 TS 注册表，
  配置 schema 用 TypeBox 直接生成前端表单
- **HEU-13 工具与 MCP**：`kb_search`、`web_search`、`sql`，以及 MCP server → `AgentTool` 适配
- **HEU-8 / HEU-14 人工审批**：pi 无 LangGraph 的图级 `interrupt`，只能在工具边界暂停，
  改用 `beforeToolCall` preflight 挂起 + `POST /api/chat/:id/approve` 恢复。
  动工前先审计 v0.4 的 HITL 触发点是否都在工具边界

### 子项目 B：上下文自动压缩（已实施）

设计：[2026-08-05-auto-compaction-design.md](superpowers/specs/2026-08-05-auto-compaction-design.md) ·
计划：[2026-08-05-auto-compaction.md](superpowers/plans/2026-08-05-auto-compaction.md)

时机是 (a) pre-prompt 判阈值 + (d) 撞窗口后被动兜底。阈值 =
`min(模型 contextWindow × COMPACTION_THRESHOLD_RATIO, COMPACTION_ABSOLUTE_CAP)`，
默认 `0.8 / 120000`，即 1M 窗口的默认模型 12 万、64k（65536）的备选模型 52.4k。

与设计文档的实施差异（**代码为准，spec 未回改**）：

- **压缩标记不进 `messages`**。spec §9.2 写的是「往 `messages` 里插一条标记」，实际用
  独立的 `compactions` 数组（`{ id, atIndex, tokensBefore, tokensAfter }`）+ 渲染时按
  `atIndex` 插入。照 spec 字面做会污染 transcript 形状，破坏「`messages` 只能是 pi 的
  `AgentMessage`」这条约束。
- **`CompactionOutcome` 没有 `pureAfter`**。spec §9.1 的类型草图里有，实现里
  `tokensAfter` 本身就是纯字符估算（压缩后**只能**纯估算，理由见该字段注释），
  再留一个同值字段没有意义。ineffective 守卫用 `pureBefore` 与它比。
- **`COMPACTION_ENABLED=false` 时 (d) 兜底也不压**。计划里的条件是
  `!enabled && !force`（force 穿透总开关），实际改成总开关优先：关掉之后不再有
  摘要模型调用、也不再往会话树写 compaction 条目，撞窗口时只提示「自动压缩已关闭」。

遗留待办（来自设计文档 §12）：

- [ ] **摘要正文可展开**——spec §9.2 承诺前端 `apply()` 处理 `session_compact`、
  分隔线可展开看摘要，Task 12 未实现（现在只显示前后 token 数）。要做的话前端要
  多认一种 AgentEvent。

- [ ] **固定开销估算**——阈值估算不含 system prompt 与工具 schema（它们不在
  `buildContext().messages` 里）。当前 1 个工具误差可忽略，**必须在子项目 C
  （tool/skill 管理）落地时一起补**，否则工具一多就系统性漏判。
- [ ] **压缩可中断**——pi 的 `compact()` 内部 signal 永不 abort，现在点「停止」
  只能保证压完不再跑新一轮。要能真中断得接管 `session_before_compact` hook。
- [ ] **(d) 的确定性降级**——摘要模型限流时压缩帮不上忙。可用
  `Session.appendCompaction()` 写一条机械拼出的摘要（不需要接管 hook），
  但要连并发保护一起接。
- [ ] **mid-turn 压缩**——`harness.compact()` 要求 `phase === "idle"`，
  单轮内 tool result 顶爆窗口时只能落到 (d)。
- [ ] **`keepRecentTokens` 可配**——现在沿用 pi 硬编码的 20000。
  升级触发条件：埋点显示 64k 模型上连续两次压缩各回收不足 10%。

### M3 知识库
MinerU 客户端与解析兜底（HEU-15）· jobs 队列（HEU-16）· markdown 结构感知分块（HEU-17）·
embedding/rerank 客户端（HEU-18）· pgvector 检索与维度约束（HEU-19）· 检索质量对比（HEU-20）·
KB 与文档管理 API（HEU-21）

### M5 / M6
Dashboard SQL 聚合（HEU-28）· 评测 runner（HEU-29）· 数据迁移（HEU-30）·
知识库重建索引（HEU-31）· 类型契约 CI（HEU-32）· 生产部署与文档（HEU-33）

## 5. 关键实现约束

### pi 的事件契约（已核对 `types.d.ts`，勿凭文档记忆）
- `message_update` **带完整的部分 `message`**，直接覆盖即可，不需要自己拼 delta
- `tool_execution_end` 的 **`isError` 在事件顶层**，不在 `result` 里
- **模型调用失败时 pi 不抛异常、也不发 error 事件**，而是把原因写进 assistant 消息的
  `errorMessage`（`stopReason: "error"`）。任何消费方都必须处理这种「成功流式但内容为空」的情况
- `text_start` / `toolcall_delta` 等是 pi-ai 层的 `assistantMessageEvent` 子类型，嵌在
  `message_update` 里，不是顶层 `AgentEvent`
- **订阅回调被串行 `await`、且没有超时**，所以回调里绝不能做网络 I/O（`writeSSE` 遇上
  不读流的客户端会因背压永不 resolve，卡住整个 harness）。见 CLAUDE.md 硬约束 5
- **压缩相关的四条**（`compact()` 要求 idle + 硬编码 settings、`phase` 私有、
  compaction 期 `followUp()` 不抛却静默丢消息、`getSessionStats()` 不能当阈值信号）
  见 CLAUDE.md 硬约束 7/8 与「踩过的坑」17/18

### 凭据解析
模型 API key 由 pi-ai 的 auth 机制从 `SILICONFLOW_API_KEY` 解析，这是「`@petrel/config` 是唯一
读 env 的位置」这条约定的**唯一例外**：凭据解析要兼顾凭据存储与 OAuth，绕过 pi 反而更易错。

### pgvector 维度是硬约束
向量列维度固定。每个知识库在创建时绑定 embedding 模型并记录 `dim`，统一列宽 `vector(1024)`；
**换 embedding 模型 = 全量重新索引**，这一点必须在 KB 创建界面上显式暴露。

## 6. 踩过的坑

> 都是实际卡过工时的问题，改动相关配置前先看这一节。

1. **改 `.env` 后必须 `docker compose up -d`，不能用 `restart`**。容器的环境变量在创建时固定，
   `restart` 只重启进程、不重新加载 `env_file`。容易与「源码有热重载」的印象混淆：
   **源码热重载，环境变量不热重载**。
2. **新增 package 要同步改三处**：Dockerfile 的 deps 层 `COPY`、production 层 dist `COPY`、
   compose 的 src 挂载。漏改会让容器启动即崩（`Cannot find package '@petrel/xxx'`），
   而宿主机 `pnpm dev` 一切正常，所以只在宿主机验证会漏掉。
3. **compose 逐个挂 `src` 而不是整个 `packages` 是有意为之**。挂目录会覆盖容器内 pnpm 的
   符号链接。同理，仓库必须有 `.dockerignore` 排除 `node_modules`，否则 `COPY . .` 会把宿主机
   （Windows 路径）的符号链接复制进镜像并断链。
4. **容器内热重载必须用轮询**。Windows 的 Docker bind mount 不传递 inotify 事件，
   `tsx watch` 在容器里完全不触发（连容器内 `touch` 都不触发），且它没有轮询选项，
   因此 `dev` 脚本用 `nodemon --legacy-watch`。
5. **仓库统一 LF**。Windows 检出为 CRLF 会与 Biome 的 LF 输出冲突，导致 lint 全量报错。
   已用 `.gitattributes` + `core.autocrlf false` 根治。
6. **`pnpm-workspace.yaml` 必须提交且必须 COPY 进镜像**。pnpm 11 把 supply-chain 策略
   （`minimumReleaseAgeExclude`）和构建脚本授权（`allowBuilds`）写在这里，缺了它
   镜像内 `pnpm install --frozen-lockfile` 会被策略拒绝。
7. **API key 里混入非 ASCII 字符时，pi 报的是 `Cannot convert argument to a ByteString`**，
   不指向根因。v0.4 的 `.env` 里 `SILICONFLOW_API_KEY=` 是空值后跟中文注释，用 `cut -d=`
   取值会把注释当成 key。

## 7. 风险

1. **pi 生态成熟度**：包名近期迁移过，`pi-server` 标注 experimental。→ 锁死精确版本、
   只依赖 `pi-ai` 与 `pi-agent-core`、把 pi 的接线收在 `agent` 一层内。
   **新增一条具体风险**：本轮依赖了一批从 dist 源码核出来、官方文档没写或写错的行为。
   **升级 pi 版本时必须重新核对下面每一条**，它们出错的方式都是静默的（上下文为空、
   统计全零、harness 卡死、消息消失、白花模型调用）：
   1. `appendEntry` 推进 leaf 指针
   2. `Usage` 的字段名
   3. `emitAny` / `emitOwn` 串行 await 订阅回调，且无超时
   4. `compact()` 硬编码 `DEFAULT_COMPACTION_SETTINGS`、`phase` 是私有字段无 getter
   5. compaction 期间 `prompt()` 抛 `busy` 而 `followUp()` **不抛**（消息静默丢失）
   6. `keepRecentTokens` 硬编码 20000，且小会话时 `prepareCompaction` 不返回
      `undefined`——照样发一次摘要请求、写一条 compaction 条目
   7. `getSessionStats()` 是全会话累计，压缩后继续涨，**不能当上下文阈值信号**
   8. `estimateContextTokens()` 跳过 `stopReason === "error"` 的 assistant，
      于是压缩后它采信的是 retainedTail 里那条压缩前的旧 usage
   9. `isNothingToCompact()` 靠 `error.message === "Nothing to compact"` 精确匹配
      （pi 的 code `"compaction"` 同时覆盖真正的摘要失败，分不开）
2. **HITL 语义降级**：LangGraph 的 `interrupt` 是图级中断，pi 只能在工具边界暂停。
   → HEU-8 先审计触发点，存在无法映射的场景就升级为阻塞项。
3. **pgvector 的规模上限**：百万级 chunk 以上不如 Milvus。→ 当前单机场景足够，
   `retrieve.ts` 保持检索接口抽象以便将来替换。
4. **中文全文检索缺失**：第一阶段只做向量检索，HEU-20 人工对比 20 条；不达标则加
   `zhparser` 做混合检索（工期 +3~5 天）。
5. **MinerU 成为单点**：解析器唯一化后它不可用即无法入库。→ 纯文本/markdown/docx
   走轻量本地兜底，不引入第二个 OCR 服务。
6. **两仓库类型契约漂移**：HEU-32 用 `tsc --emitDeclarationOnly` 产出 `.d.ts` 供前端消费，
   契约变更必须同 PR 更新两侧。
7. **重构期间 v0.4 无法双跑**：数据模型与向量库都换了。v0.4 打 tag 冻结、只接 bugfix，
   M6 一次性切换。
8. **常驻 harness 的进程内状态**（2026-08-04 新增）：容量上限与 idle TTL 是硬要求——
   `refCount > 0` 或正在跑的实例不会被回收，所以任何「让实例卡住」的缺陷都会累积成容量耗尽
   （SSE 背压那个缺陷就是这么从「卡一个连接」变成「全服务 503」的）。
   → 容量到顶时明确返回 503 而不是无声增长；**多副本部署前必须解决会话亲和性**，
   否则同一会话的两个副本会并发写同一颗树。

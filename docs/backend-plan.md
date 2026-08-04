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

**仍未验证：**

- **浏览器 UI 观感**——hover 才出现的重命名/删除图标、`prompt` / `confirm` / `alert`
  三个原生弹窗、active 高亮、切换会话的手感。上面 11 项验的是后端契约与数据落地，
  前端把这些数据渲染成什么样，仍然**没有人在浏览器里看过**。
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

1. **中断后重发会让 transcript 的顺序错乱**——本轮最需要注意的一条。`seq` 反映的是「写入时刻」，
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

## 4. 待办

### M1 剩余
- **HEU-6 Drizzle schema 剩余的表**：会话相关的 `users` · `sessions` · `messages` 已交付（见 §3；
  表名是 `sessions` 而不是原计划的 `conversations`，`tool_calls` 决定不建）。
  `kb_*` · `eval_*` · `jobs` 与 `kb_chunks.embedding vector(1024)` + HNSW 随各自业务落地时再加
- **HEU-2 / HEU-3 决策**：认证范围**已定**——最小 JWT + 邮箱密码 + admin 名单提权，
  已随 HEU-7 交付（见 §3）。剩下的是被删除能力清单确认
- **配额与 token 计量**：当前任何登录用户都能无限调模型，成本无上限也无归属。
  这是**公开注册的前置**——在它落地之前不能开放注册，只能内部名单使用
- **token 版本号**：改密码不会失效其他设备上的旧 token。给 `users` 加 `tokenVersion`，
  签发时写进 payload、`requireAuth` 比对，改密码时自增。同一个机制也能实现
  「登出所有设备」。
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
- **HEU-10 会话持久化剩余部分**：落库与历史回灌已交付（见 §3），前端会话列表因此解锁。
  剩下的是 SSE 的 `persisted` 事件与前端断线重连——两者要一起做，单独加事件没有消费方
- **HEU-12 agent 注册表**：从 v0.4 的「目录扫描 + metadata.toml」改为显式 TS 注册表，
  配置 schema 用 TypeBox 直接生成前端表单
- **HEU-13 工具与 MCP**：`kb_search`、`web_search`、`sql`，以及 MCP server → `AgentTool` 适配
- **HEU-8 / HEU-14 人工审批**：pi 无 LangGraph 的图级 `interrupt`，只能在工具边界暂停，
  改用 `beforeToolCall` preflight 挂起 + `POST /api/chat/:id/approve` 恢复。
  动工前先审计 v0.4 的 HITL 触发点是否都在工具边界

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

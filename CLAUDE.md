# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

宿主机可以跑安装、构建与检查，但**不要在宿主机起前端 dev server**，运行统一走 compose。

```bash
cp .env.template .env    # 对话功能需要 SILICONFLOW_API_KEY
docker compose up -d     # 前端 :5173/agent，后端 :5050/api/system/health
docker logs petrel-api-dev --tail 100
docker logs petrel-web-dev --tail 100

pnpm install
pnpm run build           # 后端 tsc + 前端 vite build
pnpm run typecheck       # 各包 tsc -p tsconfig.check.json
pnpm run lint            # Biome；配置里排除了 apps/web
pnpm run format          # biome check --write
pnpm run test            # vitest run
pnpm run dev             # 仅后端，宿主机调试用（nodemon --legacy-watch + tsx）
```

单个测试：`pnpm vitest run packages/agent/src/harness.test.ts`，
单个用例加 `-t "工具循环"`。在**主仓库根**跑全量测试要加 `--exclude '**/.claude/**'`（见「踩过的坑」16）。

`apps/web` 的 `pnpm run lint` 目前不可用（v0.4 遗留：eslint 9 只认 `eslint.config.js`，
仓库里是旧格式 `.eslintrc.cjs`），前端没有 typecheck。

## 架构

TypeScript ESM monorepo（Node 24 + pnpm workspace），agent 内核用
[pi](https://github.com/earendil-works/pi)。

- `apps/server`（`@petrel/server`）— Hono HTTP 应用。`src/http/app.ts` 挂载路由，
  当前有 `system`（health）、`auth`（注册/登录/登出/me）、`chat`（SSE）、
  `sessions`（会话 CRUD）、`account`（用户偏好与改密码）与 `admin`（用户管理）。
  **`app.ts` 的挂载顺序有安全含义**：`system` 与 `auth` 是仅有的两个公开前缀，
  `app.use("/api/*", requireAuth)` 之下的路由自动受保护（`admin` 再叠一层 `requireAdmin`）。
- `apps/web`（`@petrel/web`）— Vue 3 + Vite + Ant Design Vue + pinia，JS（尚未 TS 化）。
- `packages/agent` — `createHarness()` 装配 pi `AgentHarness`，内置工具在 `src/tools/`。
  `src/session/pg-storage.ts` 是 pi `SessionStorage` 的 Postgres 实现——**全仓唯一懂
  「pi 的 11 种会话树条目类型怎么拆进 `type` + `payload` 两列」的地方**。
  `createPgSession()` 给生产用，`createMemorySession()` 给降级与测试用。
- `packages/ai` — 模型 provider 注册。DeepSeek 官方与 SiliconFlow 都不在 pi 内置 provider 里，
  用 `createProvider` 自行注册。默认模型是 DeepSeek 官方的 `deepseek-v4-flash`，走
  **Responses API**（`openai-responses.lazy`，DeepSeek 官方不提供 chat/completions）；
  SiliconFlow 的 `deepseek-ai/DeepSeek-V3` 走 `openai-completions.lazy`，留作限流时的备选。
- `packages/database` — Drizzle schema 与 repository。`sessions` / `session_entries`。
  **一条会话是一棵 append-only 的条目树**：顺序由 `parent_id` 链决定，`entry_seq`（bigserial）
  只用于 `getEntries({ afterEntrySeq })` 的游标分页，不参与语义定序。条目有 11 种类型
  （`message` 只是其一，还有 `compaction` / `model_change` / `active_tools_change` / `leaf` …），
  除 `id` / `parent_id` / `timestamp` / `type` 之外的字段整份存 `payload` jsonb。
  **这一层不 import 任何 pi 类型**（`payload` 是 `unknown`），翻译在 `packages/agent`。
  测试用 PGlite 内存 Postgres，不需要 Docker。
  `user_preferences` 一人一行（`user_id` 作主键），`default_model` 与 `system_prompt`
  两列可空，`null` 表示跟随系统默认——不是空字符串，route 层会把空串归一成 `null`。
- `packages/config` — **全仓唯一读取 `process.env` 的位置**，导出校验后的 `env`。
- `packages/logger` — pino logger 与 Hono 的 `requestLogger` 中间件。

依赖方向固定为 `apps → packages`，package 之间只能指向更底层的 package：
`server → agent → { ai, database }`、`server → database → config`、`server → logger → config`。
（`agent → database` 这条边是为了让 `PgSessionStorage` 能落到 Postgres，无环。）

**pi 的接线只允许出现在 `agent` 与 `ai` 两个 package**，上层只依赖 `createHarness()`
与 harness 的事件流，便于将来替换内核。需要 pi 的类型时从 `@petrel/agent` 转导出拿，
不要在上层直接 import `@earendil-works/*`。
**既有例外（待收口）**：`apps/server` 的测试为了用 `fauxProvider` 直接依赖了
`@earendil-works/pi-ai`（devDependency），这是本轮之前就有的破口。

后续 package（`knowledge` · 共享 `contracts` 等）在对应业务首次落地时创建，
不提前维护空 package。

### 对话链路

`POST /api/chat`，请求体 `{ message, sessionId, systemPrompt? }`，响应 SSE：

```
event: agent   data: <pi 的 AgentEvent JSON，原样透传>
event: error   data: { message }
```

前端 `apis/chat_api.js` 用 `fetch` + `ReadableStream` 读流（需要 POST，不能用 `EventSource`），
`composables/useAgentStream.js` 把 AgentEvent 归约为 `messages`（直接沿用 pi 的 `AgentMessage`，
不自定义中间格式）与 `toolCalls`，是对话界面的唯一状态来源；`components/chat/*` 只做纯渲染。

`sessionId` 由**前端生成**（`crypto.randomUUID()`）、后端 upsert，所以 SSE 不需要回传新会话 id。
会话 CRUD 在 `/api/sessions`：`GET /` 列表 · `GET /:id/messages` 历史 · `PATCH /:id` 重命名 ·
`DELETE /:id` 删除。

**harness 按 `sessionId` 常驻**（`services/harness-registry.ts`，进程内 Map + idle TTL 5 分钟 +
容量上限 200，到顶且无空闲可淘汰则 503）。由此确立三条语义：

1. **落库由 harness 自己完成**，路由不订阅事件写库（`attachPersistence` 那套已删除）。
2. **连接断开不等于停止**：关页面/切走，agent 继续跑完并落库，用户回来能看到完整回答。
   用户要真停下来走 **`POST /api/chat/abort`**（前端「停止」按钮调它；切换会话只断本地接收，
   不调它）。
3. **同一会话的第二个请求进 `followUp` 队列**，当轮结束后自动接上；registry 用一条 promise 链
   保护「判断是否在跑 + 发起调用」这段临界区，**但绝不能把「等整轮跑完」也串进去**——
   那样第二个请求会排到第一轮结束之后才发起，`followUp` 分支永远走不到。

**归属校验在 `registry.acquire()` 的 `upsert`**，且必须在装配 harness 之前：缓存 key 只有
`sessionId`，越权请求一旦走到装配就能拿到别人的活实例。注意区分 `upsert` 返回 `false`（越权 →
403）与 `upsert` **抛错**（故障 → 降级成一次性内存会话，本轮照常对话但不落库）——
两者共用一个返回值就等于把归属校验绕过去了。

**开流后写 `session_entries` 失败则整轮失败**（发 `event: error`），不吞：harness 的后续上下文
正是从这颗树读的，缺条目等于下一轮拿到有洞的历史。
注意**整个数据库不可用**是另一个结果：`requireAuth` 要查库确认用户，整库挂掉时这一步先失败
（`resolveUser` 的 try/catch 只包 `verify()`，`findById()` 的错误直接冒泡到 `onError` → **500**），
请求根本进不到 handler。401 只对应「没 cookie / 验签失败或过期 / 用户不存在或已禁用」。

`GET /:id/messages` 用 `entryRepo.listAll()` 过滤 `message` 条目投影出完整 transcript，
**不能用 `session.buildContext()`**——后者会应用 compaction 变换，压缩发生后用户刷新会看到
历史凭空消失。`buildContext()` 只用于喂模型（那里正需要压缩后的版本）。

### 认证

邮箱密码登录，JWT 存 httpOnly cookie（`petrel_token`，`SameSite=Strict`，7 天，
`secure` 仅在生产开启）。密码用 Node 内置 `scrypt`，JWT 用 Hono 内置 `hono/jwt`——
**零第三方认证依赖**。

`requireAuth` 每次请求都查一次库确认用户存在且未禁用，不只验签：
token 里的 role 只是签发那一刻的快照，而 admin 禁用滥用者必须立即生效。
角色与禁用状态一律以库里为准。

`ADMIN_EMAILS` 名单里的邮箱在注册与每次登录时自动提升为 admin，不做反向降级。

**尚未实现（公开部署前必须先做）**：配额与 token 计量、注册限流、邮箱验证、密码重置。
登录失败限流（同一邮箱 5 次失败锁 15 分钟）是单实例内存的，进程重启即失效、多副本部署下无效。

改密码是 `POST /api/account/password`（挂在 `requireAuth` 之下，不在公开的 `/api/auth`
前缀里——改凭据的端点靠 handler 手写校验，哪天漏了就等于认证绕过）。它**不失效其他
设备上的旧 token**：JWT 无状态、7 天有效，只重新签发当前会话的 cookie。彻底解决要给
`users` 加 `tokenVersion` 并让 `requireAuth` 比对。另外旧密码校验与登录**共用同一个
失败计数器**，所以改密码连错 5 次也会连带锁住登录 15 分钟——有意的取舍，人已经在
登录态里，锁住的只是重新登录。

### 消费 pi AgentEvent 的硬约束（已核对 pi 的 `types.d.ts`，勿凭文档记忆）

1. `message_update` / `message_end` 带完整的（部分）`message`，直接覆盖，不要自己拼 delta。
2. `tool_execution_end` 的 `isError` 在**事件顶层**，不在 `result` 里。
3. **模型调用失败时 pi 不抛异常也不发 error 事件**，而是把原因写进 assistant 消息的
   `errorMessage`（`stopReason: "error"`）。只处理 `event: error` 会显示一条空白助手消息。
4. `text_start` / `toolcall_delta` 是 pi-ai 层 `assistantMessageEvent` 的子类型，嵌在
   `message_update` 里，不是顶层 `AgentEvent`。
5. **`emitAny` / `emitOwn` 串行 `await` 每个订阅回调，且没有超时**
   （`agent-harness.js`）。所以**订阅回调里绝不能做网络 I/O**——`await stream.writeSSE(...)`
   在客户端不读流时会因背压永不 resolve，直接卡住整个 harness。`routes/chat.ts` 因此把回调
   改成同步入队（`http/sse-queue.ts`），真正的写出交给独立的 pump 循环，队列溢出只断开
   那一个连接。这条是本轮最贵的教训，见「踩过的坑」第 14 条。
6. **`AgentHarness` 没有 `setSystemPrompt()`**（只有 `setModel` / `setTools` / `setResources` /
   `setThinkingLevel` / `setStreamOptions`）。systemPrompt 只在装配时生效，常驻实例被复用时
   请求里新传的会被静默忽略（`chat.test.ts` 有用例钉住）。要每轮改系统提示，正确挂点是
   `before_agent_start` hook 的 `BeforeAgentStartResult.systemPrompt`，不是重建实例。
7. **`harness.compact()` 只能手动调用、硬编码 `DEFAULT_COMPACTION_SETTINGS`、且要求
   `phase === "idle"`**。文档里说的「超阈值自动触发」与 `settings.json` 都是 pi CLI 层的实现，
   harness 里没有。另外 **`phase` 是私有字段没有 getter**，要判断是否在跑只能自己订阅
   `agent_start` / `settled` 维护标记（`harness-registry.ts` 就是这么做的）。

模型 API key 由 pi-ai 的 auth 机制从 `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` 解析，这是
「`@petrel/config` 是唯一读 env 的位置」的**唯一例外**。

### 测试

`agent` 用 pi 自带的 `fauxProvider` 跑真实 agent loop，不需要模型凭据也不 mock 内部。
新增 agent 行为优先按这个模式写测试。vitest 在仓库根统一配置，`@petrel/*` 别名直接指向
`src/index.ts`（`vitest.config.ts` 与 `tsconfig.base.json` 各有一份，新增 package 要同步加）。

## 踩过的坑（改相关配置前先看）

1. **改 `.env` 后必须 `docker compose up -d`，不能 `restart`**。源码热重载，环境变量不热重载。
   前端一直收到 `Provider is not configured` 先查这个。
2. **新增 package 要同步改三处**：`apps/server/Dockerfile` 无需改（用 `pnpm fetch`），但要改
   compose 的 src 挂载、`tsconfig.base.json` 的 paths、`vitest.config.ts` 的 alias。
   漏改会让容器启动即崩（`Cannot find package '@petrel/xxx'`），而宿主机 `pnpm dev` 一切正常。
3. **compose 逐个挂 `src` 而不是整个 `packages`**：挂目录会覆盖容器内 pnpm 的符号链接。
   同理 `.dockerignore` 必须排除 `node_modules`。
4. **容器内热重载必须轮询**。Windows 的 bind mount 不传递 inotify，`tsx watch` 完全不触发，
   所以后端用 `nodemon --legacy-watch`，前端 vite `usePolling: true`。
5. **仓库统一 LF**（`.gitattributes` + `core.autocrlf false`），CRLF 会与 Biome 冲突。
6. **`pnpm-workspace.yaml` 必须提交且 COPY 进镜像**：pnpm 11 的 `minimumReleaseAgeExclude`
   与 `allowBuilds` 写在这里，缺了镜像内 `pnpm install --frozen-lockfile` 会被策略拒绝。
7. **nginx 反代必须 `proxy_buffering off`**：`/api/chat` 是 SSE，不关缓冲会攒住输出。
8. **API key 混入非 ASCII 时 pi 报 `Cannot convert argument to a ByteString`**，不指向根因。
9. **`reasoning: true` 的模型，pi 会在调用方没指定 effort 时主动发
   `reasoning: { effort: "none" }` 把思考关掉**（`openai-responses.js` 的 else 分支）。
   想沿用 provider 自己的默认值，要把 `thinkingLevelMap.off` 设成 `null`，
   见 `packages/ai/src/index.ts` 里 `deepseek-v4-flash` 的注释。
10. **cookie 的 `secure` 必须按环境开关**。本地 `http://localhost` 下设 `secure: true`，
    浏览器会静默丢弃 cookie，表现为「登录接口返回 200 但下一个请求仍是未登录」。
11. **Node 的 `scrypt` 默认 `maxmem` 是 32MB**，而 N=65536、r=8 需要 64MB，
    不显式调高会抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`，报错不指向根因。
12. **compose 只挂 `src`，不挂 `packages/database/drizzle`，新增 migration 在容器里永不生效**。
    `runMigrations()` 读的是 `packages/database/drizzle`，只挂 `src` 的话容器里用的是构建时
    烘进镜像的旧副本，新加的 `.sql` 从来不会被应用——而启动日志照样打印
    `database migrations applied`，排查时极具误导性（表现为接口 500：
    `relation "xxx" does not exist`）。已在 `docker-compose.yml` 给 api 补上这个挂载。
    **改完 schema 生成 migration 后要 `docker compose up -d`**，让容器重启跑一遍迁移。
13. **`drizzle-kit migrate` 不读 `DATABASE_URL`**，它连的是 `packages/database/drizzle.config.ts`
    里 `dbCredentials.url` 那个**硬编码**的连接串。那句「generate 不需要连数据库，占位值即可」
    的注释只对 `generate` 成立——对 `migrate` 它是实际目标库。所以
    `DATABASE_URL=…/别的库 drizzle-kit migrate` 会静默迁错库（本轮就这么把 dev 库的
    `messages` 表删了）。要对指定库跑迁移，用走 `@petrel/config` 的那条路径：
    `DATABASE_URL=… tsx apps/server/src/index.ts`。
14. **常驻 harness 的实例必须在会话删除与用户禁用时 `evict`**，但 **evict 失败不能让主操作
    报错**：`DELETE /:id` 与 admin 禁用都是「先落库、再清理」，清理抛错时库里已经改完了，
    冒泡成 500 会让客户端以为主操作失败（删除后重试撞 404、禁用后重复操作）。两处都 catch
    住记日志。
15. **pi 的订阅回调是被串行 `await` 的，回调里做网络 I/O 会卡死整个 harness**。
    常驻实例把这个问题从「卡自己一个请求」放大成「卡整个会话」：一个不读流的客户端会让
    该会话的其他连接、甚至 `POST /api/chat/abort` 一起挂住（abort 内部 `await waitForIdle()`），
    且 `running` / `refCount` 都不复位，实例既不被 sweep 回收也不被容量淘汰。
    修法见 `http/sse-queue.ts`：同步入队 + 独立 pump + 有界队列溢出即断开该连接。
16. **在主仓库根跑测试时 `vitest` 会把 `.claude/worktrees/` 里的副本一起跑掉**，报一批与当前
    代码无关的失败。加 `--exclude '**/.claude/**'`。在 worktree 里面跑不受影响
    （那里没有嵌套的 `.claude/worktrees/`）。

## 重构现状

本仓库由 `agent-server` 与 `agent-web` 合并而来，正处于 v0.4（Python + FastAPI + LangGraph）
→ v0.5（TypeScript + Hono + pi）的重构中。前端采取「先原样迁入基线再逐步改造」，
因此**大量组件调用的是已不存在的 v0.4 Python API**（知识库、图谱、Dashboard 都会失败；
登录已在 HEU-7 重做，走 v0.5 的 `/api/auth`），
另有约 8000 行待删的旧对话代码与知识图谱/思维导图组件。

计划、待办与组件处置清单在 [docs/backend-plan.md](docs/backend-plan.md) 与
[docs/frontend-plan.md](docs/frontend-plan.md)，动工前先看对应章节；任务跟踪在 Linear 的
**HEU-OpenWings / Agent base 重构升级** 项目（文档里的 `HEU-x`）。

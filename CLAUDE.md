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

单个测试：`pnpm vitest run packages/agent-core/src/agent.test.ts`，
单个用例加 `-t "runs the tool loop"`。

`apps/web` 的 `pnpm run lint` 目前不可用（v0.4 遗留：eslint 9 只认 `eslint.config.js`，
仓库里是旧格式 `.eslintrc.cjs`），前端没有 typecheck。

## 架构

TypeScript ESM monorepo（Node 24 + pnpm workspace），agent 内核用
[pi](https://github.com/earendil-works/pi)。

- `apps/api`（`@petrel/api`）— Hono HTTP 应用。`src/http/app.ts` 挂载路由，
  当前有 `system`（health）、`auth`（注册/登录/登出/me）、`chat`（SSE）、
  `sessions`（会话 CRUD）与 `admin`（用户管理）。
  **`app.ts` 的挂载顺序有安全含义**：`system` 与 `auth` 是仅有的两个公开前缀，
  `app.use("/api/*", requireAuth)` 之下的路由自动受保护（`admin` 再叠一层 `requireAdmin`）。
- `apps/web`（`@petrel/web`）— Vue 3 + Vite + Ant Design Vue + pinia，JS（尚未 TS 化）。
- `packages/agent-core` — `createAgent()` 装配 pi `Agent`，内置工具在 `src/tools/`。
- `packages/ai` — 模型 provider 注册。DeepSeek 官方与 SiliconFlow 都不在 pi 内置 provider 里，
  用 `createProvider` 自行注册。默认模型是 DeepSeek 官方的 `deepseek-v4-flash`，走
  **Responses API**（`openai-responses.lazy`，DeepSeek 官方不提供 chat/completions）；
  SiliconFlow 的 `deepseek-ai/DeepSeek-V3` 走 `openai-completions.lazy`，留作限流时的备选。
- `packages/database` — Drizzle schema 与 repository。`sessions` / `messages` 存 pi 的
  `AgentMessage` JSONB，消息用整数 `seq` 排序（同一轮的多条消息时间戳可能相同），
  `seq` 由数据库在插入时分配（`SELECT ... FOR UPDATE` + `MAX(seq)+1`），不由调用方传。
  测试用 PGlite 内存 Postgres，不需要 Docker。
- `packages/config` — **全仓唯一读取 `process.env` 的位置**，导出校验后的 `env`。
- `packages/logger` — pino logger 与 Hono 的 `requestLogger` 中间件。

依赖方向固定为 `apps → packages`，package 之间只能指向更底层的 package：
`api → agent-core → ai → config`、`api → database → config`、`api → logger → config`。

**pi 的接线只允许出现在 `agent-core` 与 `ai` 两个 package**，上层只依赖 `createAgent()`
与 Agent 的事件流，便于将来替换内核。

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
`DELETE /:id` 删除。消息按 `message_end` 增量落库，中断的半截回答在 `agent_end` 时补写并标
`interrupted`。**落库失败不中断对话**——会话/消息仓储写失败时 SSE 照常输出，只在日志里报错
（`chat.test.ts` 有用例守着）。注意挂上认证后**整个数据库不可用**不再是这个结果：
`requireAuth` 要查库确认用户，整库挂掉时这一步先失败（`resolveUser` 的 try/catch 只包 `verify()`，
`findById()` 的错误直接冒泡到 `onError` → **500**），请求根本进不到 handler。
401 只对应「没 cookie / 验签失败或过期 / 用户不存在或已禁用」。

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

### 消费 pi AgentEvent 的硬约束（已核对 pi 的 `types.d.ts`，勿凭文档记忆）

1. `message_update` / `message_end` 带完整的（部分）`message`，直接覆盖，不要自己拼 delta。
2. `tool_execution_end` 的 `isError` 在**事件顶层**，不在 `result` 里。
3. **模型调用失败时 pi 不抛异常也不发 error 事件**，而是把原因写进 assistant 消息的
   `errorMessage`（`stopReason: "error"`）。只处理 `event: error` 会显示一条空白助手消息。
4. `text_start` / `toolcall_delta` 是 pi-ai 层 `assistantMessageEvent` 的子类型，嵌在
   `message_update` 里，不是顶层 `AgentEvent`。

5. **模型报错那条消息同样走 `message_end`**（`stopReason: "error"`），只是没有 `message_end`
   之外的信号。落库/去重逻辑若只把 `"aborted"` 当特例，就会把报错那条当成「没写完的半截」
   重复处理一遍——`services/session.ts` 踩过这个。

模型 API key 由 pi-ai 的 auth 机制从 `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` 解析，这是
「`@petrel/config` 是唯一读 env 的位置」的**唯一例外**。

### 测试

`agent-core` 用 pi 自带的 `fauxProvider` 跑真实 agent loop，不需要模型凭据也不 mock 内部。
新增 agent 行为优先按这个模式写测试。vitest 在仓库根统一配置，`@petrel/*` 别名直接指向
`src/index.ts`（`vitest.config.ts` 与 `tsconfig.base.json` 各有一份，新增 package 要同步加）。

## 踩过的坑（改相关配置前先看）

1. **改 `.env` 后必须 `docker compose up -d`，不能 `restart`**。源码热重载，环境变量不热重载。
   前端一直收到 `Provider is not configured` 先查这个。
2. **新增 package 要同步改三处**：`apps/api/Dockerfile` 无需改（用 `pnpm fetch`），但要改
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

## 重构现状

本仓库由 `agent-server` 与 `agent-web` 合并而来，正处于 v0.4（Python + FastAPI + LangGraph）
→ v0.5（TypeScript + Hono + pi）的重构中。前端采取「先原样迁入基线再逐步改造」，
因此**大量组件调用的是已不存在的 v0.4 Python API**（知识库、图谱、Dashboard 都会失败；
登录已在 HEU-7 重做，走 v0.5 的 `/api/auth`），
另有约 8000 行待删的旧对话代码与知识图谱/思维导图组件。

计划、待办与组件处置清单在 [docs/backend-plan.md](docs/backend-plan.md) 与
[docs/frontend-plan.md](docs/frontend-plan.md)，动工前先看对应章节；任务跟踪在 Linear 的
**HEU-OpenWings / Agent base 重构升级** 项目（文档里的 `HEU-x`）。

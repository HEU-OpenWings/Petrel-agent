# 架构说明

Petrel Agent 是一个自托管的 AI Agent 对话系统：Web 前端 + HTTP 服务 + Postgres，
agent 内核用 [pi](https://github.com/earendil-works/pi)。

当前版本 `0.5.0-dev`，正处于 v0.4（Python + FastAPI + LangGraph）→ v0.5（TypeScript +
Hono + pi）的重构中。**前端有大量 v0.4 遗留代码**（知识库、图谱、Dashboard 调用的是
已不存在的 Python 接口），处置清单见 [docs/frontend-plan.md](../frontend-plan.md)。
本文描述 v0.5 已落地的部分。

---

## 1. 部署拓扑

三个 compose 服务（`docker-compose.yml`）：

```
浏览器 ──▶ web (nginx, :5173/agent) ──▶ api (Node 24, :5050/api/*) ──▶ db (pgvector/pgvector:pg17)
                                                     │
                                                     └──▶ 模型 provider（DeepSeek 官方 / SiliconFlow）
```

- `web` 是 nginx，既发静态资源也反代 `/api/*` 到 api 容器。
  **必须 `proxy_buffering off`**——`/api/chat` 是 SSE，开缓冲会攒住输出。
- `api` 是单进程 Node，**有进程内状态**（常驻 harness、登录失败计数器），
  所以当前只支持单副本，见 §9。
- `db` 用 pgvector 镜像是为将来的知识库预留，v0.5 目前只用到普通表。
- 开发态源码热重载：后端 `nodemon --legacy-watch`、前端 vite `usePolling: true`。
  Windows 的 bind mount 不传递 inotify，**必须轮询**。

运行方式统一走 compose（宿主机可以跑安装、构建、检查，但不要在宿主机起前端 dev server）。
`.env` 改动**必须 `docker compose up -d`**，`restart` 不重新读环境变量。

---

## 2. 代码结构与依赖方向

TypeScript ESM monorepo，Node 24 + pnpm workspace。

```
apps/
  server/   @petrel/server   Hono HTTP 应用
  web/      @petrel/web      Vue 3 + Vite + Ant Design Vue + pinia（仍是 JS）
packages/
  agent/    createHarness() 装配 pi AgentHarness、会话存储翻译、压缩策略、内置工具
  ai/       模型 provider 注册与模型清单
  database/ Drizzle schema 与 repository
  config/   环境变量校验
  logger/   pino logger 与 Hono 中间件
```

依赖方向固定为 `apps → packages`，package 之间只能指向更底层的 package：

```
server ──▶ agent ──▶ ai
   │         └─────▶ database ──▶ config
   ├──▶ database
   └──▶ logger ──▶ config
```

`agent → database` 这条边是为了让 `PgSessionStorage` 落到 Postgres，无环。

两条硬约束：

1. **pi 的接线只允许出现在 `agent` 与 `ai` 两个 package。** 上层只依赖
   `createHarness()` 与 harness 的事件流，需要 pi 的类型时从 `@petrel/agent`
   转导出拿（`packages/agent/src/index.ts`），不在上层直接 `import @earendil-works/*`。
   这样将来换内核只动两个 package。
   *既有例外（待收口）*：`apps/server` 的测试为了用 `fauxProvider` 直接依赖了
   `@earendil-works/pi-ai`（devDependency）。
2. **`packages/config` 是全仓唯一读 `process.env` 的位置**，导出校验后的 `env`。
   唯一例外是模型 API key——由 pi-ai 的 auth 机制自己从 `DEEPSEEK_API_KEY` /
   `SILICONFLOW_API_KEY` 解析。

后续 package（`knowledge`、共享 `contracts` 等）在对应业务首次落地时创建，
不提前维护空 package。

---

## 3. 各层职责

### apps/server

`src/http/app.ts` 挂载路由，**挂载顺序有安全含义**：

```ts
app.route("/api/system", system);   // 公开
app.route("/api/auth", auth);       // 公开
app.use("/api/*", requireAuth);     // ← 分界线
app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.route("/api/account", account);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", admin);
```

`system` 与 `auth` 是仅有的两个公开前缀，之下的路由自动受保护。
`src/http/routes/isolation.test.ts` 有用例守着这条性质——新增受保护路由必须挂在
分界线之后。

`src/services/` 是业务层，只表达「哪一种失败」，翻译成状态码是 route 层的事
（`AuthError`、`HarnessRegistryError` 都是这个模式）。核心是
`harness-registry.ts`，见 §5。

### apps/web

- `apis/*` 一个后端模块一个文件，`http.js` 统一处理 401 跳登录。
- `composables/useAgentStream.js` 把 pi 的 AgentEvent 归约为 `messages` 与
  `toolCalls`，是**对话界面的唯一状态来源**；`components/chat/*` 只做纯渲染。
  消息结构直接沿用 pi 的 `AgentMessage`，不自定义中间格式。
- `stores/*` 用 pinia：`session`（会话列表与当前会话）、`preferences`（模型与
  system prompt 偏好）、`layout`、`theme`、`workspace`。
- 斜杠命令：机制在 `composables/useCommandPalette.js`，命令在
  `views/ChatView.vue` 注册（`/new` `/compact` `/context` `/workspace` `/sidebar`）。

`apps/web` 已从 v0.4 的 ESLint 迁移到 Biome，`pnpm run lint` 统一覆盖全仓（含前端）。
前端目前仍为 JS 无 typecheck，但不影响 lint 运行。

### packages/agent

- `harness.ts` — `createHarness()` 装配 pi `AgentHarness`；`resolveModel()`、
  `DEFAULT_SYSTEM_PROMPT`。
- `session/pg-storage.ts` — pi `SessionStorage` 的 Postgres 实现，
  **全仓唯一懂「pi 的 11 种会话树条目类型怎么拆进 `type` + `payload` 两列」的地方**。
  `createPgSession()` 给生产用，`createMemorySession()` 给降级与测试用。
- `compaction.ts` — 上下文压缩策略，见 [context-compaction.md](context-compaction.md)。
- `tools/` — 内置工具，目前只有 `current-time`。

### packages/ai

模型 provider 注册。DeepSeek 官方与 SiliconFlow 都不在 pi 内置 provider 里，
用 `createProvider` 自行注册：

| 模型 id | provider | 传输 | 窗口 | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek 官方 | `openai-responses.lazy` | 1,000,000 | 默认，`reasoning: true` |
| `deepseek-ai/DeepSeek-V3` | SiliconFlow | `openai-completions.lazy` | 65,536 | 限流时的备选 |

DeepSeek 官方不提供 chat/completions，所以只能走 Responses API。

### packages/database

Drizzle schema（`src/schema.ts`）四张表：`users`、`sessions`、`session_entries`、
`user_preferences`。repository 一表一文件在 `src/repositories/`。

**这一层不 import 任何 pi 类型**（`payload` 是 `unknown`），翻译在 `packages/agent`。
测试用 PGlite 内存 Postgres，不需要 Docker。

迁移在 `packages/database/drizzle/*.sql`，启动时 `runMigrations()` 自动应用。
两个陷阱：compose 必须挂载 `drizzle` 目录（否则容器里用的是烘进镜像的旧副本，
而日志照样打印 `database migrations applied`）；`drizzle-kit migrate` **不读
`DATABASE_URL`**，它连的是 `drizzle.config.ts` 里硬编码的那个连接串。

---

## 4. 会话存储模型

**一条会话是一棵 append-only 的条目树。**

```
session_entries
  id          text     pi 生成
  session_id  uuid     → sessions.id (cascade)
  parent_id   text     语义顺序由这条链决定
  timestamp   text
  type        text     11 种之一
  payload     jsonb    除上面几列之外的字段整份存这里
  entry_seq   bigserial 仅用于 getEntries({ afterEntrySeq }) 的游标分页
```

三条必须记住的性质：

1. **顺序由 `parent_id` 链决定，`entry_seq` 不参与语义定序。**
2. **`message` 只是 11 种类型之一**，还有 `compaction` / `model_change` /
   `active_tools_change` / `leaf` 等。
3. **投影历史给用户看只能用 `entryRepo.listAll()` 过滤 `message`，不能用
   `session.buildContext()`**——后者会应用 compaction 变换，压缩发生后用户刷新
   会看到历史凭空消失。`buildContext()` 只用于喂模型（那里正需要压缩后的版本）。

`user_preferences` 一人一行（`user_id` 作主键），`default_model` 与 `system_prompt`
两列可空，**`null` 表示跟随系统默认**——不是空字符串，route 层会把空串归一成 `null`。

---

## 5. 关键链路：一次对话

```
POST /api/chat  { message, sessionId, systemPrompt?, model? }
   │
   ├─ requireAuth：验签 + 查库确认用户存在且未禁用
   ├─ registry.acquire(sessionId, userId, message, assembly)
   │     ├─ sessionRepo.upsert()  ← 归属校验就在这里，必须在装配 harness 之前
   │     └─ 取缓存实例 / 装配新实例
   ├─ streamSSE：订阅 harness 事件 → 同步入队 → 独立 pump 写出
   └─ handle.send(message)
         ├─ 超阈值则先压缩（见 context-compaction.md）
         └─ harness.prompt(message) → pi agent loop → 落库
```

SSE 帧契约：

```
event: agent      data: <pi 的 AgentEvent JSON，原样透传>
event: error      data: { message }
event: compaction data: { phase: "start" }
                      | { phase: "end", outcome: <投影后的 CompactionOutcome> }
                      | { phase: "blocked", reason }
```

`sessionId` 由**前端生成**（`crypto.randomUUID()`）、后端 upsert，所以 SSE 不需要
回传新会话 id。

### harness 按 sessionId 常驻

`services/harness-registry.ts`：进程内 Map + idle TTL 5 分钟 + 容量上限 200
（到顶且无空闲可淘汰则 503）。由此确立三条语义：

1. **落库由 harness 自己完成**，路由不订阅事件写库。
2. **连接断开不等于停止**：关页面/切走，agent 继续跑完并落库，用户回来能看到
   完整回答。要真停下来走 `POST /api/chat/abort`。
3. **同一会话的第二个请求进 `followUp` 队列**，当轮结束后自动接上。registry 用一条
   promise 链（`Entry.chain`）保护「判断是否在跑 + 发起调用」这段临界区，
   **但绝不把「等整轮跑完」串进去**——那样第二个请求会排到第一轮结束之后才发起，
   `followUp` 分支永远走不到。

### 消费 pi AgentEvent 的硬约束

这几条都核对过 pi 的 `types.d.ts`，不是凭文档记忆：

1. `message_update` / `message_end` 带完整的（部分）`message`，直接覆盖，
   不要自己拼 delta。
2. `tool_execution_end` 的 `isError` 在**事件顶层**，不在 `result` 里。
3. **模型调用失败时 pi 不抛异常也不发 error 事件**，而是把原因写进 assistant
   消息的 `errorMessage`（`stopReason: "error"`）。只处理 `event: error`
   会显示一条空白助手消息。
4. **`emitAny` / `emitOwn` 串行 `await` 每个订阅回调，且没有超时。**
   所以**订阅回调里绝不能做网络 I/O**——`await stream.writeSSE(...)` 在客户端
   不读流时会因背压永不 resolve，卡住整个 harness。`routes/chat.ts` 因此把回调改成
   同步入队（`http/sse-queue.ts`，上界 2000 帧），真正的写出交给独立的 pump 循环，
   队列溢出只断开那一个连接。常驻实例把这个问题从「卡一个请求」放大成「卡整个会话」，
   是本项目最贵的一次教训。
5. **`AgentHarness` 没有 `setSystemPrompt()`。** 常驻实例要在每个新 run 使用最新
   提示，正确挂点是 `before_agent_start` hook 的 `BeforeAgentStartResult.systemPrompt`，
   不是重建实例。
6. **`phase` 是私有字段没有 getter**，要判断是否在跑只能自己订阅 `agent_start` /
   `settled` 维护标记。

### 失败模型

| 情况 | 结果 |
| --- | --- |
| 会话不属于当前用户（`upsert` 返回 `false`） | 403 |
| 会话表读写故障（`upsert` **抛错**） | 降级成一次性内存会话，本轮照常对话但不落库 |
| 容量已满且无空闲可淘汰 | 503 |
| 开流后写 `session_entries` 失败 | **整轮失败**（`event: error`），不吞——harness 的后续上下文正是从这颗树读的 |
| 整个数据库不可用 | 500（`requireAuth` 查库这一步先失败，请求进不到 handler） |
| 没 cookie / 验签失败或过期 / 用户不存在或已禁用 | 401 |

注意第一、二行的区别：两者共用一个返回值就等于把归属校验绕过去了。

---

## 6. 认证与权限

邮箱密码登录，JWT 存 httpOnly cookie（`petrel_token`，`SameSite=Strict`，7 天，
`secure` 仅在生产开启）。密码用 Node 内置 `scrypt`，JWT 用 Hono 内置 `hono/jwt`——
**零第三方认证依赖**。

- `requireAuth` **每次请求都查一次库**确认用户存在且未禁用，不只验签：token 里的
  role 只是签发那一刻的快照，而 admin 禁用滥用者必须立即生效。角色与禁用状态
  一律以库里为准。
- `ADMIN_EMAILS` 名单里的邮箱在注册与每次登录时自动提升为 admin，不做反向降级。
- 改密码是 `POST /api/account/password`，挂在 `requireAuth` 之下而**不在公开的
  `/api/auth` 前缀里**——改凭据的端点靠 handler 手写校验，哪天漏了就等于认证绕过。
  它**不失效其他设备上的旧 token**（JWT 无状态），彻底解决要给 `users` 加
  `tokenVersion` 并让 `requireAuth` 比对。
- 本地开发时 cookie 的 `secure` 必须关掉，否则浏览器静默丢弃 cookie，
  表现为「登录返回 200 但下一个请求仍是未登录」。

---

## 7. 配置

`packages/config/src/index.ts` 校验并导出 `env`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 影响 cookie 的 `secure` |
| `PORT` | 5050 | |
| `LOG_LEVEL` | | pino 级别 |
| `DATABASE_URL` | | 必填 |
| `JWT_SECRET` | | 必填 |
| `ADMIN_EMAILS` | 空 | 逗号分隔，自动提升为 admin |
| `COMPACTION_ENABLED` | `true` | 只认 `"true"` / `"false"`，其他字符串直接抛错 |
| `COMPACTION_THRESHOLD_RATIO` | `0.8` | 0 < ratio < 1 |
| `COMPACTION_ABSOLUTE_CAP` | `120000` | 正整数 |
| `DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY` | | 由 pi-ai 自己读，不经 config |

校验刻意严格（比如 `COMPACTION_ENABLED=0` 会抛错而不是被当成 truthy 静默开启）：
配置错误要在启动时炸，不要在运行时变成难查的行为差异。

API key 混入非 ASCII 字符时 pi 报 `Cannot convert argument to a ByteString`，
这个报错不指向根因，配 key 时留意。

---

## 8. 测试策略

```bash
pnpm run typecheck   # 各包 tsc -p tsconfig.check.json（apps/web 没有）
pnpm run lint        # Biome，排除 apps/web 与 .claude
pnpm run test        # vitest run
pnpm run build       # 后端 tsc + 前端 vite build
```

- **agent 层用 pi 自带的 `fauxProvider` 跑真实 agent loop**，不需要模型凭据也不 mock
  内部。新增 agent 行为优先按这个模式写测试。
- **数据库层用 PGlite 内存 Postgres**，不需要 Docker。
- vitest 在仓库根统一配置，`@petrel/*` 别名直接指向 `src/index.ts`。
  **新增 package 要同步改三处**：compose 的 src 挂载、`tsconfig.base.json` 的 paths、
  `vitest.config.ts` 的 alias。漏改会让容器启动即崩，而宿主机 `pnpm dev` 一切正常。
- 在**主仓库根**跑全量测试要加 `--exclude '**/.claude/**'`，否则 vitest 会把
  `.claude/worktrees/` 里的副本一起跑掉，报一批与当前代码无关的失败。

---

## 9. 已知边界

公开部署前必须先做的：

- **配额与 token 计量**、**注册限流**、**邮箱验证**、**密码重置**都还没有。
- 登录失败限流（同一邮箱 5 次失败锁 15 分钟）是**单实例内存**的，进程重启即失效、
  多副本部署下无效。
- 常驻 harness 也是进程内状态：**当前架构只支持单副本**。多副本要么做会话亲和，
  要么把 registry 挪到共享存储。
- `users` 缺 `tokenVersion`，改密码/禁用无法立即失效其他设备的 token
  （禁用有 `requireAuth` 每次查库兜住，改密码没有）。

重构遗留：

- `apps/web` 有约 8000 行待删的旧对话代码与知识图谱/思维导图组件，
  且没有 typecheck / 可用的 lint。
- `apps/server` 的测试直接依赖 `@earendil-works/pi-ai`，破了「pi 只在 agent/ai」
  这条约束。

任务跟踪在 Linear 的 **HEU-OpenWings / Agent base 重构升级** 项目。

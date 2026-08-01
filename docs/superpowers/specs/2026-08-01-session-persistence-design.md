# 数据层与会话持久化设计

给 `apps/api` 补上 Postgres 数据层，把 pi 的对话记录落库，让前端左栏的会话列表从静态骨架变成真实功能。

关联文档：[backend-plan.md](../../backend-plan.md) · [frontend-plan.md](../../frontend-plan.md)
对应 Linear issue：HEU-6（数据层）+ HEU-10（会话持久化）

## 1. 背景与范围

### 为什么先做这块

后端目前只有 `GET /api/system/health` 与 `POST /api/chat`。前端调用的 v0.4 接口有约 90 个，
全部补齐等于把整个 Python 后端重写一遍，横跨 9 个独立子系统。按依赖关系拆开后，
**数据层是几乎所有业务的前置**，而它现在完全不存在：compose 里没有 Postgres 服务，
没有 `packages/database`，`.env.template` 里也没有连接串。

会话持久化跟着数据层一起做，因为它是数据层第一个真实的消费者——只建表不接业务，
交付后前端看不到任何变化，也验证不了 schema 设计得对不对。

### 本次范围

| 做 | 不做 |
| --- | --- |
| Postgres 进 compose、`packages/database`、Drizzle schema 与 migration | 认证（HEU-7）——只建最小 users 表与一条默认用户 |
| 会话与消息落库、历史恢复、会话 CRUD 接口 | 断线重连与 `persisted` 事件的幂等去重 |
| 前端左栏接真实数据：列表 / 新建 / 切换 / 重命名 / 删除 / 刷新恢复 | 知识库、Dashboard、评测、agent 注册表 |
| 中断的半截回答保留并标记 | 会话搜索、分页、导出、分享 |

### 已确认的决策

| 决策项 | 结论 |
| --- | --- |
| 术语 | **session**（不是 conversation / thread），与前端左栏 `SessionSidebar` 对齐 |
| 用户归属 | 建最小 users 表 + 一条固定默认用户，`sessions.user_id` 非空外键 |
| session id | **前端生成**（`crypto.randomUUID()`），随 `POST /api/chat` 发送，后端 upsert |
| 中断语义 | 半截回答**保留并标记** `interrupted`，刷新后仍可见 |
| 落库失败 | 只记 error 日志，**不中断对话**，不通知前端 |
| 分层 | `packages/database` 出 schema + client + repository，`apps/api` 出 service + routes |
| 数据层测试 | PGlite 内存 Postgres，不用 testcontainers |
| pi 的 sessionId | 复用同一个 id 传给 `Agent({ sessionId })` |

## 2. 同类项目调研

设计前对照了三个项目，避免闭门造车。

| 维度 | OpenAI Agents SDK | Vercel ai-chatbot | 本设计 |
| --- | --- | --- | --- |
| 表结构 | `agent_sessions` + `agent_messages` | `chat` + `message` | `sessions` + `messages` |
| 消息内容 | `message_data` Text，整条 JSON | `parts` json + `role` 独立列 | `message` jsonb + `role` 独立列 |
| 排序 | `created_at` 主 + `id` 次 | `createdAt` | **`seq` 整数** |
| 新会话 id | 调用方传入 | **前端生成** | 前端生成 |
| 级联删除 | 有 | 有 | 有 |

三条结论：

**`seq` 保留，这点比两个参考都稳。** agent 一轮会连续产出 assistant 消息与 toolResult 消息，
插入时间戳很可能落在同一毫秒。Vercel 单靠 `createdAt` 在这种情况下顺序不稳定；
OpenAI SDK 加 `id` 做次级排序，本质是在打这个补丁。`seq` 一步到位且语义明确。

**`role` 提到字段级**（采纳 Vercel）。生成标题要找首条 user 消息、将来按角色统计，
有独立列就是普通 `WHERE`，否则要写 `message->>'role'`。代价是一列冗余。

**session id 前端生成**（采纳 Vercel）。这消掉了原设计里的 `event: session` SSE 帧——
前端不必等后端回传 id 就能更新左栏，SSE 协议也不用新增事件类型。
伪造 id 的风险由 `user_id` 归属校验兜住。

## 3. 架构

依赖方向 `api → database → config`，与仓库既定约定一致。

```
packages/database/
├─ src/
│  ├─ schema.ts              # Drizzle 表定义，唯一的表结构真相
│  ├─ client.ts              # 连接池 + drizzle 实例
│  ├─ migrate.ts             # 启动时执行 migration
│  ├─ index.ts
│  └─ repositories/
│     ├─ sessions.ts         # 纯数据访问，不含业务规则
│     └─ messages.ts
└─ drizzle/                  # drizzle-kit 生成的 migration SQL，提交进仓库

apps/api/src/
├─ services/session.ts       # 会话业务逻辑（标题、历史回灌、事件订阅落库）
└─ http/routes/
   ├─ sessions.ts            # 会话 CRUD
   └─ chat.ts                # 改造：接 sessionId、挂持久化
```

**为什么 repository 与 schema 同包**：改表结构时数据访问跟着一起改，不会漏。
**为什么 service 单独一层**：「订阅 agent 事件并落库」有真实复杂度——要判断事件类型、
维护 seq、处理中断、吞掉异常。塞进路由会让 `chat.ts` 迅速变成什么都干的文件。

## 4. 数据模型

```sql
users
  id          uuid        primary key
  username    text        not null unique
  created_at  timestamptz not null default now()

sessions
  id          uuid        primary key          -- 前端生成
  user_id     uuid        not null references users(id) on delete cascade
  title       text        not null
  created_at  timestamptz not null default now()
  updated_at  timestamptz not null default now()
  index (user_id, updated_at desc)             -- 左栏按最近更新排序

messages
  id           uuid        primary key default gen_random_uuid()
  session_id   uuid        not null references sessions(id) on delete cascade
  seq          integer     not null
  role         text        not null            -- 冗余自 message，便于 SQL 过滤
  message      jsonb       not null            -- pi 的 AgentMessage 原样
  interrupted  boolean     not null default false
  created_at   timestamptz not null default now()
  unique (session_id, seq)                     -- 兼作查询索引
```

### 三个设计决定

**不建 `tool_calls` 表**，尽管 backend-plan 列了它。pi 的工具结果是一条独立的
`toolResult` 类型 `AgentMessage`，存进 `messages` 就已经完整。单独的 `tool_calls`
是为 Dashboard 统计做的反范式，等 HEU-28 真要统计时再加，现在建就是空表。

**`message` 整条存 JSONB 而不拆字段**。理由和前端沿用 `AgentMessage` 是同一个：
pi 仍在快速演进，拆字段等于把它的内部结构固化进表结构，它一改就要 migration。
JSONB 存原样，恢复时直接回灌 `initialState.messages`，零转换。

**Postgres 镜像用 `pgvector/pgvector:pg17`**，虽然本轮用不到向量——省得知识库那轮
再换镜像重建数据卷。

### 默认用户

migration 里插入一条固定 UUID 的记录（`username: 'default'`），常量导出给 service 引用。
认证落地后，这条记录要么被真实用户接管，要么作为历史数据的归属保留。

## 5. 持久化流程

以下事件语义均已核对 pi 的 `types.d.ts`，不是凭记忆。

### 关键事实

- `subscribe(listener)` 的 listener promise **会被 agent await 并计入 run 的 settlement**，
  所以 listener 内必须 try/catch，抛出去会影响 agent 本身运行
- `agent_end` 带完整 `messages: AgentMessage[]`，但那是整个 transcript，
  包含恢复时回灌的历史，一次性写会重复
- `state.streamingMessage` 是流式中的半截消息，**不在** `state.messages` 里
- `state.errorMessage` 的注释明确覆盖 "failed or **aborted**" 两种情况

### 写入点

| 时机 | 动作 |
| --- | --- |
| 请求进入 | upsert session；首次创建时用首条消息生成标题 |
| 用户消息 | 立即 append（不等模型响应，保证用户输入不丢） |
| `message_end` | append 一条完整消息，`seq` 递增 |
| `agent_end` | 收尾：`state.streamingMessage` 若存在则标记 `interrupted` 落库；更新 `updated_at` |

**为什么增量写而不在 `agent_end` 一次性写**：一是 `agent_end.messages` 含回灌的历史会重复；
二是增量写下中断时已完成的消息本来就已落库，不需要特殊处理。

**`seq` 由 service 维护**：加载历史时取当前 max，之后递增。`unique (session_id, seq)`
做兜底——撞了说明有并发问题，宁可报错也不要静默写乱。

### 标题生成

首条用户消息前 30 字，超出截断加省略号。**不调模型生成**：那需要额外一次 API 调用和成本，
而当前只注册了一个模型。用户可以随时重命名。

## 6. 接口

```
GET    /api/sessions              列表：id / title / updatedAt，按 updated_at desc
PATCH  /api/sessions/:id          重命名：{ title }
DELETE /api/sessions/:id          删除（级联删消息）
GET    /api/sessions/:id/messages 历史消息，按 seq 升序
POST   /api/chat                  { message, sessionId, systemPrompt? }
```

没有 `POST /api/sessions`——session 由前端生成 id 后在首次发消息时 upsert 创建，
单独的创建接口是多余的一次往返。

**upsert 只在不存在时写 title**。session 已存在时不覆盖标题，否则用户重命名过的会话
会在下一条消息时被打回首句截断。

`GET /api/sessions/:id/messages` 返回 `{ messages: AgentMessage[] }`——直接是 pi 的
消息数组，前端拿到就能灌进 `useAgentStream`，不需要转换。`interrupted` 标记随消息一起
返回在同层：`{ messages: [...], interruptedSeqs: number[] }`，前端据此渲染「已停止」提示。

### `/api/chat` 的变化

请求体新增 **必填** 的 `sessionId`。处理流程：

1. upsert session（校验 `user_id` 归属，不匹配返回 403）
2. 加载该 session 的历史消息，回灌 `initialState.messages`
3. `createAgent({ sessionId })`，把同一个 id 传给 pi 供 provider 做缓存感知
4. 落库用户消息
5. 订阅事件按 §5 落库

SSE 响应格式**不变**，仍是 `event: agent` 透传 pi 的 AgentEvent 加 `event: error`。
这是前端生成 id 换来的收益。

## 7. 前端改动

| 文件 | 改动 |
| --- | --- |
| `stores/session.js`（新） | 会话列表、当前 sessionId、CRUD 调用 |
| `apis/session_api.js`（新） | 四个会话接口，走已有的 `apis/http.js` |
| `components/shell/SessionSidebar.vue` | 空态换成真实列表；新建 / 切换 / 重命名 / 删除 |
| `apis/chat_api.js` | `streamChat` 参数加 `sessionId` |
| `composables/useAgentStream.js` | 新增 `loadHistory(messages)`；`send` 传 `sessionId` |
| `views/ChatView.vue` | 切换会话时加载历史；新建会话时生成 id |

**`useAgentStream.js` 这次要改了。** 上一轮三栏改造时它是「一行不改」的红线，
因为那轮纯粹换渲染层。这轮是新增能力——它必须能被灌入历史消息、必须知道当前 sessionId。
归约逻辑本身（AgentEvent → messages / toolCalls）不动，只加载入口。

**左栏排序按 `updated_at desc`**，与后端索引一致。

### 「新建会话」是纯前端操作

点「新对话」时前端只做三件事：生成新 UUID、清空当前对话、切换当前 sessionId。
**不调任何接口**，因此这个会话在数据库里还不存在，也**不出现在左栏列表**里——
直到用户发出第一条消息、后端 upsert 建行为止。这与 ChatGPT 的行为一致：
开了新对话又没说话就切走，不会留下一堆空会话。

代价是「新建」这个动作本身没有服务端痕迹，如果用户新建后立刻刷新页面，那个空会话就没了。
这是预期行为，不是 bug。

## 8. 错误处理

| 场景 | 处理 |
| --- | --- |
| 落库失败 | listener 内 try/catch，记 error 日志，对话继续 |
| session 不属于当前用户 | 403，不泄露该 session 是否存在 |
| `seq` 唯一约束冲突 | 抛错并记日志——说明有并发写入，不能静默 |
| 启动时数据库连不上 | migration 失败即退出，不带病启动 |
| 运行时数据库不可用（`/api/chat`） | **降级为无持久化模式**，见下 |
| 运行时数据库不可用（会话 CRUD） | 500，这些接口本来就只有数据库这一个数据源 |
| 前端传的 sessionId 格式非法 | 400，不进数据库 |
| 删除不存在的 session | 404 |

### `/api/chat` 的降级

「落库失败不中断对话」这条决策要贯彻到整条链路，不只是 listener。数据库不可用时：
upsert session 失败 → 跳过；加载历史失败 → 按空历史处理；后续所有落库失败 → 记日志。
**对话本身照常流式输出**，用户能正常问答，只是这轮不会被保存。

这意味着数据库挂掉时，多轮上下文会退化成单轮（历史加载不到）。这是有意的取舍：
能用但记不住，好过直接不能用。

## 9. 测试

**数据层用 PGlite**（`@electric-sql/pglite`，Node 内的 WASM Postgres，Drizzle 有官方 driver）。
毫秒级启动、每个用例一个干净实例、CI 不需要 Docker，而 SQL 语义是真实的——
外键约束、级联删除、唯一约束、事务都能测。它还有 pgvector 扩展，知识库那轮可以沿用。

| 层 | 测什么 |
| --- | --- |
| repository | CRUD、级联删除、`seq` 唯一约束、按 `updated_at` 排序 |
| service | 标题截断、历史回灌、`seq` 递增连续性 |
| 持久化流程 | 用 `agent-core` 的 `fauxProvider` 跑真实 agent loop + PGlite，验证消息落库顺序与内容 |
| 中断路径 | abort 后 `streamingMessage` 落库且 `interrupted = true` |
| 路由 | 四个会话接口的状态码与归属校验 |

沿用仓库既有模式：`agent-core` 的测试用 `fauxProvider` 跑真实 agent loop，不 mock 内部。

## 10. 验收

### 自动化

```bash
pnpm run build
pnpm test          # 现有 48 个用例 + 本次新增
```

### 人工

```bash
docker compose up -d
```

| # | 检查项 |
| --- | --- |
| 1 | 首次启动自动建表，`docker logs petrel-api-dev` 无 migration 报错 |
| 2 | 发一条消息后刷新页面，对话内容还在 |
| 3 | 左栏出现该会话，标题是首条消息的前 30 字 |
| 4 | 新建第二个会话，两个会话能来回切换且内容不串 |
| 5 | 重命名会话，刷新后新名字保持 |
| 6 | 删除会话，其消息一并消失（级联），左栏不再显示 |
| 7 | 发消息中途点停止，刷新后能看到半截回答且标记为已中断 |
| 8 | 触发工具调用的对话，刷新后工具卡片与结果都能正确重建 |
| 9 | 左栏按最近更新排序，在旧会话里发消息后它跳到顶部 |
| 10 | 停掉 Postgres 容器后发消息，对话仍能正常流式输出（只是没存上），日志有 error |

第 10 项是对「落库失败不中断对话」这条决策的直接验证。

## 11. 遗留

- **断线重连与 `persisted` 事件**：需要前端重连状态机，是另一个量级的复杂度，单独一轮
- **认证**：本次只建 users 表与默认用户，登录、JWT 中间件、超管初始化都在 HEU-7
- **会话搜索与分页**：会话多了才需要，现在做是过早优化
- **`tool_calls` 表**：等 HEU-28 Dashboard 真要统计时再加
- **消息编辑与重新生成**：v0.4 有这个能力，但它涉及 transcript 截断与分支，单独设计

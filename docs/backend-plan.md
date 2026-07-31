# 后端（apps/api）重构升级计划

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
│  ├─ api/                     # Hono HTTP 应用
│  └─ web/                     # Vue 3 前端
├─ packages/
│  ├─ agent-core/              # pi Agent 装配与内置工具
│  ├─ ai/                      # 模型 provider 注册（SiliconFlow，OpenAI 兼容）
│  ├─ config/                  # 环境配置；全仓唯一读取 process.env
│  └─ logger/                  # pino 日志与 HTTP 请求日志
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

依赖方向固定为 `apps → packages`，package 之间只允许指向更底层的 package。当前是
`api → agent-core → ai → config` 与 `api → logger → config`。

**pi 的接线只出现在 `agent-core` 与 `ai` 两个 package**，上层只依赖 `createAgent()` 与 Agent 的
事件流。这层薄封装是有意为之：pi 仍在快速演进（包名近期从 `@mariozechner/*` 迁到
`@earendil-works/*`），将来换内核时改动范围可控。

后续 package（`knowledge` · `database` 等）在对应业务首次落地时创建，不提前维护空 package。
异步任务成为独立进程时再增加 `apps/worker`。

## 3. 已完成

### M1 骨架（HEU-4，已交付）
pnpm + TS(ESM) + Hono + pino + Biome + vitest + 多阶段 Dockerfile + compose，
`GET /api/system/health`，`src/env.ts` 作为唯一读取 `process.env` 的位置。

### M2 Agent 内核（HEU-9 / HEU-11 完成，HEU-10 / HEU-13 部分完成）

- **`packages/ai`**：SiliconFlow 不在 pi 内置的 30 个 provider 里，用 `createProvider` +
  `openai-completions.lazy` + `envApiKeyAuth` 注册，默认模型 `deepseek-ai/DeepSeek-V3`
- **`packages/agent-core`**：`createAgent()` 装配 pi `Agent`，内置极简工具 `get_current_time`
- **`POST /api/chat`**：SSE，事件体为 pi 的 `AgentEvent` 原样透传，`stream.onAbort → agent.abort()`
- **测试**：用 pi 自带的 `fauxProvider` 跑真实 agent loop，不需要模型凭据也不 mock 内部，
  覆盖单轮流式事件序列与工具循环

端到端实测（真实模型 + 真实工具循环）：2 轮 turn、25 个 `message_update`、
`tool_execution_start/end` 正常，零错误。

## 4. 待办

### M1 剩余
- **HEU-6 Drizzle schema 与首个 migration**：`users` · `conversations` · `messages`(AgentMessage
  JSONB + seq) · `tool_calls` · `kb_*` · `eval_*` · `jobs`；`kb_chunks.embedding vector(1024)` + HNSW
- **HEU-7 最小认证**：登录 + JWT 中间件 + 超管初始化（范围取决于 HEU-2 的决策）
- **HEU-2 / HEU-3 决策**：认证范围（最小 JWT vs 纯单用户）、被删除能力清单确认

### M2 剩余
- **HEU-10 会话持久化**：`agent.subscribe()` → 消息落 Postgres，会话恢复时回灌
  `initialState.messages`；SSE 增加 `persisted` 事件供前端幂等去重。**这是当前前端做
  会话列表与断线重连的前置依赖**
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
   只依赖 `pi-ai` 与 `pi-agent-core`、把 pi 的接线收在 `agent-core` 一层内。
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

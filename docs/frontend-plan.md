# 前端（apps/web）重构升级计划

Petrel（原 Yuxi）v0.4 前端（Vue 3 + Ant Design Vue，对接 Python API）→ v0.5（以 Agent 对话为核心，对接
后端的 pi AgentEvent SSE）的重构计划与进度。
后端计划见 [backend-plan.md](backend-plan.md)。

任务跟踪在 Linear 的 **HEU-OpenWings / Agent base 重构升级** 项目，下文的 `HEU-x` 均指对应 issue。

## 1. 路线与既定决策

本仓库采取「**先原样迁入基线，再逐步改造**」的路线，而不是新建空脚手架从零写。
好处是随时可对照 v0.4 的行为，代价是仓库里长期存在一批待删代码。

| 决策项 | 结论 | 说明 |
| --- | --- | --- |
| 框架 | 沿用 Vue 3 | 不换 React，因此用不了 pi-web-ui 组件，但可以复用 pi 的**类型** |
| 语言 | 暂时 JS，后续转 TS | 为快速跑通 SSE 先用 JS；TS 化是独立任务 |
| 首屏形态 | **单栏对话流**，工具输出内联折叠 | 原方案是三栏；会话列表缺后端持久化，右栏推后到 HEU-26 |
| 入口 | 新对话界面直接接管 `/agent` | 不并存新旧两套入口 |
| 认证 | 暂时去掉登录守卫 | agent-server 目前没有认证接口 |

## 2. 当前状态

### 已完成：新对话链路（HEU-23 / HEU-24 主体）

```
src/
├─ apis/chat_api.js               # POST /api/chat 的 SSE 消费（fetch + ReadableStream）
├─ composables/useAgentStream.js  # 核心：AgentEvent → messages / toolCalls 归约
├─ components/chat/
│  ├─ MessageItem.vue             # 按 content block 渲染：text / thinking / toolCall / 错误
│  └─ ToolCallBlock.vue           # 工具调用单行摘要 + 展开参数与结果
└─ views/ChatView.vue             # 单栏对话流 + 输入框
```

**`useAgentStream` 是整个对话界面的唯一状态来源**：它把 pi 的 AgentEvent 序列归约为
`messages`（直接沿用 pi 的 `AgentMessage`，不自定义中间格式）与 `toolCalls`，
其余组件只做纯渲染。v0.4 里手写的 chunk 拼接逻辑全部由它取代。

已端到端验证：真实模型 + 真实工具循环，2 轮 turn、25 个流式增量、零错误。

### 已完成：三栏 Shell（2026-07-31）

`AppShell.vue` 三栏骨架 + `stores/layout.js`（折叠与宽度持久化）+ `stores/workspace.js`
（右栏内容）+ `apis/http.js`（JWT 注入与 401 处理）。非对话功能作为独立路由页挂进同一 shell，
入口在左栏底部。设计与验收清单见
[specs/2026-07-31-web-three-column-shell-design.md](superpowers/specs/2026-07-31-web-three-column-shell-design.md)。

`utils/toolCall.js` 是本次新抽出的共享模块（`TOOL_STATE_TEXT` 状态文案、`formatToolArgs`
参数格式化、`extractToolResultText` 结果取文本）：中栏 `ToolCallBlock` 的内联展开与右栏
`WorkspacePanel` 的详情视图渲染的是同一份工具调用数据，抽出来是为了不让两处各写一套格式化
逻辑、日后改一处漏一处。

### 已完成：中栏沿用 v0.4 的对话视觉

三栏 shell 落地后，中栏的消息与工具调用**改回 v0.4 那套外观**——用户消息是 `--main-50`
底色的气泡、工具调用是带边框的卡片而不是一行灰字。同时把 v0.4 的
`components/ToolCallingResult/*` 接进来，工具结果按形状渲染成对应卡片
（Web 搜索、知识库检索、TodoList、计算器），而不是一律 `JSON.stringify`。

**数据层没有为此妥协**：`useAgentStream.js` 与 `chat_api.js` 仍是一行未改，pi 的
`AgentEvent` 归约逻辑原封不动。复用的只是渲染层，靠这组映射对接：

| v0.4 字段 | pi 对应物 |
| --- | --- |
| `message.type: 'human' / 'ai'` | `message.role: 'user' / 'assistant'` |
| `parsedData.reasoning_content` | content block `type: 'thinking'` |
| `toolCall.status` | `detail.state`（`tool_execution_*` 归约而来） |
| `toolCall.tool_call_result.content` | `extractToolResultText(detail.result)` |
| `message.error_type` | `message.errorMessage` |

接入 `ToolResultRenderer` 时改了它两处，都是为了斩断对 v0.4 后端的依赖：

1. **移除知识图谱结果卡片**。它 `import GraphCanvas`，会把 1.16 MB 的图谱渲染依赖重新拉进
   对话页的 chunk，而知识图谱已经从产品下线。`KnowledgeGraphResult.vue` 文件保留，
   但不再从 `ToolCallingResult/index.js` 导出——否则 barrel 文件会把它一并打包。
2. **判断知识库结果不再读 `agentStore` 里的工具 metadata**，改为纯数据结构判断
   （数组且每项有 `content` / `score` / `metadata`）。原来那条路径要打 v0.4 的 Python 接口。

注意富渲染现在还看不到效果：`agent-core` 内置工具只有 `get_current_time`，返回纯文本，
走的是默认的 `<pre>` 分支。要等 HEU-13 的 `kb_search` / `web_search` 落地，那几张卡片才有
数据可渲染——现在接进来是为了工具就位时不用再动渲染层。

输入框同样换回 v0.4 的 `MessageInputComponent`：grid 布局、单行/多行自动切换、青蓝色圆形
发送按钮（加载中变暂停图标）。它是个零后端依赖的纯 UI 组件，`ChatView` 直接用，不经过
`AgentInputArea`——那一层包的是 `threadApi` 附件上传，依赖 v0.4 后端。因此 `+` 附件按钮
不会出现：该组件在没有 `options-left` 插槽时就不渲染它，正好符合当前没有附件能力的事实。
`/` 命令按钮与模型标识放在它的 `actions-right` 插槽里。

**这两处让中栏偏离了三栏 shell 的视觉约定**，是有意接受的代价，不是疏漏：

- 中栏用 `--main-50` / `--gray-*` 这套**冷青灰**变量，左右两栏是 shell 的**暖中性**变量
  （`--surface-sunken` 等），两者有色差
- 输入框带 `box-shadow`，而 shell 的约定是「除命令面板浮层外零阴影」

路由从 `/database` 改名为 `/knowledge` 时，顺带修了 8 处硬编码旧路径的引用
（`stores/database.js`、`DataBaseView.vue`×2、`KnowledgeBaseCard.vue`、`HomeView.vue`×3、
`LoginView.vue`）——不修的话左栏入口能跳过去，但页面内部的二次导航会 404。`HomeView.vue`
里指向 `/graph` 的入口是直接删除而不是改名，因为图谱功能已经从产品里摘掉，改名没有意义；
`LoginView.vue` 与 `HomeView.vue` 里的 `/agent/:id` 改成了 `/agent`（新对话入口不再按 id
区分）。**孤儿文件里的旧路径引用没有一并清**：`AppLayout.vue`、`AgentSingleView.vue`、
`GraphView.vue`、`DatabaseHeader.vue`、`AgentView.vue`（见 §5 待删除列表）还留着
`/database`、`/graph`、`/agent/:id` 的引用，留给以后做死代码清理的人删文件时一并处理，
现在单独修没有意义。

本次仍是 JS，未做 TS 化；会话列表是静态骨架，等 HEU-10；`@` 引用与模型切换未做。
`/graph` 与 `/agent/:agent_id` 路由已摘除，文件保留待死代码清理时一并删除。

### 迁入基线的现状

- **大部分接口不可用**：基线调用的是 v0.4 的 Python API，而 agent-server 目前只提供
  `GET /api/system/health` 与 `POST /api/chat`。登录、知识库、图谱、Dashboard 都会失败。
- **旧对话代码已无路由引用**但文件仍在：`AgentView` · `AgentSingleView` ·
  `AgentChatComponent` · `AgentMessageComponent` · `AgentInputArea` · `ChatSidebarComponent` ·
  `AgentConfigSidebar` · `ToolCallingResult/*`，合计约 8000 行。
- **`pnpm run lint` 不可用**（v0.4 遗留）：依赖是 eslint 9，只认 `eslint.config.js`，
  而仓库里是旧格式 `.eslintrc.cjs`。

## 3. 与后端的契约

`POST /api/chat`，请求体 `{ message, systemPrompt? }`，响应是 SSE：

```
event: agent   data: <pi 的 AgentEvent JSON，原样透传>
event: error   data: { message }
```

需要 POST 与自定义请求头，所以用 `fetch` + `ReadableStream` 读流，不用 `EventSource`。

### 消费 AgentEvent 的三条硬约束（已核对 pi 的 `types.d.ts`）

1. `message_update` **带完整的部分 `message`** → 直接覆盖，不要自己拼 delta
2. `tool_execution_end` 的 **`isError` 在事件顶层**，不在 `result` 里
3. **模型失败时 pi 不发 `error` 帧**（`prompt()` 不抛异常），而是把原因写进 assistant 消息的
   `errorMessage`。只处理 `event: error` 会导致界面显示一条**空白助手消息**——
   这个坑连 mock 都跑不出来，只有连真实后端才会暴露

`text_start` / `toolcall_delta` 等是 pi-ai 层的 `assistantMessageEvent` 子类型，嵌在
`message_update` 内部，不是顶层事件。当前归约直接覆盖整条 `message`，因此不受其变化影响。

## 4. 待办

### 近期（不依赖后端）
- **删除死代码与重依赖**：旧对话组件（约 8000 行）+ 知识图谱（`GraphCanvas` ·
  `GraphDetailPanel` · `KnowledgeGraphSection`）+ 思维导图（`MindMapSection`），
  连同 `@antv/g6` · `sigma` · `graphology` · `d3` · `markmap-*` 依赖一并移除。
  收益明显：`GraphCanvas` 单个 chunk 就有 1.16 MB
- **修 lint**：迁到 `eslint.config.js`，或直接换 Biome 与 agent-server 统一
- **Composer 增强（HEU-25）剩余部分**：`/` 命令面板已完成（`/new` · `/workspace` · `/sidebar`）；
  `@` 引用知识库等后端 kb 接口，模型切换等 HEU-12，附件上传等文件服务

### 依赖后端
| 前端能力 | 依赖后端 issue |
| --- | --- |
| 会话列表、多轮上下文、刷新恢复 | HEU-10 消息落库 |
| 断线重连 + `persisted.seq` 幂等去重 | HEU-10 的 `persisted` 事件 |
| 审批弹窗 `ApprovalDialog` | HEU-14 工具 preflight HITL |
| Agent 选择与配置表单 | HEU-12 agent 注册表（TypeBox schema 生成表单） |
| 引用角标与 refs 面板（HEU-26） | HEU-21 `kb_search` 真实检索 |
| 登录页恢复 | HEU-7 最小认证 |
| 知识库管理页（HEU-27） | HEU-21 KB 与文档管理 API |
| Dashboard / 评测页 | HEU-28 / HEU-29 |

### later
- **TS 化**：加 `typescript` + `vue-tsc`，`import type` 自 `@earendil-works/pi-agent-core`
  拿到端到端类型（pi 包只作为 devDependency，仅取类型、零运行时依赖）
- **三栏布局**：会话列表（左）+ 工作区（右），等后端持久化与 kb 检索就绪
- **pnpm 版本对齐**：当前 10.11.0，agent-server 是 11.15.1

## 5. 组件处置清单

| 处置 | 组件 |
| --- | --- |
| **保留/移植** | `MarkdownContentViewer` · `ImagePreviewComponent` · `ThemeToggle` · `ModelProvidersComponent` · `FileTable` · `FileUploadModal` · `ChunkParamsConfig` · `EmbeddingModelSelector` · `dashboard/*` |
| **已重写** | 对话流（→ `components/chat/*` + `useAgentStream`） |
| **待删除** | `AgentView` · `AgentSingleView` · `AgentChatComponent` · `AgentMessageComponent` · `AgentInputArea` · `ChatSidebarComponent` · `AgentConfigSidebar` · `ToolCallingResult/*` · `GraphCanvas` · `GraphDetailPanel` · `KnowledgeGraphSection` · `MindMapSection` |

## 6. 开发约定与踩过的坑

- **统一走 compose，不在宿主机跑 dev server**。构建与检查可以在宿主机执行
  （`pnpm install` / `pnpm run build`）。
- **后端地址**由 `VITE_API_URL` 决定，默认 `http://host.docker.internal:5050`
  （后端是独立仓库、独立 compose，不在同一 Docker 网络里）。
- **`.dockerignore` 必须排除 `node_modules`**。否则 `COPY . .` 会把宿主机（Windows 路径）
  的 pnpm 符号链接复制进镜像并断链，容器直接找不到 vite。这个坑迁入时踩过。
- **nginx 反代必须 `proxy_buffering off`**。`/api/chat` 是 SSE，不关缓冲流式输出会被 nginx
  攒住，表现为「等很久然后一次性全出来」。
- **改后端 `.env` 后要 `docker compose up -d` 而不是 `restart`**（环境变量不热重载）。
  前端调试时如果一直收到 `Provider is not configured`，先查这个。
- **仓库统一 LF**（`.gitattributes`），避免 Windows 检出 CRLF 与格式化工具冲突。

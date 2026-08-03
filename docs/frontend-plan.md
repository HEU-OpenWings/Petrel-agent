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
| 认证 | **已启用**：登录页 + 路由守卫 + httpOnly cookie | 见 [superpowers/specs/2026-08-03-auth-design.md](superpowers/specs/2026-08-03-auth-design.md) |

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

### 已完成：会话列表接真实数据（2026-08-02）

`apis/session_api.js` + `stores/session.js` 打通左栏：列表 / 新建 / 切换 / 重命名 / 删除，
刷新页面后能恢复历史对话。后端契约见 [backend-plan.md](backend-plan.md) 的
「M1 数据层 + M2 会话持久化」一节。

**「新建会话」是纯前端操作**：点「新对话」只生成一个 `crypto.randomUUID()` 并清空当前对话，
不调任何接口。这个会话要等用户发出第一条消息、后端 upsert 建出行之后才会出现在左栏。
所以新建后立刻刷新页面，那个空会话会消失——这是预期行为，与 ChatGPT 一致，
避免「开了新对话又没说话就切走」攒下一堆空会话。配套地，`GET /api/sessions/:id/messages`
对后端还不存在的会话返回 200 + 空数组而不是 404，「新建」和「切换」才能共用同一条加载路径。

`composables/useAgentStream.js` 这次改了（上一轮它是「一行不改」的红线）：新增
`loadHistory(history)` 入口、`send` 接受 `sessionId` 并透传。**AgentEvent 的归约逻辑
（`apply`）一行没动**，只加了加载入口。

三处不显眼、但删掉就会出 bug 的地方，改动前先看代码里的注释：

1. **`loadHistory()` 一进来先 `abort()`**。用户常在等回答时就切走会话，不掐掉上一轮的话，
   旧流后续到达的消息、工具调用与错误文案会继续写进新会话的界面，`running` 也会一直卡在
   `true` 让输入框禁用。
2. **`ChatView` 里有一个 `sendSeq` 计数器**。历史 GET 慢时用户没等它回来就发了消息，
   晚到的 `loadHistory()` 会先 `abort()` 掐死这条刚起的流、再把 `messages` 清空——
   用户的消息凭空消失。这里不能用 `running` 判断：切会话时旧流也在 running，
   分不出「别的会话的旧流」和「本会话的新流」，只有 send 的次数能。
   `loadSession()` 里另有一道 `sessionStore.currentId !== id` 检查，防的是连点两个会话时
   响应乱序到达、晚到的旧响应把当前会话的内容盖掉。
3. **`submit()` 里没有 `sessionStore.select(sessionId)`**。计划草案里有这一行，实测必须删掉：
   流跑一半时用户切到别的会话，它会在 `send` 返回后把 `currentId` 拽回旧会话并重新加载历史。

左栏的「加载中…」只在列表还是空的时候显示。`v-for` 是独立的兄弟节点、不在那条 v-if 链里，
光判 `loading` 的话，每发一条消息 `submit()` 都会 `refresh()` 一次，这行字就会插到完整列表
上方闪一个网络往返。

重命名 / 删除失败时用 `window.alert` 出声——不出声的话 Vue 会把 promise 的异常接进
`errorHandler`，界面上什么都不会发生，用户看到的只是「标题没变」，分不清是自己点错了还是
请求挂了。用原生弹窗而不是引一套 toast，是为了跟同一处的 `prompt` / `confirm` 保持一致。

断线重连与 `persisted` 幂等去重仍未做，等后端的 `persisted` 事件。

**这一轮的浏览器验收没做**：后端仓库没有 `SILICONFLOW_API_KEY`，发不出真实对话，
所以刷新恢复、两个会话来回切、中断后半截回答、hover 出图标、三个原生弹窗、active 高亮
都只有自动化测试和构建覆盖，**没有人在浏览器里看过**。

### 已完成：认证接入（HEU-7，2026-08-03）

`apis/auth_api.js` + `apis/admin_api.js` + 重写的 `stores/user.js` + `views/LoginView.vue`
（登录/注册同页切换）+ `views/AdminView.vue`（用户列表与禁用/解禁）+ `router` 的
`requiresAuth` / `requiresAdmin` 守卫。后端契约见 [backend-plan.md](backend-plan.md) 的
「认证与越权收口」。

- **token 不进前端状态**：它在 httpOnly cookie 里，JS 读不到也不需要读。
  代价是刷新页面后必须在 `main.js` 里调一次 `/api/auth/me` 才知道自己是谁，
  且这次 `await` 必须排在 `app.use(router)` **之前**（分界是它而不是 `mount()`：
  router 的 `install()` 里就会发起首次导航），否则已登录用户刷新 `/agent`
  会在 user 还是 null 时被守卫重定向到 `/login`，等 fetchMe 回来导航早已 resolve。
- **`logout()` 先同步清本地态再发请求**：`http.js` 的全局 401 分支不 `await` 它，
  紧接着就跳转，跳转发生的那一刻必须已经是未登录态。
- `meApi` 带 `skipUnauthorizedHandler`：未登录时 `/me` 返 401 是正常路径，
  不该触发全局跳转，该不该跳由守卫按 `meta.requiresAuth` 决定。

**v0.4 遗留组件因此坏掉了一批**，见 §5「组件处置清单」下的记录——本轮只记录不修复。

### 已知问题：前端的三个基建缺口

1. **前端目前零 lint 覆盖**，而且两头都断：根 `biome.json` 的 `files.includes` 里有
   `"!apps/web"`，所以 `pnpm run lint` 根本不看前端；而 `apps/web` 自己的 `lint` 脚本是
   `eslint . --fix`，装的是 ESLint 9 却只有 ESLint 8 时代的 `.eslintrc.cjs`，直接报找不到配置。
   两条路都跑不通，意味着本轮新增的前端代码没有经过任何静态检查。
   修法见 §4「修 lint」——迁到 `eslint.config.js`，或者直接把 `apps/web` 纳入 Biome。
2. **组件层（`.vue`）没有自动化测试**。原因是根 `vitest.config.ts` 没挂 `@vitejs/plugin-vue`
   （该插件已经装在 `apps/web` 里），vitest 解析不了 `.vue` 文件；**不是「缺 `@vue/test-utils`」**。
   composable / store / api 这些 `.js` 已经有测试并跟着 `pnpm test` 一起跑（本轮新增
   `apis/chat_api` · `composables/useAgentStream` · `stores/session` 三个测试文件）。
   挂插件属于基建变更，单独一个任务做。**后果要说清楚**：`.vue` 一个都测不了意味着
   登录页、admin 页、路由守卫这类刚落地的安全相关 UI 全靠人眼，没有回归网。
3. **`apps/web` 没有 typecheck**（是 JS，且没有 `vue-tsc`），Biome 又在根 `biome.json` 里
   排除了它。加上第 2 条，前端目前**三道自动化关卡（lint / typecheck / 组件测试）全空**，
   只有 `vite build` 能拦住语法错误与不存在的具名导入。

另外 `stores/session.js` 的 `refresh()` 里那句 `list.value = list.value ?? []` 是恒等式
（`list` 初始化为 `[]`，永远不会是 nullish），属既存代码，本轮未改。

### 迁入基线的现状

- **大部分接口不可用**：基线调用的是 v0.4 的 Python API，而 agent-server 目前只提供
  `GET /api/system/health` · `POST /api/chat` · `/api/sessions` 四个会话接口 ·
  `/api/auth` 四个认证接口 · `/api/admin/users` 两个管理接口。
  知识库、图谱、Dashboard 仍会失败；登录已在 HEU-7 重做，走 v0.5 的 `/api/auth`。
- **旧对话代码已无路由引用**但文件仍在：`AgentView` · `AgentSingleView` ·
  `AgentChatComponent` · `AgentMessageComponent` · `AgentInputArea` · `ChatSidebarComponent` ·
  `AgentConfigSidebar` · `ToolCallingResult/*`，合计约 8000 行。
- **`pnpm run lint` 不可用**（v0.4 遗留）：依赖是 eslint 9，只认 `eslint.config.js`，
  而仓库里是旧格式 `.eslintrc.cjs`。

## 3. 与后端的契约

`POST /api/chat`，请求体 `{ message, sessionId, systemPrompt? }`，响应是 SSE：

```
event: agent   data: <pi 的 AgentEvent JSON，原样透传>
event: error   data: { message }
```

需要 POST 与自定义请求头，所以用 `fetch` + `ReadableStream` 读流，不用 `EventSource`。

`sessionId` 是**必填**的 UUID，由前端 `crypto.randomUUID()` 生成，后端 upsert 建行，
所以 SSE 不需要新增事件类型回传新会话 id。缺它或格式不对，后端返回 400 且不碰数据库。

会话 CRUD 在 `/api/sessions`：`GET /`（列表，按 `updatedAt` 倒序）·
`GET /:id/messages`（历史，**不存在的会话返回 200 + 空数组**）· `PATCH /:id`（`{ title }`，
不存在返回 404）· `DELETE /:id`（不存在返回 404）。

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
- **补组件层测试基建**：根 `vitest.config.ts` 挂 `@vitejs/plugin-vue`（该依赖只装在
  `apps/web/package.json` 里），否则任何 `import` 了 `.vue` 的测试都跑不起来，
  `apps/web` 的组件层零测试覆盖；连带把 `apps/web` 纳入 typecheck 与 Biome。见 §2「基建缺口」
- **Composer 增强（HEU-25）剩余部分**：`/` 命令面板已完成（`/new` · `/workspace` · `/sidebar`）；
  `@` 引用知识库等后端 kb 接口，模型切换等 HEU-12，附件上传等文件服务

### 依赖后端
| 前端能力 | 依赖后端 issue |
| --- | --- |
| ~~会话列表、多轮上下文、刷新恢复~~ | HEU-10 消息落库 —— **已解锁并交付**，见 §2 |
| 断线重连 + `persisted.seq` 幂等去重 | HEU-10 的 `persisted` 事件（未做） |
| 审批弹窗 `ApprovalDialog` | HEU-14 工具 preflight HITL |
| Agent 选择与配置表单 | HEU-12 agent 注册表（TypeBox schema 生成表单） |
| 引用角标与 refs 面板（HEU-26） | HEU-21 `kb_search` 真实检索 |
| ~~登录页恢复~~ | HEU-7 最小认证 —— **已解锁并交付**，见 §2「认证接入」 |
| 知识库管理页（HEU-27） | HEU-21 KB 与文档管理 API |
| Dashboard / 评测页 | HEU-28 / HEU-29 |

### later
- **TS 化**：加 `typescript` + `vue-tsc`，`import type` 自 `@earendil-works/pi-agent-core`
  拿到端到端类型（pi 包只作为 devDependency，仅取类型、零运行时依赖）
- ~~**三栏布局**：会话列表（左）+ 工作区（右）~~ —— 已交付（shell 见 §2 2026-07-31，
  会话列表见 §2 2026-08-02）；剩下的是右栏里等 kb 检索的引用面板，即下方 HEU-26
- **pnpm 版本对齐**：当前 10.11.0，agent-server 是 11.15.1

## 5. 组件处置清单

| 处置 | 组件 |
| --- | --- |
| **保留/移植** | `MarkdownContentViewer` · `ImagePreviewComponent` · `ThemeToggle` · `ModelProvidersComponent` · `FileTable` · `FileUploadModal` · `ChunkParamsConfig` · `EmbeddingModelSelector` · `dashboard/*` |
| **已重写** | 对话流（→ `components/chat/*` + `useAgentStream`） |
| **待删除** | `AgentView` · `AgentSingleView` · `AgentChatComponent` · `AgentMessageComponent` · `AgentInputArea` · `ChatSidebarComponent` · `AgentConfigSidebar` · `ToolCallingResult/*` · `GraphCanvas` · `GraphDetailPanel` · `KnowledgeGraphSection` · `MindMapSection` · `AppLayout`（已无路由引用） |

`stores/user.js` 里的三个兼容垫片——`getAuthHeaders()`（store 方法）与
`checkAdminPermission` / `checkSuperAdminPermission`（具名导出）——不是新功能，
只为让还在调它们的 v0.4 文件（`apis/base.js` · `apis/agent_api.js` · `views/GraphView.vue` ·
`components/FileUploadModal.vue` · `components/DebugComponent.vue`）不至于运行时 TypeError
或构建期报「导入不存在的符号」。**它们随上面这批遗留组件一起删除**，不单独保留。

### HEU-7 暴露的遗留组件损坏（只记录，不修复）

Task 12 重写 `stores/user.js` 时删掉了 v0.4 store 的字段与方法（`username` · `userId` ·
`userIdLogin` · `phoneNumber` · `userRole` · `avatar` · `token` · `isSuperAdmin` ·
`getCurrentUser()` · `updateProfile()` · `uploadAvatar()`），下列组件仍在引用，实测结果：

| 组件 | 现状 | 是否可达 |
| --- | --- | --- |
| `components/StatusBar.vue` | `onMounted` 调 `userStore.getCurrentUser()` → TypeError（被就地 `try/catch` 吞成 `console.error`，不白屏）；`userStore.username` 恒 `undefined`，用户名显示为「游客」 | **可达**，挂在 `views/DashboardView.vue`（路由 `/dashboard`）下 |
| `components/UserInfoComponent.vue` | `username` / `avatar` / `userIdLogin` / `phoneNumber` / `userRole` 全恒 `undefined`（头像首字母、角色标签、个人资料都空）；打开个人资料还会调已不存在的 `getCurrentUser()` / `updateProfile()` / `uploadAvatar()` | **可达**，挂在 `views/HomeView.vue`（路由 `/`）下 |
| `components/SettingsModal.vue` | 两个 tab（基本设置 / 模型配置）连同内容区都 gate 在 `userStore.isSuperAdmin` 上，新 store 没有这个 computed，恒 `undefined`，**admin 打开也是空侧栏 + 空内容** | 暂不可达：只在孤儿 `layouts/AppLayout.vue` 里挂载 |
| `components/DebugComponent.vue` | 调试面板读 `token` / `userId` / `username` / `userIdLogin` / `phoneNumber` / `userRole` / `isSuperAdmin`，全恒 `undefined` | 暂不可达：同上 |

修不修取决于这些组件的去留（`SettingsModal` 内嵌的 `ModelProvidersComponent` 在保留清单里，
外壳本身未定；`DebugComponent` 与 `AppLayout` 大概率随死代码清理一起删），因此本轮不修，
留给「删除死代码」那一轮统一处置。

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

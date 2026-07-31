# 前端三栏 Shell 改造设计

`apps/web` 从当前的「单栏对话流 + v0.4 遗留图标条布局」改造为 codex 形态的三栏工作台。

关联文档：[frontend-plan.md](../../frontend-plan.md) · [backend-plan.md](../../backend-plan.md)

## 1. 背景与边界

后端目前只有 `GET /api/system/health` 与 `POST /api/chat`。认证（HEU-7）、会话持久化（HEU-10）、
知识库（HEU-21）、Dashboard / 评测（HEU-28 / HEU-29）、agent 注册表（HEU-12）**全部不存在**。

因此本次是**布局与骨架改造**，不新增任何依赖后端的功能。凡是缺后端支撑的能力，要么按未来契约
把前端一侧写完整（认证），要么明确不做（会话列表、`@` 引用、模型切换），不造空壳死按钮。

### 已确认的范围决策

| 决策项 | 结论 |
| --- | --- |
| 语言 | **继续用 JS**，不引入 TypeScript。故 `api/http.ts` 实为 `api/http.js`，能力不变 |
| 认证 | 前端能力做完整（JWT 注入 + 401 跳登录），**路由守卫先关闭**，等 HEU-7 翻开 |
| 会话列表 | **只做静态骨架**，不实现多会话 |
| 右栏内容 | 工具调用详情 + 引用区（引用为空态） |
| Composer | **只做 `/` 命令**（纯前端命令），`@` 引用与模型切换不做 |
| 非对话页 | 旧页面**保留**并挂进新 shell，等后端接口完善 |
| 默认路由 | `/` 保留 HomeView，`/agent` 是对话页 |
| 配色 | 新增一组 shell 专用暖中性变量，现有 `gray` / `main` 阶梯一行不改 |
| 验收 | 我保证构建通过 + 提供自查清单，视觉由人工在浏览器确认 |

### 明确不做

- 会话的新建 / 切换 / 重命名 / 删除
- `@` 知识库引用、模型下拉切换、附件上传（`+` 按钮为禁用态并说明原因）
- 助手消息的赞 / 踩 / 分享（无后端，只做「复制」）
- 左栏顶部搜索框（无数据源）
- TypeScript 化、eslint 修复、死代码删除（各自是独立任务）

## 2. 架构

三栏骨架由 `AppShell.vue` 承担，布局状态与右栏内容分别由两个 store 持有。

```
AppShell.vue
├─ SessionSidebar.vue      左栏 240px   ← stores/layout（折叠）
├─ <router-view>           中栏 弹性
└─ WorkspacePanel.vue      右栏 360px   ← stores/layout（折叠/宽度）+ stores/workspace（内容）
```

选这个结构而不是「右栏写在 ChatView 里」或「Teleport 注入」，理由是：

- 两栏的折叠与宽度持久化逻辑集中在 `stores/layout.js` 一处，不散落在两个组件里
- 右栏内容是「从对话流分流出去的数据」，走 store 是单向数据流，比 Teleport 的 DOM 挂载点约定清晰
- `WorkspacePanel` 可以只给一份 store 状态就独立渲染，不需要拉起整个 ChatView

右栏是否出现由路由 `meta.workspace` 决定，非对话页自动只剩两栏。

### 新增文件

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `layouts/AppShell.vue` | 三栏骨架，只管布局与折叠/拖拽，不含业务 | layout store |
| `components/shell/SessionSidebar.vue` | 左栏：新对话、会话空态、路由入口、用户区 | layout store · user store · router |
| `components/shell/WorkspacePanel.vue` | 右栏：渲染选中的工具调用详情 + 引用空态 | workspace store |
| `composables/useResizePanel.js` | 右栏拖拽：pointer 事件、边界钳制、双击复位 | 无 |
| `stores/layout.js` | `leftCollapsed` / `rightCollapsed` / `rightWidth` + localStorage | 无 |
| `stores/workspace.js` | 右栏展示什么：`activeToolCallId` | 无 |
| `apis/http.js` | fetch 封装 + JWT 注入 + 401 处理 | user store · router |
| `components/chat/CommandPalette.vue` | `/` 命令面板 | 无（命令由 ChatView 注入） |
| `views/EvalView.vue` | 新建壳，内层包现有 `EvaluationBenchmarks` | 现有组件 |

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `router/index.js` | 路由表重写；守卫关闭（见 §3） |
| `views/ChatView.vue` | 去掉自带的顶栏与外层高度控制（交给 AppShell），Composer 重做 |
| `components/chat/MessageItem.vue` | 气泡形态改造（见 §5） |
| `components/chat/ToolCallBlock.vue` | 摘要行降噪 + 新增「送到右栏」入口 |
| `assets/css/base.css` · `base.dark.css` | 各追加 9 个 shell 变量 |

`composables/useAgentStream.js` 与 `apis/chat_api.js` **一行不改**。这两个文件是已端到端验证过的
AgentEvent 归约逻辑，本次改造纯粹在其之上换渲染层。

## 3. 路由

```
/                    BlankLayout > HomeView          保留原样
/login               LoginView                        独立，不套 shell
/agent               AppShell > ChatView              meta: { workspace: true }
/knowledge           AppShell > DataBaseView          复用现有页，等后端
/knowledge/:id       AppShell > DataBaseInfoView      复用现有页，等后端
/dashboard           AppShell > DashboardView         复用现有页，等后端
/eval                AppShell > EvalView              新建壳
*                    EmptyView
```

摘掉两条路由，**文件保留不删**：

- `/agent/:agent_id`（`AgentSingleView`）— 已被 ChatView 取代
- `/graph`（`GraphView`）— 知识图谱已在 backend-plan 决策为移除

### 守卫

全部路由 `meta.requiresAuth: false`。守卫代码保留结构并注明「HEU-7 落地后翻开」。

有一处必须一并短路：现有守卫的 `requiresAdmin` 分支会调 `agentStore.initialize()`，那是 v0.4 的
Python API，必然抛错。关掉认证时如果只跳过 `requiresAuth` 而留着这段，结果不是「不校验」而是
「导航时报错」。

## 4. `apis/http.js`

```js
request(url, { method, body, headers, signal, responseType })
get / post / put / del
```

行为：

1. 非 `FormData` 时自动 `JSON.stringify` 并带 `Content-Type: application/json`
2. `user store` 有 token 就注入 `Authorization: Bearer <token>`，没有则不注入（当前常态）
3. 响应 401 → `userStore.logout()` → `router.push('/login?redirect=<当前 fullPath>')`
4. 其他非 2xx → 抛 `Error`，message 取后端的 `error.message` / `detail` / `message`，都没有则用状态码
5. 不做 admin / superadmin 权限预检 —— 那是 v0.4 的角色模型，等 HEU-7 定了再说

### 与 `apis/base.js` 并存

旧页面（知识库 / Dashboard / 评测）继续走 `base.js`，新代码走 `http.js`。这是**有意保留的过渡态**：
`base.js` 被 10 个旧 api 文件引用，改它等于牵动全部旧页面，而那些页面本来就在等后端重写。

在 `base.js` 文件头加一行注释标明「v0.4 遗留，新代码请用 http.js」。两者最终收敛的时机是旧页面
按 HEU-21 / HEU-28 重写时。

## 5. 视觉规范

样式语言参考 ChatGPT 桌面端：暖中性色、极少边框、靠背景色差与留白分层、圆角偏大、几乎无阴影。

### 新增变量

`base.css` 与 `base.dark.css` 各定义一组同名变量。现有 `--gray-*` / `--main-*` 阶梯不改动，
避免牵动旧页面与 ant-design-vue 的兼容变量。

| 变量 | 亮色 | 用途 |
| --- | --- | --- |
| `--surface-app` | `#ffffff` | 中栏主区、右栏卡片 |
| `--surface-sunken` | `#f9f9f7` | 左栏底色 |
| `--surface-subtle` | `#f4f4f2` | 用户气泡、代码块、inline code |
| `--surface-hover` | `#ececea` | hover 与选中态 |
| `--border-subtle` | `#ecece8` | 仅在必须处的 1px 分隔 |
| `--text-strong` | `#1f1f1e` | 正文 |
| `--text-muted` | `#6e6e69` | 次要信息、时间、状态 |
| `--text-faint` | `#9b9b95` | 占位、空态 |
| `--radius-lg` | `12px` | 容器圆角 |

气泡 18px、Composer 24px 圆角就地写死，不为一次性用法建变量。

青蓝主色 `--main-color` 保留给链接、选中、流式光标等强调用途。

### 硬约束的落实

- **无悬停位移**：所有 hover 只改 `background-color` / `color`，禁用 `transform` 与 `margin` 变化
- **不滥用阴影渐变**：全站零 `box-shadow`，唯一例外是 `/` 命令面板（浮层不给层次就读不出来），
  用现有 `--shadow-2`。Composer 图里那点阴影用 1px 边框替代
- **图标**：统一 `lucide-vue-next`，尺寸 14 / 16 / 18 三档
- **不引入新色值**：错误态用现有 `--color-error-*`，替换掉 `MessageItem` / `ChatView` 里现在硬编码的
  `#e8a3a3` / `#fdf5f5` / `#c04a4a`

## 6. 布局与尺寸

| 栏 | 宽度 | 折叠后 |
| --- | --- | --- |
| 左栏 | 240px 固定 | 0（完全收起） |
| 中栏 | 弹性；内容 `max-width: 760px` 居中，左右 padding 24px | — |
| 右栏 | 默认 360px，拖拽范围 280–560px | 0 |

### 760px 是上限而非固定值

`240 + 760 + 360 = 1360 > 1280`。1280 下三栏全开时中栏可用宽度只有 680px，内容区实际 632px。
处理方式是让中栏内容在可用宽度不足时自然收窄，**不出现横向滚动、不挤压左右栏**。
1920 下中栏可用 1320px，内容稳定在 760px 居中。

### 不做持续响应式强制折叠

只在**首次加载**时判断：视口 < 1024px 则右栏默认折叠。此后完全听用户的显式操作。

不做「窄屏强制折叠」是因为那会导致用户在窄屏点展开却没反应——store 写进去了，computed 又把它
覆盖掉。宁可让窄屏下中栏窄一点，也不要一个点了没反应的按钮。

### 折叠与展开入口

中栏顶部有一条轻量工具条（无底边框）：左端 `PanelLeft` 按钮开合左栏，右端 `PanelRight` 按钮开合
右栏，中间是当前页标题。左栏完全收起后，这个按钮是唯一的展开入口，必须常驻。

### 持久化

`stores/layout.js` 用单个 localStorage key `petrel.layout`，存 `{ v: 1, leftCollapsed, rightCollapsed, rightWidth }`。
读取失败（隐私模式 / JSON 损坏 / 版本不符）静默回落默认值，不抛错。

## 7. 对话流改造

`useAgentStream` 的归约逻辑不动，只改渲染层。

### MessageItem

- 去掉消息之间的 `border-top` 分隔线，改用留白分隔
- **用户消息**：右对齐、`--surface-subtle` 底、圆角 18px、`max-width: 70%`，去掉「你」角色标签
- **助手消息**：无气泡、全宽、去掉「Petrel」角色标签
- 助手消息底部一行操作区，只放**复制**按钮（赞/踩/分享无后端支撑，不做）
- `thinking` 块降为一行低调摘要，与工具调用摘要同一视觉形态，但**只能内联展开**（没有 `↗`
  送右栏入口）——右栏是工具调用与引用的位置，思考过程不进右栏
- `errorMessage` 的处理逻辑不变（pi 在模型失败时不发 error 帧，只把原因写进消息），只换配色变量

### ToolCallBlock

从「带边框卡片 + 内联展开」改为一行低调摘要：

```
⚙ get_current_time · 完成 · 12ms                              ›  ↗
```

两个独立入口，**中栏与右栏都能看详情**：

- **点摘要行** → 中栏内联展开 / 收起。低调样式、无边框、`pre` 限高 240px。用于就地速查
- **hover 时右端出现 `↗`** → 写 `workspace.activeToolCallId`，右栏若折叠则自动展开。用于长输出细读

两者互不干扰，可同时开着。右栏折叠时工具细节仍然可见，不会因为折叠丢失信息。

状态色：运行中用 `--main-color`，失败用 `--color-error-500`，其余 `--text-muted`。

## 8. Composer

- 圆角 24px、`--surface-app` 底、1px `--border-subtle` 边框；focus 时边框转深，**不做发光与位移**
- textarea 自增高，`max-height: 200px`
- 底部操作行：
  - 左：`+` 附件按钮（**禁用态** + tooltip「附件上传待后端接口」）、`/` 命令按钮
  - 右：静态文字 `DeepSeek-V3`（如实反映当前只注册了一个模型，不做成假下拉）、发送 / 停止圆钮
- Enter 发送、Shift+Enter 换行（保持现有行为）

### `/` 命令面板

输入框为空时键入 `/` 唤起，浮在 Composer 上方。`↑` `↓` 选择、`Enter` 执行、`Esc` 关闭，
无匹配项时自动关闭且不拦截正常输入（避免用户打「/usr/bin」被面板卡住）。

三条纯前端命令，全部立即可执行：

| 命令 | 行为 |
| --- | --- |
| `/new` | 新对话：`useAgentStream.reset()` + 清空 `workspace.activeToolCallId` |
| `/workspace` | 开合右栏 |
| `/sidebar` | 开合左栏 |

没有 `/clear`。在不做多会话的前提下「清空当前对话」与「新对话」是同一个动作，
给同一行为起两个名字只会让人以为它们有区别。

命令列表由 ChatView 作为 prop 注入，`CommandPalette` 本身不知道命令的具体含义——它只负责
过滤、键盘导航和触发回调。

## 9. 左栏与右栏结构

### SessionSidebar

```
新对话                          ← Pencil 图标，点击 = /new
─────────────
会话                            ← 分组标题，--text-faint 小字
  暂无历史会话                   ← 空态一行
─────────────                   ← 推到底部
知识库 / Dashboard / 评测         ← 路由入口，lucide 图标 + 文字，active 态浅底
用户区                          ← 已登录显示头像+名字；未登录显示「未登录」+ 登录入口
```

选中态是圆角灰块（`--surface-hover`），左右留 8px 边距，不用左侧竖线指示器。

### WorkspacePanel

```
工作区                    [折叠]
─────────────
工具调用
  <选中项的名称 / 状态 / 耗时>
  参数   <JSON，折行>
  结果   <文本或 JSON，限高滚动>
  或：未选择工具调用          ← 空态
─────────────
引用
  暂无引用，等待知识库检索接入   ← 空态
```

## 10. 错误处理

| 场景 | 处理 |
| --- | --- |
| SSE `event: error` | 保持现有：写入 `error` ref，中栏顶部展示 |
| 消息的 `errorMessage` | 保持现有：消息内联展示（pi 模型失败不发 error 帧） |
| localStorage 不可用 / 数据损坏 | layout store 静默回落默认值 |
| 拖拽越界 | `useResizePanel` 钳制到 280–560；双击把手复位 360 |
| 401 | `http.js` 统一 logout + 跳登录（当前无接口会触发，属于预置能力） |
| 旧页面接口报错 | 不处理。它们本来就在等后端，报错是预期行为 |

## 11. 验收

### 构建与运行（我负责）

```bash
pnpm run build          # 必须通过
docker compose up -d    # 前端 :5173/agent 可访问，控制台无报错
```

### 人工视觉自查清单

| # | 检查项 |
| --- | --- |
| 1 | 1920 三栏全开：左 240 / 右 360，中栏内容 760px 居中 |
| 2 | 1280 三栏全开：无横向滚动，中栏自然收窄，左右栏宽度不变 |
| 3 | 左栏折叠：中栏顶部 `PanelLeft` 按钮可再次展开 |
| 4 | 右栏折叠：中栏占满剩余宽度，`PanelRight` 可再次展开 |
| 5 | 双栏都折叠：中栏内容仍 760px 居中，不铺满全宽 |
| 6 | 拖拽右栏：280 / 560 两端钳制生效，双击复位 360 |
| 7 | 刷新页面：折叠态与右栏宽度保持 |
| 8 | 发一条触发工具的消息（「现在几点」）：中栏点摘要可内联展开；点 `↗` 右栏展开详情 |
| 9 | 右栏折叠时点 `↗`：右栏自动展开并显示该工具调用 |
| 10 | 用户消息右对齐气泡，助手消息全宽无气泡，消息间无分隔线 |
| 11 | 输入 `/` 唤起面板，四条命令均可执行；`Esc` 关闭；输入 `/abc` 面板消失且不拦截 |
| 12 | 左栏四个路由入口可达，页面套在同一 shell 内（旧页面接口报错属预期） |
| 13 | 暗色模式下三栏配色正常，无残留亮色块 |
| 14 | 所有可点元素 hover 无位移，仅背景/文字变色 |

## 12. 遗留与后续

- `base.js` / `http.js` 并存，收敛时机是旧页面按 HEU-21 / HEU-28 重写
- 会话列表在 HEU-10 落地后填充，届时 `SessionSidebar` 的空态换成真实列表
- `@` 引用等 HEU-21、模型切换等 HEU-12、附件上传等文件服务
- 死代码删除（旧对话组件 ~8000 行、图谱、思维导图及其依赖）与 TS 化各自独立成任务
- `/graph` 与 `/agent/:agent_id` 的文件在死代码清理时一并删除

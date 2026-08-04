# 设置面板与用户偏好

> 设计文档 · 2026-08-04
> 本文档不对应现有的 Linear issue（`HEU-x` 编号不编造）。若纳入项目跟踪，
> 在 **HEU-OpenWings / Agent base 重构升级** 下新建一个 issue 指向本文档。

## 1. 背景

新 UI（`layouts/AppShell.vue`）没有设置入口。旧的 `components/SettingsModal.vue`
仍在仓库里，但只挂在孤儿布局 `layouts/AppLayout.vue`（无路由引用，在
`docs/frontend-plan.md` 的待删清单里），实际不可达。

「启用它」不是挂上就能用，因为它的内容是 100% v0.4 的：

- `BasicSettingsSection` 读写 `default_model` / `fast_model` / `embed_model` /
  `reranker` / `enable_content_guard` / `content_guard_llm_model`，还有
  Neo4j / MinIO / Milvus 链接卡片 —— v0.5 一个都不存在。
- `ModelProvidersComponent` 读 `config.model_names` / `model_provider_status`，
  调 `/api/system/custom-providers` 的 CRUD 与 `agentApi.getProviderModels` ——
  全是 v0.4 的 Python 接口。
- `stores/config.js` 打 `GET /api/system/config` 与 `POST /api/system/config/update`，
  而 v0.5 的 `routes/system.ts` 只有 `/health` 一个接口。
- 两个 tab 都 gate 在 `userStore.isSuperAdmin` 上，新 store 没这个 computed，
  恒 `undefined` —— 就算挂上，admin 打开也是空侧栏空内容。

后端侧 v0.5 **没有任何配置存储**：`@petrel/config` 只读 env 且不可写，
`packages/ai` 里模型是硬编码的两个，数据库只有 `users` / `sessions` / `messages`。

顺带发现一处既有缺陷：`views/ChatView.vue` 把模型名写死成 `'DeepSeek-V3'`，
注释说「只注册了这一个模型」，但 `packages/ai` 现在默认是 `deepseek-v4-flash`，
SiliconFlow 那个只是限流时的备选 —— **界面上显示的模型名是错的**。
本设计的「默认模型」一项会一并修掉。

## 2. 范围

面向**个人偏好**，所有登录用户可开，不做系统级（admin 改全局）配置。
面板含四项：

| 项 | 存储 | 后端 |
| --- | --- | --- |
| 默认对话模型 | `user_preferences.default_model` | 新增模型清单 + `/api/chat` 收 `model` |
| 默认 system prompt | `user_preferences.system_prompt` | `/api/chat` 已支持 `systemPrompt` |
| 外观主题（深/浅） | localStorage（现有 `stores/theme.js`） | 无 |
| 账号：邮箱 + 修改密码 | `users` | 新增 `POST /api/account/password` |

**明确不做**：

- 系统级 / admin 全局配置（v0.4 语义）。
- 供应商与模型的启用清单管理、自定义供应商 CRUD（`ModelProvidersComponent`
  留着不删，等将来的系统级 tab）。
- 标注「哪个 provider 的 API key 没配」。那要去探 env，而 API key 解析是 pi-ai
  auth 机制的职责（CLAUDE.md 里唯一的读 env 例外）。选了没配 key 的模型时，
  对话会返回明确的错误信息。
- 改密码后失效**其他设备**的旧 token（见 §3.3）。

## 3. 后端

### 3.1 数据层 — `packages/database`

`schema.ts` 新增：

```ts
export const userPreferences = pgTable("user_preferences", {
  // 一人一行，user_id 直接做主键：没有「同一用户多份偏好」这回事
  userId: uuid("user_id").primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // 两列都可空，null 表示「跟随系统默认」，不是「空字符串」
  defaultModel: text("default_model"),
  systemPrompt: text("system_prompt"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

配套 `repositories/preferences.ts`：`findByUserId(userId)` 与
`upsert(userId, patch)`（`onConflictDoUpdate`）。懒创建 —— 没改过设置的用户
一行都不占。migration 用既有的 `pnpm --filter @petrel/database db:generate`
生成，产物是 `drizzle/0003_*.sql`。

**不给 `users` 表加 jsonb 列**：`requireAuth` 每个请求都要 `findById` 查一次
users（`middleware/auth.ts`），把可能几 KB 的 system prompt 挂在那张表上，
等于每个请求都白读一遍。

**主题不落库**，留在现有的 `stores/theme.js` + localStorage。理由是技术性的：
主题必须在首帧之前生效，等一个网络往返会先闪一下白底。

### 3.2 模型清单 — `packages/ai` → `packages/agent`

`packages/ai` 已经把两个 `Model` 对象握在手里，加一个静态数组派生出两个导出：

```ts
export function listModels(): ModelSummary[]  // { id, name, provider, providerName }
export function findModel(id: string): Model<Api> | undefined
```

不去翻 pi 的 `Models` 有没有枚举 API —— 本地静态数组就够，也更可测。

`packages/agent` 转出 `listModels()`。**server 不直接 import `@petrel/ai`**：
依赖方向是 `server → agent → ai`，且 CLAUDE.md 规定 pi 的接线只允许出现在
`agent` 与 `ai` 两个 package。所以 `createAgent` 新增 `modelId?: string`
选项（内部查表），server 只传字符串，永远不碰 `Model` 类型。

优先级：`model`（显式对象）> `modelId` > 默认。保留 `model` 是为了不动
`agent.test.ts` 现有的 faux provider 注入方式。

### 3.3 新路由 — `routes/account.ts`，挂 `/api/account`

挂在 `app.use("/api/*", requireAuth)` **之下**：

```
GET  /api/account/preferences  → { preferences: { defaultModel, systemPrompt }, models: [...] }
PUT  /api/account/preferences  → { preferences }
POST /api/account/password     → { ok: true }
```

`GET` 把偏好与模型清单合成一个响应：消费者完全重合（设置面板 + ChatView 的
模型名显示），少一个端点少一个往返。语义上模型清单不属于「偏好」，用注释说明。

**表里没有该用户的行时**，`preferences` 是
`{ defaultModel: null, systemPrompt: null }`，**不是 `null`**。响应形状恒定，
前端不必区分「没这行」与「两项都跟随默认」——那本来就是同一件事。

**改密码不放进 `/api/auth`**，尽管 `/api/auth/me` 有「自己调 `resolveUser`
校验一次」的先例。`/me` 那样做是不得不 —— 它必须在未登录时也可调用并优雅
返回 401。改密码没这个需要，而 `auth` 是公开前缀，把一个改凭据的端点放进去、
靠 handler 里手写一次校验，是「哪天漏了就等于认证绕过」的形状。
`routes/isolation.test.ts` 守的正是这个挂载顺序。

`changePassword` 加到 `services/auth.ts`：那里已经有 `PASSWORD_MIN_LENGTH`（8）
与 `PASSWORD_MAX_LENGTH`（200），在别处重写一遍必然漂移。需要旧密码的 hash，
而 `findById` 只返回 `PublicUser`，所以用 `findByEmail(currentUser.email)` 取，
再给 users repo 加一个 `setPasswordHash`。

旧密码校验**复用登录那个内存 limiter**（同一邮箱 5 次失败锁 15 分钟）：
不限流的话它就是一个可以无限触发 scrypt（每次 64MB）的端点，并发一拉就是
内存耗尽 —— 与 `login()` 里「到阈值直接拒而不是照常验密码」同一个理由。

计数器按邮箱、与登录**共用同一个 Map**，所以有一个明确的副作用：
**改密码连错 5 次，接下来 15 分钟也登不进去**。这是有意的取舍 —— 人已经在
登录态里，锁住的只是重新登录，代价小于为它单开一套计数与清理逻辑。

**已知局限（不在本轮实现）**：改密码后**不失效其他设备的旧 token**。JWT 无状态、
7 天有效，彻底解决要给 `users` 加 `tokenVersion` 并让 `requireAuth` 比对。
本轮只重新签发当前会话的 cookie。这条与 CLAUDE.md「尚未实现」段并列记录。

### 3.4 `POST /api/chat` 接受 `model`

`parseChatRequest` 加一个字段：非字符串当没传（与现有 `systemPrompt` 的处理
一致）；传了但不在 `listModels()` 里 → **400**，不静默回落到默认模型。
透传给 `createAgent({ modelId })`。

## 4. 前端

### 4.1 新增文件

```
apis/account_api.js                     fetchPreferences / savePreferences / changePassword
stores/preferences.js                   { defaultModel, systemPrompt, models } + ensureLoaded() / save()
components/settings/SettingsModal.vue   外壳：a-modal + 左侧 tab（窄屏转顶部）
components/settings/GeneralPanel.vue    默认模型 · 默认 system prompt · 主题
components/settings/AccountPanel.vue    邮箱（只读）· 修改密码
```

组件边界：`SettingsModal` 只管「开关 + 当前 tab」，**不认识任何一个设置项**；
两个 panel 各自只读写自己关心的东西。`GeneralPanel` 走 store，`AccountPanel`
的改密码直接调 `account_api` —— 它是一次性动作，没有需要共享的状态。

不再有 `isSuperAdmin` gate：这是个人偏好，所有登录用户都能开。

### 4.2 改动的文件

- **`layouts/AppShell.vue`** — 挂 `SettingsModal`，持 `showSettings` ref。
  旧代码用 `provide('settingsModal')`，这里改用 **emit**：`SessionSidebar`
  已经有 `@new-chat` / `@select`，加 `@open-settings` 与既有惯例一致，
  而且调用关系在模板里看得见。
- **`components/shell/SessionSidebar.vue`** — 底部用户行旁加一个齿轮按钮
  （lucide `Settings`）。
- **`views/ChatView.vue`** — 发消息时把 `model` 与 `systemPrompt` 从 store
  传进 `send()`；`MODEL_NAME` 那行改成读 store，写死的 `'DeepSeek-V3'` 连同
  它那句已经过期的注释一起删掉。
- **`composables/useAgentStream.js`** — `send(message, options)` 已经转发
  `options.systemPrompt`，补一个 `options.model`。

### 4.3 加载时机

`stores/preferences.js` 暴露幂等的 `ensureLoaded()`（并发调用只发一次请求），
`ChatView` 与 `SettingsModal` 各自 mount 时调。

**不改 `main.js` 的启动序列**：那里 `fetchMe()` 之后再串一个 `load()` 会让首屏
多一个串行往返；而且未登录时会打一个必然 401 的请求，`http.js` 的全局 401
分支会把它当登录失效处理。

### 4.4 保存时机

一条规则：**落库的项（模型、system prompt）由「通用」分区底部一个「保存」按钮
统一提交；主题即时生效。**

主题不给保存按钮不是特例开洞 —— 它压根不落库，切换的那一刻就已经是最终状态。
旧代码那套「改一个下拉立刻 POST」在这里不行：system prompt 是 textarea，
每敲一个字发一次请求。

## 5. 数据流与错误处理

### 5.1 主链路

```
打开设置 → ensureLoaded() → GET /api/account/preferences
        → store 填充 → GeneralPanel 绑到一份草稿副本
点保存   → PUT /api/account/preferences（全量）→ store 更新 → message.success
发消息   → ChatView 读 store → send({ model, systemPrompt }) → POST /api/chat
```

表单绑**草稿副本**而不是直接绑 store：直接绑的话，用户改了一半关掉弹窗，
store 里已经是脏值，ChatView 下一条消息就会用上一个从未保存的设置。

### 5.2 `PUT` 用全量语义

body 就是 `{ defaultModel, systemPrompt }`，`null` 明确表示「跟随系统默认」。
**字段缺失等同于 `null`** —— 这正是全量语义的含义，后端不需要区分
`undefined` 与 `null`。不用 PATCH 增量：两个字段而已，增量语义要在后端多分
一层「没传就不动」的判断，换不来任何东西。

**空字符串在后端归一成 `null`**。否则「把 system prompt 清空」会存一个 `""`，
然后被当作有效值传给 `createAgent` —— agent 拿到一个空的 system prompt，
而不是回落到 `DEFAULT_SYSTEM_PROMPT`。

### 5.3 三个必须区分开的错误态

**(a) 加载失败 ≠ 偏好为空。** store 要有明确的 `loadFailed` 态；加载失败时面板
显示错误提示并**禁用保存按钮**，不能显示一张空表单。显示空表单的后果不是
「看着别扭」，而是用户以为设置被清空了、点一次保存，就真的把库里的值
覆盖成 `null` 了。

**(b) 偏好不可用不阻断对话。** ChatView 读不到偏好就不传 `model` /
`systemPrompt`，后端回落到 `DEFAULT_MODEL_ID` 与 `DEFAULT_SYSTEM_PROMPT`。
与 `chat.ts` 里「数据库不可用则降级为不持久化、对话照常」的既有取舍一致。

**(c) 存着的模型 id 已不在清单里。** `packages/ai` 的模型集合是会变的
（SiliconFlow 那条现在就标着「备选」）。store 加载后若 `defaultModel` 不在
`models` 里，就**当作 `null` 处理**（跟随系统默认）。不这么做的话它是个地雷：
面板显示「未选择」，但每条消息都在传那个失效 id，而 §3.4 定的是失效 model
返回 400 —— 对话会直接失败，且用户在设置里看不出原因。

### 5.4 改密码的 401 —— 用已有机制，不改状态码

「旧密码不正确」返回 **401**，前端调用时带 `treatUnauthorizedAsRequestError: true`。

`http.js` 里这个开关就是为这种情况准备的，注释写得很直白：「这个接口的 401
是请求自身的业务结果而不是登录失效 —— 登录/注册凭据错误就是这样」。
不加这个开关的后果很具体：旧密码打错一次，`handleUnauthorized()` 会
`logout()` + 跳登录页，**用户被自己的输入错误踢下线**。

限流触发返回 429，走普通错误分支显示后端文案。
成功后重新签发 cookie（当前会话不掉线），前端清空表单 + `message.success`。

## 6. 测试

### 6.1 后端（基建齐全，正常写）

- **`repositories/preferences.test.ts`** — PGlite 内存库，测 upsert 的插入与
  更新两条路径。
- **`routes/account.test.ts`**
  - 偏好：无行时 `preferences` 两项都是 `null`（而不是 `preferences: null`）
    + 完整 models 清单；`PUT` 后 `GET` 读回；字段缺失与空字符串都归一成 `null`；
    跨用户隔离。
  - 改密码：旧密码错 → 401；新密码不足 8 位 → 400；成功后旧密码登不进、
    新密码能登进；连错 5 次 → 429。
- **`chat.test.ts` 补两条** — `model` 不在清单 → 400 且不进 agent；
  合法 `model` 正确透传。
- **`packages/ai`** — `listModels()` / `findModel()` 是纯函数，直接单测。
  **不测 `createAgent({ modelId })` 与 faux provider 的组合**：`modelId` 查的是
  `@petrel/ai` 的真实注册表，硬要让它可注入就是为了测试扭曲设计。
  `createAgent` 只测「未知 `modelId` 抛错」这一条。

### 6.2 前端（受既有基建缺口限制）

能测的两个，都是 §5.3 / §5.4 里「不这么做就出具体错误」的地方，所以必须测：

- **`stores/preferences.test.js`** — `ensureLoaded()` 幂等（并发只发一次请求）、
  `loadFailed` 三态不与「偏好为空」混淆、失效 model id 归一成 `null`。
- **`apis/account_api.test.js`** — 改密码带 `treatUnauthorizedAsRequestError`，
  守住「旧密码打错不会被踢下线」。

三个 `.vue` 组件**零测试覆盖**：根 `vitest.config.ts` 没挂 `@vitejs/plugin-vue`，
任何 `import` 了 `.vue` 的测试都跑不起来（`docs/frontend-plan.md` §2 已记录）。
本轮**不修** —— 挂插件是独立的基建任务。后果说清楚：弹窗的 tab 切换、
表单校验、保存按钮的禁用态全靠人眼。

## 7. 本轮删除

| 删 | 确认 |
| --- | --- |
| `components/SettingsModal.vue` | 唯一引用者是 `AppLayout` |
| `components/BasicSettingsSection.vue` | 唯一引用者是 `SettingsModal` |
| `layouts/AppLayout.vue` | 已核实无任何文件 import 它，router 也不引用 |

删完变成孤立但**不删**（超出本轮范围，留给「删除死代码」那一轮）：
`ModelProvidersComponent`（在保留清单里，等将来的系统级模型配置 tab）、
`DebugComponent`、`TaskCenterDrawer`。`stores/config.js` 仍有 6 个 v0.4 文件
在用（`DebugComponent` · `EmbeddingModelSelector` · `ModelProvidersComponent` ·
`ModelSelectorComponent` · `DataBaseView` · `GraphView`），保留。

一处连带影响已核实：`components/UserInfoComponent.vue:173` 用
`inject('settingsModal', {})` 拿打开方法，`AppLayout` 是唯一的 provider。
删掉后它拿到默认值 `{}`，而 `:243` 有 `if (openSettingsModal)` 兜着 ——
**不会报错**，只是 HomeView 里那个入口变成静默无响应。它本来也已经是坏的
（`username` / `avatar` 全恒 `undefined`）。

## 8. 文档更新

- **`CLAUDE.md`** — 路由清单加 `account`；「尚未实现」那段补一条
  「改密码不失效其他设备的旧 token」。
- **`docs/backend-plan.md`** — 加用户偏好与 account 路由；待办里记
  token 版本号（`tokenVersion`）。
- **`docs/frontend-plan.md`** — 组件处置清单勾掉删除的三个；§2 那张
  「HEU-7 暴露的遗留组件损坏」表删掉 `SettingsModal` 那一行。

## 9. 验收标准

1. 登录用户在左栏底部点齿轮 → 弹出设置模态框，「通用」与「账号」两个 tab
   都有内容（不再是空侧栏空内容）。
2. 在「通用」里选模型、填 system prompt、点保存 → 刷新页面后设置仍在；
   新发的消息使用该模型与该 prompt。
3. ChatView 输入框旁显示的模型名与实际使用的模型一致
   （不再是写死的 `'DeepSeek-V3'`）。
4. 切换主题即时生效，刷新后保持。
5. 「账号」里用错误的旧密码改密码 → 显示错误提示且**仍处于登录态**；
   用正确旧密码改成功 → 当前会话不掉线，旧密码无法再登录。
6. `pnpm run typecheck` · `pnpm run lint` · `pnpm run test` 全绿。

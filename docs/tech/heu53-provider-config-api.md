# HEU-53 后端接口设计：Settings「模型服务」面板

> **状态**：R0 只读，已冻结（2026-08-07）
> **关联 issue**：[HEU-53 前端 settings 补一个 provider 配置界面](https://linear.app/fzb/issue/HEU-53/前端-settings-补一个-provider-配置界面)
> **分工**：王若宁（wrn666）负责前端面板实现；本文档为后端接口契约。本期由 yangchunwanwusheng 接手完整交付（后端 + 前端 R0 适配）。
> **JSON 命名**：统一 `camelCase`（与 v0.5 现有 `defaultModel`/`systemPrompt` 一致）
> **日期**：2026-08-06 初版，2026-08-07 冻结为方案 C

---

## 0. 一句话结论

issue 的核心痛点是「用户不知道为什么选择器里只有 DeepSeek、也不知道要启用别的厂商该填哪个环境变量」。现有接口 `GET /api/account/preferences` 的 `models` 来自 `listConfiguredModels()`，它用 `models.getAvailable()` **把没配 key 的 provider 过滤掉了**——所以纯前端列不出「未配置的 provider」和「每个 provider 对应的环境变量名」。

本期（R0）的交付是**两个只读端点**，补上这一块：

- `GET /api/providers` — 列出全部 11 个运行时 provider，标注每个的配置状态 + env var 名 + 填写指引
- `GET /api/providers/:providerId/models` — 某 provider 的模型目录（展开时懒加载）

issue 原文明确：「最小可用版本可以是**只读**的」「这一版不需要任何新后端接口」。R0 正是「只读」的忠实落地——之所以仍需后端，是因为数据缺口（未配置 provider 列不出来）纯前端无法绕过。

**R1（在 UI 填 key 并即时生效）不在本期范围**，见第 5 节决策边界。王若宁前端 PR#15 超前实现了 R1 写操作 UI，本期后端不交付写端点；前端 R0 适配会拆掉写 UI，R1 另开 issue。

---

## 1. 背景与现状

### 1.1 HEU-9 之后的新现状

HEU-9（[PR#5](https://github.com/HEU-OpenWings/Petrel-agent/pull/5)，已合并）把 provider 注册表从 2 个扩到 11 个（DeepSeek、SiliconFlow、OpenAI、Anthropic、Google、Moonshot、MiniMax、ZAI、阿里 Qwen、Ollama、vLLM），注册的模型有上百个。但**用户侧没有任何配置入口**——想启用一家厂商只能去改 `.env` 然后 `docker compose up -d`（注意：不能用 `restart`，环境变量不热重载）。

### 1.2 provider 配置是纯环境变量驱动

当前所有 provider 的 API key 都通过环境变量配置（`DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等；本地推理服务 Ollama/vLLM 也注册了 `OLLAMA_API_KEY`/`VLLM_API_KEY`）。**数据库里没有任何 provider 凭据表**。一个 provider「是否已配置」取决于 pi 在运行时能否解析出它的凭据（`models.checkAuth()` / `getAvailable()`）。

因此本期「模型服务面板」的本质是**只读状态展示**：把运行时的 provider 配置状态投射成用户能看懂的清单。

### 1.3 现有接口为什么不够

`GET /api/account/preferences` 现在返回：

```json
{
  "preferences": { "defaultModel": null, "systemPrompt": null },
  "models": [
    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "provider": "deepseek", "providerName": "DeepSeek", "isDefault": true }
  ]
}
```

`models` 来自 `listConfiguredModels()`，它用 `models.getAvailable()` **只返回已配置 provider 的模型**。问题：

1. **列不出未配置的 provider**：用户看不到「其实系统注册了 OpenAI/Anthropic，只是没配 key」。
2. **没有环境变量名**：`ModelSummary` 没有「这个 provider 配了没」「没配的话该填哪个 env var」。

这两块正是「按 provider 分组展示已配置/未配置 + env 指引」所必需的。**这就是要补 `GET /api/providers` 的全部理由。**

---

## 2. 范围档位

| 档位 | 功能 | 工作量 | 状态 |
|---|---|---|---|
| **R0 只读状态** | 展示全部注册 provider 的配置状态、env var 名、模型目录；不允许在 UI 输入 key | 后端 1–2 人日，前端 1–2 人日 | **本期冻结** |
| R1 admin 管理 key | admin 可保存/替换/删除系统级 API key、测试连接 | 后端 5–8 人日 | 后续升级（另开 issue） |
| R2 用户 BYOK | 每个用户存自己的 key | 10–15 人日 | 不建议本期 |
| R3 自定义 provider | admin 可创建 OpenAI 兼容 provider、改 baseUrl | 15–25+ 人日 | 暂不推荐 |

### 决策边界（以下任一被确认，必须重新评审，不能在 R0 上扩写）

1. 普通用户要能输入自己的 key（→ R2）
2. admin 要能在 UI 填 key 并即时生效（→ R1）
3. base URL 可编辑 / 允许 localhost/私网/任意 OpenAI 兼容地址（→ R3，SSRF 风险）
4. 需要自定义 provider CRUD（→ R3）
5. 「已配置」必须代表远端 key 真有效或服务在线（需真实网络调用，超出 R0）
6. 要显示「当前由哪个 env var 命中」（可后续加 `configuredEnvVar` 字段，须 source 在 envVars allowlist 内才返回）

---

## 3. 正式接口契约（R0，方案 C 扁平 DTO）

### 3.1 `GET /api/providers` — 列出全部 provider 及其配置状态

**鉴权**：已登录用户（走 `requireAuth`，与 `/api/account` 同级）。**不挂到 `/api/system`——那是公开前缀**。

**响应** `200`（`Cache-Control: no-store`）：

```json
{
  "defaultProviderId": "deepseek",
  "defaultModelId": "deepseek-v4-flash",
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "isDefault": true,
      "configured": true,
      "envVars": ["DEEPSEEK_API_KEY"],
      "note": "DeepSeek 官方 API key，在 https://platform.deepseek.com 获取",
      "modelCount": 1,
      "availableModelCount": 1,
      "runtimeStatus": "ready",
      "statusMessage": null
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "isDefault": false,
      "configured": false,
      "envVars": ["OPENAI_API_KEY"],
      "note": "OpenAI API key，在 https://platform.openai.com/api-keys 获取",
      "modelCount": 4,
      "availableModelCount": 0,
      "runtimeStatus": "ready",
      "statusMessage": null
    },
    {
      "id": "ollama",
      "name": "Ollama (本地)",
      "isDefault": false,
      "configured": false,
      "envVars": ["OLLAMA_API_KEY"],
      "note": "本地推理服务。请确认已启动 Ollama...当前运行时需设置非空的 OLLAMA_API_KEY 才会识别为已配置",
      "modelCount": 1,
      "availableModelCount": 0,
      "runtimeStatus": "ready",
      "statusMessage": null
    }
  ]
}
```

#### 字段语义（必须严格区分）

| 字段 | 来源 | 语义 |
|---|---|---|
| `isDefault` | `provider.id === DEFAULT_PROVIDER_ID` | 系统默认 provider（deepseek） |
| `configured` | `await models.checkAuth(id)` | **三态**：`true`=凭据可解析 / `false`=确实未配置 / `null`=检查失败（区别于 false！） |
| `envVars` | 项目层 side table | 该 provider 接受的环境变量名。**未配置时也有值**。本地推理服务非空（ollama/vllm） |
| `note` | 项目层 side table | 面向用户的填写指引，纯文本 |
| `modelCount` | `models.getModels(id).length` | 注册模型总数（不含配置状态） |
| `availableModelCount` | `models.getAvailable(id).length` | 已配置且通过 filterModels 的模型数。`configured=null` 时为 `null` |
| `runtimeStatus` | `ready`/`degraded` | `ready` 只表示状态检查流程成功，**不代表远端服务在线** |
| `statusMessage` | 固定泛化文案 | degraded 时的提示。**绝不放原始异常 message**（可能含路径/阈值/key 片段） |

**三态规则**（必须实现并测试）：

| 检查结果 | `configured` | `availableModelCount` | `runtimeStatus` |
|---|---|---|---|
| `checkAuth()` 返回 `undefined` | `false` | `0` | `ready` |
| `checkAuth()` 成功 + `getAvailable(id)` 成功 | `true` | 实际数量 | `ready` |
| `checkAuth()` 抛错 | `null` | `null` | `degraded` |
| `checkAuth()` 成功但 `getAvailable(id)` 抛错 | `true` | `null` | `degraded` |

**最关键的语义红线**：`configured=true` 只代表「凭据材料完整」，**不代表远端真的接受这个 key**。只有一次真实调用才能证明 key 有效（那是 R1 连接测试的事）。UI 文案不能把 `configured=true` 写成「可用」，只能写「已配置」。

**为什么 R0 不返回的字段**（删掉的旧设计）：
- `registered`：列表就是从运行时注册表枚举，恒 `true`，无信息量。
- `management`（credentialMode/canEditCredential）：R0 恒只读，UI 不渲染写控件即可。
- `source`/`authType`：回显 `AuthCheck.source` 有暴露内部标签风险，issue 不要求。
- `orphaned`：R0 无 DB 凭据，不存在孤儿。
- 列表里的 `models` 数组：用第二个端点懒加载，避免上百个模型重复传输。
- 运行时 baseUrl：避免泄露 vLLM/Ollama 内部地址。

#### 局部故障降级

某个 provider 的 `checkAuth()` 单独抛错时，**整个列表仍返回 200**，该 provider 项 `configured=null` + `runtimeStatus=degraded`。**绝不能把解析失败显示成「未配置」**——那会让用户误以为没配 key 而去重配，掩盖真实故障。

实现要点：**必须按 providerId 分别 `await models.checkAuth(id)` 各自 try/catch**。pi 的无参 `getAvailable()` 是跨 provider 的 `Promise.all`，单个 provider 抛错（`ModelsError("auth")`）会让整个调用 reject。

#### 安全要点

1. **永不序列化 `models.getAuth(id)` 的返回**——它含明文 key、headers、base URL。
2. **不返回 baseUrl**——避免泄露 vLLM/Ollama 等内部服务地址。
3. 响应头带 `Cache-Control: no-store`（凭据状态实时变化）。

#### 错误码

| HTTP | 触发条件 |
|---:|---|
| 401 | 未登录或登录失效 |
| 500 | 未分类服务端异常 |

沿用现有 `{ "error": { "message": "..." } }`（见 `apps/server/src/http/middleware/error.ts`）。

---

### 3.2 `GET /api/providers/:providerId/models` — 某 provider 的模型目录

**鉴权**：已登录用户。

**响应** `200`（`Cache-Control: no-store`）：

```json
{
  "provider": { "id": "deepseek", "name": "DeepSeek", "isDefault": true },
  "configured": true,
  "runtimeStatus": "ready",
  "statusMessage": null,
  "models": [
    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "isDefault": true, "available": true }
  ]
}
```

**未配置的 provider 也返回 200**（不是 404）：

```json
{
  "provider": { "id": "anthropic", "name": "Anthropic", "isDefault": false },
  "configured": false,
  "runtimeStatus": "ready",
  "statusMessage": null,
  "models": [
    { "id": "claude-opus-4-5", "name": "Claude Opus 4.5", "isDefault": false, "available": false }
  ]
}
```

字段语义：
- `models`：静态注册目录全集（`getModels(id)`），**不代表刚从远端刷新**。
- `available`：三态。`true`=凭据完整且通过 filterModels（当前凭据下可选）；`false`=当前不可选（provider 未配置，或被 `filterModels` 排除）；`null`=检查失败。**不代表远端刚验证成功**。
- `isDefault`：必须同时判 provider + model（聚合平台代售同名模型，只判 id 会标错）。
- **不返回** baseUrl / headers / cost / compat。

**错误码**：

| HTTP | 触发条件 |
|---:|---|
| 401 | 未登录（401 优先于 404） |
| 404 | provider 不在运行时注册表 |

providerId 用**运行时成员校验**（`models.getProvider(id)` undefined → 404），不自造 regex——pi 的 Provider.id 是任意字符串，自造 regex 可能让「列表能返回的新 provider 却查不到模型」自相矛盾。

---

### 3.3 TypeScript 契约（供前端对照）

```ts
// GET /api/providers 响应
interface ProviderStatus {
  id: string;
  name: string;
  isDefault: boolean;
  configured: boolean | null;       // null = 检查失败，区别于 false
  envVars: string[];                // 扁平，对齐前端消费
  note: string;
  modelCount: number;
  availableModelCount: number | null;
  runtimeStatus: "ready" | "degraded";
  statusMessage: string | null;
}
interface ProviderListResponse {
  defaultProviderId: string;
  defaultModelId: string;
  providers: ProviderStatus[];
}

// GET /api/providers/:providerId/models 响应
interface ProviderModelStatus {
  id: string;
  name: string;
  isDefault: boolean;
  available: boolean | null;
}
interface ProviderModelsResponse {
  provider: { id: string; name: string; isDefault: boolean };
  configured: boolean | null;
  runtimeStatus: "ready" | "degraded";
  statusMessage: string | null;
  models: ProviderModelStatus[];
}
```

---

## 4. 后端实现要点

### 4.1 文件分布（已实现）

- `packages/agent/src/models/providers.ts` — `PROVIDER_CREDENTIAL_HINTS` side table（11 个 provider 的 envVars + note）
- `packages/agent/src/models/index.ts` — `listProviderStatuses()` / `listProviderModels()` 安全查询函数 + DTO 类型
- `packages/agent/src/index.ts` — 转出上述函数与类型（不转出 `models` 单例 / pi 类型）
- `apps/server/src/http/routes/providers.ts` — 薄路由（调查询函数、设 no-store、undefined→404）
- `apps/server/src/http/app.ts` — 挂载在 `requireAuth` 之后、`requireAdmin` 之前

### 4.2 为什么 env var 名需要 side table

pi-ai 的 `envApiKeyAuth(displayName, ["ENV_VAR"])` 把 env var 名以**闭包**形式塞进 resolve() 内部，`Provider` / `ApiKeyAuth` 的公开类型都不暴露 envVars 字段——**无法从运行时 Provider 对象反射出「它认哪个 env 变量」**。`checkAuth().source` 只在已配置时给到当前命中的那一个变量名，未配置时是 undefined，列不全也覆盖不了「未配置时该填哪个」。

所以 `PROVIDER_CREDENTIAL_HINTS` 是当前代码事实的同源副本。`provider-status.test.ts` 的 hint parity 用例守着「side table 的 key 集合 == 运行时 getProviders() 的 id 集合」+「每个声明 env var 真能让 checkAuth 判为已配置」。

### 4.3 11 个 provider 的 env var 映射

| provider id | envVars | 来源 |
|---|---|---|
| deepseek | `DEEPSEEK_API_KEY` | providers.ts `envApiKeyAuth` 实参 |
| siliconflow | `SILICONFLOW_API_KEY` | 同上 |
| openai | `OPENAI_API_KEY` | pi-ai `providers/openai.js` |
| anthropic | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | pi-ai `anthropicApiKeyAuth`（依次尝试，填任一均可） |
| google | `GEMINI_API_KEY` | pi-ai `providers/google.js` |
| moonshotai | `MOONSHOT_API_KEY` | pi-ai `providers/moonshotai.js` |
| minimax | `MINIMAX_API_KEY` | pi-ai `providers/minimax.js` |
| zai | `ZAI_API_KEY` | pi-ai `providers/zai.js` |
| qwen-token-plan | `QWEN_TOKEN_PLAN_API_KEY` | pi-ai `providers/qwen-token-plan.js` |
| ollama | `OLLAMA_API_KEY` | providers.ts 实参（非空！本地服务也注册了此变量） |
| vllm | `VLLM_API_KEY` | providers.ts 实参；地址另走 `VLLM_BASE_URL`（不返回运行时值） |

**ollama/vllm 关键点**：代码注释写「通常无 key」，但 `envApiKeyAuth(["OLLAMA_API_KEY"])` 注册了变量名，**空值时 checkAuth 判未配置**。所以 note 不能简单说「留空即可」——必须如实说明「需设非空占位值才识别为已配置」。真正的 keyless auth（空值也判已配置）需改 auth 解析，超出 HEU-53 范围。

### 4.4 与现有接口的关系

- **不动 `GET /api/account/preferences`**：它的 `models` 继续作为默认模型下拉和白名单校验。provider 状态是独立关注点。
- 前端 ProvidersPanel 首次挂载请求 `GET /api/providers`；展开某 provider 时懒加载 `GET /api/providers/:id/models`。**不预加载所有 provider 的模型。**

---

## 5. R1 升级路径（本期不实现）

若组织者后续想要「在 UI 里直接填 API key 并即时生效」，范围升到 R1。**R1 必须重新设计安全边界**：

- **端点挂 `requireAdmin` 之下**（不是「所有用户可写」），路径建议 `/api/admin/providers/...`。
- **数据模型**：新增加密凭据表（AES-256-GCM，`encrypted_secret`/`nonce`/`auth_tag`/`key_hint`/`revision` 分列），加审计表。
- **运行时**：把 pi 默认的 `InMemoryCredentialStore` 换成 DB-backed 加密 store；key 更新后不需 evict harness（pi 每次调用重新 `getAuth()`）。
- **凭据优先级**：DB key > 环境变量 > 未配置。删除 DB key 才显式回落环境变量。
- **test-before-save**：保存前强制测试候选 key。
- **功能开关**：`PROVIDER_STORED_CREDENTIALS_ENABLED`（运行时是否读 DB key）、`PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED`（admin 写删接口是否开放）。
- **错误码**：引入稳定 `{error:{code,message,details}}`（如 `CREDENTIAL_REVISION_CONFLICT`/`CREDENTIAL_VERIFICATION_FAILED`）。

**R0 是 R1 的严格子集**：R0 的 DTO 在 R1 会新增字段（如 `stored` 含 keyHint/revision、`verification`），`configured`/`envVars`/`note` 等保持不变，升级时前端无需推倒重做。

---

## 6. 验收（R0）

后端：

- `GET /api/providers` 未登录 → 401；已登录 → 200 且字段精确匹配契约。
- `configured` 三态（true/false/null）覆盖；局部 provider `checkAuth` 抛错时该项 `runtimeStatus=degraded`，列表仍 200。
- `GET /api/providers/:id/models` 未注册 provider → 404；未配置 provider → 200 且 `available=false`。
- 响应永不包含明文 key / baseUrl / `getAuth()` 返回。
- `PROVIDER_CREDENTIAL_HINTS` 的 env var 名与 pi 实际读取的对齐（hint parity 测试）。
- 两个端点都带 `Cache-Control: no-store`。
- 全量 typecheck / lint / test 通过；仓库根跑测试加 `--exclude '**/.claude/**'`。

前端（本期一并适配）：

- SettingsModal 新增「模型服务」tab，模板三明确分支。
- ProvidersPanel 数据源切到 `GET /api/providers`（方案 C 扁平契约），不再用硬编码 PROVIDER_META。
- **拆掉 R1 写 UI**（save/test/delete 按钮），provider_api.js 只留两个 GET。
- 三态严格判断（`configured === true/false/null`，不用 truthy/falsy）。
- 加载失败/空态/degraded 状态都有正确文案；`configured=true` 文案只写「已配置」不写「可用」。
- ollama/vllm 用后端返回的真实 envVars。
- 不引入 v0.4 的 snake_case 数据形状。

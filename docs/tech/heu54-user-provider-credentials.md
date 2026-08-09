# HEU-54：普通用户 Provider 凭据（BYOK）

> 状态：PR #19 实现中（2026-08-09）
> 分支：`feat/heu-54-provider-credentials`
> 前置契约：[HEU-53 Provider 状态与模型目录 API](heu53-provider-config-api.md)

## 目标与不变量

已登录普通用户可以在 Settings「模型服务」中保存或覆盖自己的 Provider API Key；下一轮对话重新读取当前用户凭据，无需重建常驻 harness。保存、连接测试和删除是三个独立操作：

- 保存只做 Provider 白名单、本地格式校验与加密 upsert，不访问上游。
- 测试使用独立最小请求，不保存 candidate、不记 `token_usage`、不消耗聊天配额，也不创建聊天 session/tree。
- 删除个人凭据后重算 runtime 模型可用性，并以条件更新归一当前默认模型。

API Key 在 trim 后必须为 8–4096 个可打印 ASCII 字符（`\x21-\x7E`）。任何响应、日志、文档、截图、trace 或 HAR 都不得包含明文 Key、密文 envelope、加密主密钥、Provider 响应正文或不透明上游错误。

## Kill switch 矩阵

| stored | management | 行为 |
| --- | --- | --- |
| `false` | `false` | 完整 R0：runtime 只读 global/env；不读个人 metadata；写路由自然 404 |
| `false` | `true` | 可保存、测试、删除个人 Key；runtime 仍只用 global/env，UI 明示“尚未用于对话” |
| `true` | `false` | runtime 使用已有个人 Key；管理操作冻结，写路由自然 404 |
| `true` | `true` | 完整 R1 |

两个开关是启动配置，不热切换。任一为 `true` 时必须配置合法的 32-byte base64 加密主密钥。

## 存储与并发

迁移 `packages/database/drizzle/0009_young_post.sql` 创建 `user_provider_credentials`，以用户和 Provider 唯一定位记录。数据库只向 runtime store 暴露加密 envelope；状态列表使用 metadata-only 查询，只选择 `providerId`、`keyHint`、`revision`、`updatedAt`。

写入与删除同时使用两层并发控制：

1. 同进程 `(userId, providerId)` mutex 包住完整 mutation，包括删除前的偏好与 ambient 可用性判断。
2. 跨进程使用 revision CAS；删除与默认模型条件归一在同一事务中完成，冲突最多重试 5 次。

默认模型只在“当前值仍等于删除前读到的目标模型”时清为 `null`，不会覆盖另一个标签页刚保存的新偏好。若 ambient/env 仍使模型可用，则不清默认模型。删除幂等。

## 当前用户 Provider 状态

GET DTO 必须同时表达三组事实：

- `configured: true | false | null`
- `personalCredential.status: stored | not_stored | unknown | disabled`
- `runtimeCredentialSource: personal | ambient | none | unknown`

数据库、metadata、envelope、keyId 或解密状态未知时 fail-closed，不能静默改用 ambient。只有“确认没有个人记录”时才允许 personal → ambient 回落。

## 管理 API

所有路由在 `/api/providers/:providerId` 下，userId 只来自 `currentUser.id`。path、body、query 都不接受 userId。management 关闭时不注册写 handler。

| 方法与路径 | 成功响应 | 说明 |
| --- | --- | --- |
| `PUT /credential` | `{ providerId, credential: { status: "stored", keyHint, updatedAt } }` | 保存或覆盖，不联网 |
| `POST /test` | `{ ok: true, providerId, modelId, source }` | `source` 为 `candidate` / `personal` / `ambient` |
| `DELETE /credential` | `{ providerId, credential: { status: "not_stored", keyHint: null, updatedAt: null }, defaultModelReset }` | 幂等删除与条件归一 |

错误统一为 `{ "error": { "code": "...", "message": "..." } }`：

| code | HTTP |
| --- | ---: |
| `PROVIDER_NOT_FOUND` | 404 |
| `INVALID_REQUEST` / `INVALID_API_KEY` | 400 |
| `CREDENTIAL_CONFLICT` / `CREDENTIAL_NOT_CONFIGURED` | 409 |
| `CREDENTIAL_REJECTED` / `CREDENTIAL_TEST_FAILED` | 422 |
| `CREDENTIAL_RATE_LIMITED` | 429 |
| `CREDENTIAL_STORE_UNAVAILABLE` | 503 |
| `CREDENTIAL_TEST_TIMEOUT` | 504 |
| `PROVIDER_OPERATION_FAILED` | 500 |

PUT/DELETE 共用按 userId 的 write limiter；POST test 使用独立 test limiter，不按 Provider 分桶。无法准确计算时不返回 `Retry-After`。

## Candidate 连接测试

请求体中 `apiKey` 属性存在就测试 candidate，即使它是空字符串也必须进入 candidate 格式校验；不能以 truthy 判断回落。属性缺省时，优先测试 saved personal；确认没有个人行时才测试 ambient。

探针固定使用最小 prompt、`maxTokens: 8`、`maxRetries: 0`、`maxRetryDelayMs: 0`、10 秒超时和 `AbortSignal`。固定 probe model：

| Provider | Model |
| --- | --- |
| deepseek | `deepseek-v4-flash` |
| siliconflow | `deepseek-ai/DeepSeek-V3` |
| openai | `gpt-5-nano` |
| anthropic | `claude-haiku-4-5` |
| google | `gemini-2.0-flash-lite` |
| moonshotai | `kimi-k2.5` |
| minimax | `MiniMax-M2.7` |
| zai | `glm-5-turbo` |
| qwen-token-plan | `qwen3.6-flash` |
| ollama | `qwen2.5:0.5b` |
| vllm | `default` |

只捕获安全 HTTP status：401/403 映射为 Petrel 422，timeout 映射 504，404/429/5xx 泛化为 422；Ollama/vLLM 使用本地服务不可达文案。响应与日志不透传正文、usage、request/response ID、headers 或原始异常。

## Chat 与 SSE

chat preflight 顺序固定为：

1. registry acquire 与会话所有权检查
2. `handle.checkModelAuth()`
3. quota check
4. `streamSSE`

无凭据在开流和扣配额前返回普通 HTTP 409；数据库或解密异常返回 503。所有 pre-stream 拒绝路径都 `release()`。

常驻 harness 捕获本次 handle 的 Provider ID，但 `checkModelAuth()` 每轮调用自己的 Models credential store；stored 开启时因此会重新读用户 DB Key。SSE 订阅回调同步调用 `projectAgentEvent()`：只发送 core `AgentEvent` 的白名单投影，所有 Harness 自有事件 fail-closed 丢弃。stream catch 只发送固定文案，且不记录不透明错误对象。

## 前端凭据生命周期

`ProvidersPanel.vue` 从 GET 动态目录渲染，不硬编码 Provider。Key 草稿只存在组件局部内存，并在以下边界清空：

- 设置关闭或组件卸载
- 当前账号变化
- 保存成功
- 删除操作

草稿不进入 Pinia、URL、console、`localStorage` 或 `sessionStorage`。输入使用 password 控件并关闭拼写修正与自动大小写。保存、测试、删除分别维护 loading/result；弹窗/账号 generation 与每类 operation sequence 共同丢弃迟到结果。保存和删除后重新加载 Provider 状态、展开模型目录与 account preferences。

测试按钮必须提示：可能产生上游费用、触发上游限流并形成 Provider 侧审计记录。删除必须二次确认。

## 部署配置

`.env.template` 提供：

- `PROVIDER_STORED_CREDENTIALS_ENABLED`
- `PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED`
- `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`
- `PROVIDER_CREDENTIAL_WRITE_RATE_LIMIT_MAX`
- `PROVIDER_CREDENTIAL_TEST_RATE_LIMIT_MAX`
- `PROVIDER_CREDENTIAL_RATE_LIMIT_WINDOW_MINUTES`

生产建议先配置加密主密钥并执行迁移，再按 `management=true, stored=false` 预灌/验证，最后开启 stored。加密主密钥轮换必须另行设计 envelope 重加密流程，不能直接替换后重启。

## 验证门禁

交付前依次执行聚焦测试、全仓 lint/typecheck/test/build、空库完整迁移、Compose API/E2E 与 Playwright。浏览器截图前必须清空 Key 输入；禁止生成含 Key 的 screenshot、trace 或 HAR。

真实 Provider smoke 只能在全部 mock 验证完成后走一次 candidate-only 路径，并在前后确认没有新增 session、session entry、session tree、`token_usage` 或个人凭据行；完成后立即撤销临时 Key。

# HEU-53：Provider 状态与模型目录 API

> 状态：已实现；HEU-54 在保持 GET 语义兼容的基础上扩展为当前用户视角。
> 关联实现：`packages/agent/src/models/index.ts`、`packages/agent/src/models/user-provider-service.ts`、`apps/server/src/http/routes/providers.ts`

## 目标

Settings「模型服务」必须能列出全部运行时 Provider，而不仅是当前有凭据的模型。两个只读端点始终注册，并从 `currentUser.id` 创建 user-scoped Provider service：

- `GET /api/providers`
- `GET /api/providers/:providerId/models`

二者均要求登录，所有响应（成功、错误和该前缀下的自然 404）都带 `Cache-Control: no-store`。响应只包含白名单 DTO，不返回 API Key、认证 headers、base URL、密文 envelope 或 pi 内部对象。

## `GET /api/providers`

响应示意：

```json
{
  "defaultProviderId": "deepseek",
  "defaultModelId": "deepseek-v4-flash",
  "capabilities": {
    "storedCredentialsEnabled": true,
    "credentialManagementEnabled": true
  },
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "isDefault": true,
      "configured": true,
      "envVars": ["DEEPSEEK_API_KEY"],
      "note": "面向用户的固定填写指引",
      "modelCount": 1,
      "availableModelCount": 1,
      "runtimeStatus": "ready",
      "statusMessage": null,
      "personalCredential": {
        "status": "stored",
        "keyHint": "abcd",
        "updatedAt": "2026-08-09T00:00:00.000Z"
      },
      "runtimeCredentialSource": "personal"
    }
  ]
}
```

关键字段：

| 字段 | 语义 |
| --- | --- |
| `configured` | `true`=当前运行时能解析凭据；`false`=确认未配置；`null`=状态未知。它不证明远端接受该 Key |
| `runtimeStatus` | `ready` 只表示本地状态检查成功；`degraded` 表示检查异常 |
| `personalCredential.status` | `stored` / `not_stored` / `unknown` / `disabled`，严格区别存储状态未知与确实不存在 |
| `runtimeCredentialSource` | `personal` / `ambient` / `none` / `unknown`，明确下一轮对话实际采用的来源 |
| `capabilities` | 回显两个 kill switch 的有效状态，供 UI 解释“已保存但尚未用于对话”等过渡态 |

当 stored 与 management 都关闭时，服务不读取个人 metadata，`personalCredential.status="disabled"`；runtime 与 HEU-53 R0 相同，只看 global/env。若 management 开启而 stored 关闭，状态端点仍读取 metadata 以支持预灌、测试与删除，但 runtime 仍只使用 global/env。某个 Provider 状态读取失败只降级该项，不拖垮整个列表。

## `GET /api/providers/:providerId/models`

响应示意：

```json
{
  "provider": { "id": "deepseek", "name": "DeepSeek", "isDefault": true },
  "configured": true,
  "runtimeStatus": "ready",
  "statusMessage": null,
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "isDefault": true,
      "available": true
    }
  ]
}
```

- `models` 是静态注册目录，不代表刚从远端刷新。
- `available` 同样是 `true | false | null`；`null` 表示检查失败。
- 未配置但已注册的 Provider 返回 200 和完整目录；未知 Provider 返回 `PROVIDER_NOT_FOUND` / 404。
- `isDefault` 同时比较 Provider 和 Model，避免聚合平台的同名模型被误标。

## Provider 注册事实

Provider 与环境变量提示由 `PROVIDER_CREDENTIAL_HINTS` 维护，并用 parity 测试锁定与运行时注册表一致。目前包含 DeepSeek、SiliconFlow、OpenAI、Anthropic、Google、Moonshot AI、MiniMax、Z.AI、Qwen Token Plan、Ollama、vLLM 共 11 个 Provider。

Ollama/vLLM 的运行时地址不进入 DTO；UI 只消费服务端返回的 `envVars` 与固定说明，不硬编码 Provider 清单。

## 与 HEU-54 的关系

HEU-53 定义只读、安全投影和动态目录；HEU-54 增加普通用户的保存、候选测试、删除、runtime 接线与前端草稿生命周期。写 API、安全模型和部署矩阵见 [HEU-54 普通用户 Provider 凭据](heu54-user-provider-credentials.md)。

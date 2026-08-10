# M3：记忆工具接入（设计）

日期：2026-08-09 · 状态：待实施 · 上级设计：[记忆系统总设计](./2026-08-09-user-memory-design.md)

依赖 **M0**（工具身份上下文与注册表）与 **M2**（embedding 与编排）。
把 `memory_write` / `memory_search` 两个 pi 工具挂上，让模型能读写用户的长期记忆。
这是记忆系统的最后一个切片。

## 1. 核对过的 pi 行为：工具怎么表达失败

> **这一节推翻了总设计与 HEU-13 PRD 里的说法。** 那两处都写着「失败时返回 `isError` 的
> 工具结果，不要抛异常，抛异常会走到 pi 的 `stopReason: "error"` 路径导致整轮对话中断」。
> 对 pi 0.83 而言这是错的，下面是从 dist 核出来的事实。

| # | 事实 | 依据 |
| --- | --- | --- |
| 1 | **`AgentToolResult` 上根本没有 `isError` 字段**。它只有 `content`（必填）、`details`（必填）、`usage?`、`addedToolNames?`、`terminate?` | `dist/types.d.ts:AgentToolResult` |
| 2 | **`execute()` 抛异常是工具表达失败的唯一途径**。pi 在 `try/catch` 里包着调用，捕获后生成 `createErrorToolResult(error.message)` 并置 `isError: true` | `dist/agent-loop.js:467-475` |
| 3 | **抛异常不会中断整轮对话**。它产出一条 `isError` 的 tool result 交回模型，agent loop 照常继续，模型可以据此改口或换个做法 | 同上，`return { result, isError }` 后走正常的 finalize 路径 |
| 4 | `isError` 只出现在 `tool_execution_end` 事件与 `afterToolCall` 钩子上，供观测与覆盖 | `dist/types.d.ts:405`、`dist/harness/types.d.ts:441` |

**推论（本切片的硬约束）**：

- 工具**必须靠 `throw` 表达失败**，不能返回一个自造的 `isError` 字段（类型上就不存在）。
- **`error.message` 会原样进入模型的上下文**。所以异常信息里不能有凭据、provider 的
  原始响应体、或用户的记忆原文——M2 的 `EmbeddingError` 已经按这个约束设计过了，
  本切片不能在工具壳里把它们又拼回去。
- 这条同时印证了 HEU-13 PRD 自己的告诫：「pi 的官方文档在工具这块有缺漏，
  改动前请重新核对而不是相信本节」。

## 2. 两个工具

### `memory_search`

```
参数：query: string
行为：searchMemories(getDb(), { userId: context.userId, query })
```

- `userId` **只来自 `context`**，参数里没有任何身份字段。模型的参数来自对话内容，
  接受模型传身份等价于让用户自己指定读谁的数据。
- `description` 是主要的引导手段（模型主要靠它决定调不调），写明「回答与用户本人
  相关的问题之前先调用」。

### `memory_write`

```
参数：content: string
行为：writeMemory(getDb(), { userId: context.userId, sessionId: context.sessionId, content })
```

- `sourceSessionId` 从 `context.sessionId` 取，不由模型传——它是审计维度，
  让模型填等于让它可以伪造来源。
- `description` 里要写清楚**什么该记**（稳定的偏好、身份、正在做的事）
  和**什么不该记**（一次性的问题、临时的上下文、敏感凭据）。

## 3. 注册表的条件注册

未配置 `EMBEDDING_API_KEY` 时，两个记忆工具**不进注册表**——模型看不到它们。

```ts
// packages/agent/src/tools/index.ts
const ALL: readonly PetrelTool[] = [
  currentTime,
  // 未配置 embedding 时不注册：模型看到一个必然失败的工具会反复重试，
  // 每次重试都是一次真实的模型调用
  ...(isEmbeddingConfigured() ? [memorySearch, memoryWrite] : []),
];
```

`env` 在进程启动时求值一次，所以模块加载期判断即可，不需要每次装配重算。

**依赖方向**：`packages/agent` → `packages/memory` → `packages/database`。
不构成循环（`packages/memory` 不认识 `packages/agent`）。
要给 `packages/agent/package.json` 加 `@petrel/memory` 依赖并在 `tsconfig.json` 的
`references` 里加一项。

## 4. 工具结果的形状

HEU-13 R5 的前端渲染契约：`apps/web/src/utils/toolCall.js` 的 `extractToolResultText()`
**只取 `content` 里 `type === "text"` 的块**，`details` 目前没有消费方。

所以：**结构化结果必须序列化进 `content` 的文本块**，只放 `details` 的话前端拿不到。
`details` 仍然要填（给日志与将来的工作区面板），只是不能只填它。

```jsonc
// memory_search 的 content 文本块
{ "query": "他在做什么项目", "memories": [{ "content": "...", "similarity": 0.82 }] }
```

记忆的结果形状不匹配任何现成卡片（`WebSearchResult.vue` 要 `query` + `results`），
会走默认的 `<pre>` 分支。**这是可接受的**——本切片不为它做前端适配，
硬凑成 `results` 去命中搜索卡片会让用户看到一个语义错误的界面。

## 5. 系统提示

`DEFAULT_SYSTEM_PROMPT` 加一句引导，让模型知道有长期记忆这回事。

**已知限制**：用户在设置里自定义了 system prompt 后，这句引导就没有了
（`user_preferences.systemPrompt` 是整体替换）。不为此在用户的 prompt 上追加内容——
偷偷改用户写的提示词比丢一句引导更糟。工具的 `description` 是主要引导手段，
它不受这个影响。

## 6. 失败语义

| 场景 | 行为 |
| --- | --- |
| 未配置 embedding | 工具不在注册表里，模型看不到 |
| embedding 不可用 / 超时 / 维度不符 | 工具 `throw EmbeddingError`；pi 捕获成 `isError` 的 tool result，模型据此作答，**对话不中断** |
| 记忆条数超上限 | `throw MemoryQuotaError`，消息里写明「请先删除一些记忆」——它会被模型看到并转述给用户 |
| 数据库写入失败 | 异常上抛，同上 |
| 用户点停止 | `context` 之外还拿到了 `signal`，透传给 `searchMemories` / `writeMemory` |

## 7. 验收标准

1. `fauxProvider` 跑真实 agent loop：模型调 `memory_write`，记忆落库；再调
   `memory_search`，拿到刚写的那条。
2. **跨用户隔离**：用 A 的 `toolContext` 写一条，换成 B 的 `toolContext` 检索，B 搜不到。
3. 未配置 `EMBEDDING_API_KEY` 时 `listToolNames()` 不含 `memory_search` / `memory_write`。
4. embedding 失败时 `tool_execution_end` 的 `isError` 为 true，且 `agent_end` 仍然发出
   （对话没有中断）。
5. 条数超上限时同上，且错误信息里带着「删除」这个可执行的建议。
6. `memory_search` 的结果 JSON 出现在 `content` 的文本块里，不是只在 `details`。
7. `pnpm run lint` / `typecheck` / `test` / `build` 全绿。

## 8. 明确不做

| 不做 | 理由 |
| --- | --- |
| `memory_update` / 自动去重 | 总设计已列为非目标。模型重复写同一件事的严重程度要实测了才知道 |
| 常驻上下文注入 | 总设计已列为非目标。若验收 1 显示模型根本不去搜，再补——表结构不用动 |
| 为记忆结果做前端卡片 | 见 §4 |
| 在用户自定义 system prompt 上追加记忆引导 | 见 §5 |
| 工具调用的 embedding 成本计入配额 | 总设计已列为非目标 |

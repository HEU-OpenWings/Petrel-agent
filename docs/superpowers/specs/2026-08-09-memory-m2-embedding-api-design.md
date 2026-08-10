# M2：embedding 与编排（设计）

日期：2026-08-09 · 状态：待实施 · 上级设计：[记忆系统总设计](./2026-08-09-user-memory-design.md)

依赖 M1（存储地基）。把记忆系统接上真实 embedding，并让**用户**能看到与删除自己的记忆。
模型还看不到记忆——那是 M3。

本切片交付后，记忆系统对用户已经是可见、可控、可删的，只是还没有 agent 参与。
这个顺序是有意的：**在模型能往里写之前，用户先要有能力看和删**。

## 1. 配置

凭据与地址经 `packages/config`，**不在客户端里读 `process.env`**——
pi-ai 直读 env 的那个例外只给模型凭据，embedding 不属于它。

```
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_TIMEOUT_MS=10000
MEMORY_MAX_PER_USER=200
MEMORY_SEARCH_LIMIT=5
```

**不设 `EMBEDDING_DIM`**（与总设计初稿不同，这里收敛了）：维度是表的列宽，
换模型就得全量重建索引，做成运行时可配等于允许配出一个必然 INSERT 失败的组合。
改为在 `packages/database/src/schema.ts` 导出 `MEMORY_EMBEDDING_DIM = 1024`，
列定义与 embedding 客户端的响应校验共用这一个常量，改它必然同时改到两边。

`MEMORY_MAX_PER_USER` 默认 200，是**成本闸门**：embedding 按次计费而写入由模型驱动
（M3 之后），没有上限等于成本可被无限放大。

## 2. embedding 客户端

```ts
// packages/memory/src/embedding/client.ts
export class EmbeddingError extends Error {}

/** 未配置 API key 时为 false。M3 据此决定记忆工具进不进注册表 */
export function isEmbeddingConfigured(): boolean;

/** 批量。返回顺序与入参一一对应 */
export function embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
```

硅基流动的接口是 OpenAI 兼容的 `POST {baseUrl}/embeddings`：

```json
{ "model": "BAAI/bge-m3", "input": ["文本一", "文本二"], "encoding_format": "float" }
```

响应 `{ data: [{ index, embedding }], usage }`。

实现要点：

- **按 `index` 排序后再返回**。OpenAI 的响应实践上是有序的，但这是实现细节不是契约；
  乱序会让「记忆 A 的内容配上记忆 B 的向量」——这种错不会报错，只会让检索永远不准。
- **逐条校验维度等于 `MEMORY_EMBEDDING_DIM`**，不符就抛 `EmbeddingError`。
  这条同时兜住了「bge-m3 的 dense 维度是不是 1024」这个待核实项：
  配错模型的表现是启动后第一次写入就明确报错，而不是运行期 INSERT 失败。
- **超时**用 `AbortSignal.timeout(env.embedding.timeoutMs)`，与调用方传入的 signal
  经 `AbortSignal.any([...])` 合并（Node 24 原生支持），用户点停止时能真的停下来。
- 非 2xx 与网络错误一律包成 `EmbeddingError`，**不把响应体原样透传**——
  provider 的错误响应可能回显请求内容，那里面有用户的记忆原文。

`packages/memory` 里**不出现任何 pi 类型**：本包只导出纯函数，
`memory_write` / `memory_search` 的工具壳在 `packages/agent`（M3）。

## 3. 编排

```ts
// packages/memory/src/write.ts
export function writeMemory(
  db: Database,
  params: { userId: string; sessionId: string | null; content: string },
  options?: { signal?: AbortSignal },
): Promise<Memory>;

// packages/memory/src/search.ts
export function searchMemories(
  db: Database,
  params: { userId: string; query: string; limit?: number },
  options?: { signal?: AbortSignal },
): Promise<MemorySearchHit[]>;
```

`writeMemory` 的顺序是**先查数再 embed**：条数超限时不该先花一次 embedding 的钱。

两个函数都只做编排，SQL 全在 `@petrel/database` 的 repository 里。
它们抛 `EmbeddingError` / `MemoryQuotaError`，**不返回错误码**——
翻译成「工具的 isError 结果」是 M3 工具壳的事，翻译成 HTTP 状态码是路由的事。
这一层不该知道调用者是谁。

## 4. REST

挂在 `requireAuth` 之后（`apps/server/src/http/app.ts` 里只有 `system` 和 `auth` 是公开前缀）。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/memories` | 列出当前用户的全部记忆，按创建时间倒序。不含 embedding |
| DELETE | `/api/memories/:id` | 删自己的；不存在或不属于自己一律 **404** |

**不做 POST / PUT**：v1 的写入路径只有模型（M3），用户手动新增记忆是另一个产品决定，
现在加等于替将来做主。用户需要「加一条记忆」时可以直接跟 agent 说。

删别人的返回 404 而不是 403：403 会泄漏「这个 id 存在」。

## 5. 前端

设置弹窗（`apps/web/src/components/settings/SettingsModal.vue`）新增「记忆」tab，
对应一个 `MemoriesPanel.vue`：列表 + 单条删除。

**面板上必须写清楚一句话**：删除会话不会删除由它产生的记忆。
这是 `source_session_id` 不做级联外键的直接后果（总设计 §5），
不写出来就是隐私暗坑——用户会以为删了会话就删干净了。

未配置 embedding 时列表必然为空，面板给一句「未配置记忆功能」而不是空列表。

## 6. 失败语义（本切片相关的部分）

| 场景 | 行为 |
| --- | --- |
| 未配置 `EMBEDDING_API_KEY` | `isEmbeddingConfigured()` 返回 false。REST 仍可用（列表为空、删除正常），只是没有东西可写 |
| embedding 非 2xx / 超时 / 网络错误 | 抛 `EmbeddingError`，**不落库**。不把 provider 的响应体透传出去 |
| 维度不符 | 抛 `EmbeddingError`，不落库 |
| 条数超 `MEMORY_MAX_PER_USER` | 抛 `MemoryQuotaError`，**在 embed 之前**就抛 |
| 删不存在 / 不属于自己的记忆 | 404 |

## 7. 验收标准

1. `embed()` 把乱序返回的 `data` 按 `index` 排回原顺序（打桩一个 index 倒置的响应）。
2. `embed()` 遇到维度不符抛 `EmbeddingError`，且错误信息里不含请求文本。
3. `embed()` 响应超时或调用方 `signal` 中止时抛错，不悬挂。
4. `writeMemory` 在条数已达上限时抛 `MemoryQuotaError`，且**没有发起 embedding 请求**。
5. `writeMemory` 在 embedding 失败时不落库（库里条数不变）。
6. `GET /api/memories` 只返回自己的，响应体里没有 `embedding` 字段。
7. `DELETE /api/memories/:id` 删别人的返回 404，且那条记忆仍在。
8. 无 cookie 访问 `/api/memories` 返回 401（接进 `routes/isolation.test.ts`）。
9. 设置弹窗能列出并删除记忆，面板上有会话删除的说明文案。
10. `pnpm run lint` / `typecheck` / `test` / `build` 全绿。

## 8. 明确不做

| 不做 | 归属 |
| --- | --- |
| `memory_write` / `memory_search` 工具 | M3 |
| 系统提示里的检索引导 | M3 |
| 用户手动新增/编辑记忆 | 见 §4 |
| embedding 的配额扣减 | 总设计已列为非目标；闸门是条数上限 |
| 真实 pgvector 上的 HNSW 召回验证 | 本切片加一条 `describe.skipIf(!DATABASE_URL)` 的集成测试即可，不做调优 |

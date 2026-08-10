# M0：工具身份上下文与注册表（设计）

日期：2026-08-09 · 状态：待实施 · 上级设计：[记忆系统总设计](./2026-08-09-user-memory-design.md)

记忆系统 4 个切片里的第一个。**本切片不写任何记忆代码**，只把「工具执行时能拿到调用者身份」
这条地基铺好，并给工具建一个显式注册表。做完它，M3 的 `memory_search` 才可能是安全的。

对应 HEU-13 的 R1 与 R2（R3 `web_search`、R4 MCP 不在本轮）。

## 1. 问题

`packages/agent/src/harness.ts:33` 的工具类型是 `AgentHarnessTool<undefined>[]`——
工具执行时**完全不知道是谁在调**。今天只有 `get_current_time`（无副作用、与用户无关）
所以看不出问题；`memory_search` 一落地，"查谁的记忆"就只能由**模型传参**决定，
而模型的参数来自对话内容，等价于**让用户自己指定要读谁的数据**。这是标准越权。

同时 `harness.ts:89` 的 `tools: options.tools ?? [currentTime]` 没有注册表：
调用方要么吃默认值，要么自己构造 pi 的工具对象——后者会把 pi 的接线泄漏到 `apps/server`。

**现在做的理由**：这是会牵动 `createHarness` 签名、`compaction.ts`、`harness-registry`
与全部既有工具和测试的破坏性改动。工具只有一个的时候改，比有五个的时候改便宜得多。

## 2. 核对过的 pi 行为（勿凭文档记忆）

全部来自读 `packages/agent/node_modules/@earendil-works/pi-agent-core@0.83.0/dist`。

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | `AgentHarnessTool<TContext>.execute(toolCallId, params, signal, onUpdate, context)`——**context 是第 5 个参数**，不需要自己在闭包里塞 userId | `harness/types.d.ts:58` |
| 2 | `AgentHarnessToolContextSource<TContext> = TContext \| (() => TContext \| Promise<TContext>)` | `harness/types.d.ts:63` |
| 3 | **`TContext` 一旦不是 `undefined`，`toolContext` 就是必填**（`AgentHarnessOptions` 里的条件类型分支） | `harness/types.d.ts:673-679` |
| 4 | `AgentHarness<TContext, ...>` 是泛型类；`getTools(): TTool[]`、`setTools(tools, activeToolNames?)` | `harness/agent-harness.d.ts:4,75,76` |

事实 3 很关键：**类型系统会强制每个装配点传身份**，漏传是编译错误而不是运行期越权。

## 3. 接口设计

### 3.1 上下文类型

```ts
// packages/agent/src/tools/context.ts
export interface AgentToolContext {
  readonly userId: string;
  readonly sessionId: string;
}

export type PetrelTool = AgentHarnessTool<AgentToolContext>;
```

只放工具真正需要的最小信息。**不把整个 user 对象塞进去**——工具不需要 email / role，
多一个字段就多一份泄漏面。

### 3.2 注册表

```ts
// packages/agent/src/tools/index.ts
export function buildRegistry(tools: readonly PetrelTool[]): Map<string, PetrelTool>;
export function listToolNames(): string[];
export function selectTools(names?: readonly string[]): PetrelTool[];
export const DEFAULT_TOOL_NAMES: readonly string[];
```

- **显式 TS 注册表，不做目录扫描**（v0.4 的「目录扫描 + `metadata.toml`」已决定不迁）。
- **重名在建表时抛错**。两个工具同名时模型调到哪个是不确定的，静默覆盖会让
  「工具行为突然变了」无从排查。`buildRegistry` 被单独导出就是为了能测这条——
  真实注册表没有重名，不导出纯函数就只能靠制造一次启动失败来验证。
- **选未注册的名字也抛错**，不静默丢弃：静默丢弃的表现是「工具没生效」，排查成本极高。

### 3.3 `createHarness` 签名

```ts
export interface CreateHarnessOptions {
  session: Session;
  /** 必填。必须是函数，理由见 §4 */
  toolContext: () => AgentToolContext;
  /** 从注册表按名字选子集；不传用全量 */
  toolNames?: readonly string[];
  /** 测试口子：直接注入工具实例，覆盖 toolNames。生产调用方一律用 toolNames */
  tools?: readonly PetrelTool[];
  systemPrompt?: string;
  models?: Models;
  model?: Model<Api>;
  modelId?: string;
}

export type PetrelHarness = AgentHarness<AgentToolContext>;
export function createHarness(options: CreateHarnessOptions): PetrelHarness;
```

- 旧的 `tools?: AgentHarnessTool<undefined>[]` 被 `toolNames` 取代。保留一个
  **窄口径的 `tools` 测试口子**，与文件里既有的 `model?` 口子同性质
  （`harness.ts:47` 那段注释已经确立了这个模式）：注册表按名字选，
  测试要验证「工具能拿到当轮身份」就必须能塞探针工具进去，
  而把探针注册进全局注册表会污染生产工具列表。
- `createHarness` 的返回类型从 `AgentHarness` 变成 `PetrelHarness`。
  **连带影响**：`packages/agent/src/compaction.ts:192,210,284` 三处签名吃的是
  `AgentHarness`（默认泛型 `undefined`），不改会 typecheck 失败。

## 4. 为什么 `toolContext` 必须是函数

pi 允许静态对象。本项目**一律用函数形式**，但理由要说准，不要照搬 HEU-13 PRD 的说法：

- **今天 `userId` 对一个会话是不变的**。`harness-registry.acquire()` 在装配之前
  就用 `sessionRepo.upsert()` 做了归属校验（`harness-registry.ts:410-424`），
  不属于自己的会话直接抛 `forbidden`，走不到 `acquireEntry`。
  所以**防跨用户泄漏的是归属校验，不是函数形式**。
- 函数形式的真实价值是**防将来**：上下文将来若加入按请求变化的字段
  （requestId、当轮的 thinkingLevel、请求级的功能开关），静态值会把首次装配
  那一刻的快照冻死在一个常驻实例上，而这类 bug 极难复现。
- 成本为零，所以现在就定死这个形状，不留「以后再说」。

M0 的核心测试用例就是钉这个契约：同一个常驻 harness，换一次身份再跑一轮，
断言工具拿到的是新身份。

## 5. 验收标准

1. `buildRegistry([a, a])` 抛「工具名重复」，`selectTools(["nope"])` 抛「工具未注册」。
2. 同一个常驻 harness 实例连跑两轮，中间换掉 `toolContext` 函数的返回值，
   工具第二轮拿到的是**新** `userId`（静态值会在这里返回旧的——那正是越权的形状）。
3. `harness-registry` 的两个装配点（`build()` 与 `ephemeral()`）都传了 `toolContext`，
   且 `ephemeral` 拿到了 `userId`（当前签名没有这个参数，要加）。
4. `pnpm run lint` / `typecheck` / `build` 全绿；
   `pnpm vitest run --exclude '**/.claude/**'` 不少于改动前的 681 passed。

## 6. 明确不做

| 不做 | 归属 |
| --- | --- |
| `web_search` | HEU-13 R3 |
| MCP server 适配 | HEU-13 R4 |
| 按会话动态 `setTools()` 与 `active_tools_change` 条目 | 接口留出（`toolNames`），真正按会话变更等 HEU-12 |
| 把 `userId` 之外的身份信息（email / role）放进上下文 | 工具不需要 |
| 工具调用的人工审批（HITL） | HEU-8 / HEU-14 |

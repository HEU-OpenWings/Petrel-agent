# M0：工具身份上下文与注册表 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pi 工具在执行时能拿到调用者的 `userId` / `sessionId`，并把工具收进一个重名即失败的显式注册表。

**Architecture:** 把 `createHarness` 的 `TContext` 从 `undefined` 换成 `AgentToolContext`，pi 的类型系统随即强制每个装配点必须传 `toolContext`（漏传是编译错误，不是运行期越权）。工具不再由调用方构造，改为从 `packages/agent/src/tools/index.ts` 的注册表按名字选，`apps/server` 因此不需要碰任何 pi 类型。

**Tech Stack:** TypeScript ESM · `@earendil-works/pi-agent-core@0.83.0` · Vitest · pi 自带的 `fauxProvider` + `InMemorySessionRepo`

**设计依据：** [M0 设计](../specs/2026-08-09-memory-m0-tool-context-design.md) · [记忆系统总设计](../specs/2026-08-09-user-memory-design.md)

**跑命令前置：** 本机 Git Bash 每次执行 `pnpm` 前都要先 `export PATH="/c/Program Files/nodejs:$PATH"`，否则报 `'node' is not recognized`。仓库根跑全量测试要加 `--exclude '**/.claude/**'`。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/agent/src/tools/context.ts`（新建） | `AgentToolContext` 与 `PetrelTool` 两个类型，无逻辑 |
| `packages/agent/src/tools/index.ts`（新建） | 工具注册表：建表、重名校验、按名字选子集 |
| `packages/agent/src/tools/index.test.ts`（新建） | 注册表的行为测试 |
| `packages/agent/src/tools/current-time.ts`（改） | 换成 `PetrelTool` 类型 |
| `packages/agent/src/harness.ts`（改） | `CreateHarnessOptions` 加 `toolContext` / `toolNames` / `tools`；返回 `PetrelHarness` |
| `packages/agent/src/compaction.ts`（改） | 3 处 `AgentHarness` 签名换成 `PetrelHarness` |
| `packages/agent/src/index.ts`（改） | 导出 `AgentToolContext` / `PetrelTool` / `PetrelHarness` / 注册表函数 |
| `packages/agent/src/harness.test.ts`（改） | 适配新签名 + 新增「按 turn 解析身份」用例 |
| `apps/server/src/services/harness-registry.ts`（改） | 两个装配点注入 `toolContext`；`ephemeral()` 加 `userId` 参数 |

---

## Task 1：工具上下文类型与注册表

**Files:**
- Create: `packages/agent/src/tools/context.ts`
- Create: `packages/agent/src/tools/index.ts`
- Test: `packages/agent/src/tools/index.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/agent/src/tools/index.test.ts`：

```ts
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { PetrelTool } from "./context.ts";
import { buildRegistry, listToolNames, selectTools } from "./index.ts";

function fakeTool(name: string): PetrelTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

describe("工具注册表", () => {
  // 同名时模型调到哪个是不确定的，静默覆盖会让「工具行为突然变了」无从排查
  it("重名工具在建表时抛错，而不是静默覆盖", () => {
    expect(() => buildRegistry([fakeTool("dup"), fakeTool("dup")])).toThrow("工具名重复：dup");
  });

  it("内置工具在注册表里", () => {
    expect(listToolNames()).toContain("get_current_time");
  });

  it("按名字选子集", () => {
    expect(selectTools(["get_current_time"]).map((tool) => tool.name)).toEqual(["get_current_time"]);
  });

  // 静默丢弃的表现是「工具没生效」，排查成本远高于直接抛错
  it("选未注册的名字抛错", () => {
    expect(() => selectTools(["nope"])).toThrow("工具未注册：nope");
  });

  it("不传名字时给全量", () => {
    expect(selectTools()).toHaveLength(listToolNames().length);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/tools/index.test.ts
```

Expected: FAIL，报 `Failed to resolve import "./context.ts"`。

- [ ] **Step 3: 写 `context.ts`**

创建 `packages/agent/src/tools/context.ts`：

```ts
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";

/**
 * 工具执行时可见的调用者身份。
 *
 * 只放工具真正需要的最小信息：工具不需要 email / role，多一个字段就多一份泄漏面。
 * 任何读用户数据的工具必须用这里的 userId 收窄，**不接受模型传参**——模型的参数
 * 来自对话内容，等价于让用户自己指定读谁的数据。
 */
export interface AgentToolContext {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * 本项目所有工具的统一类型。
 *
 * TContext 一旦不是 undefined，pi 的 AgentHarnessOptions 就把 toolContext 变成必填
 * （harness/types.d.ts:673-679 的条件类型），于是「漏传身份」是编译错误而不是运行期越权。
 */
export type PetrelTool = AgentHarnessTool<AgentToolContext>;
```

- [ ] **Step 4: 写 `tools/index.ts`**

创建 `packages/agent/src/tools/index.ts`：

```ts
import type { PetrelTool } from "./context.ts";
import { currentTime } from "./current-time.ts";

/**
 * 显式注册表，不做目录扫描（v0.4 的「目录扫描 + metadata.toml」已决定不迁）。
 * 新增内置工具在这里加一行。
 */
const ALL: readonly PetrelTool[] = [currentTime];

/**
 * 建名字索引，重名直接抛。
 *
 * 单独导出而不是内联在下面那行：真实注册表不会有重名，不暴露这个纯函数就只能
 * 靠制造一次启动失败来验证这条约束，测不了。
 */
export function buildRegistry(tools: readonly PetrelTool[]): Map<string, PetrelTool> {
  const byName = new Map<string, PetrelTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`工具名重复：${tool.name}`);
    }
    byName.set(tool.name, tool);
  }
  return byName;
}

// 模块加载即建表：重名等于进程启动失败，不会带着一个不确定的工具列表跑起来
const BY_NAME = buildRegistry(ALL);

export const DEFAULT_TOOL_NAMES: readonly string[] = ALL.map((tool) => tool.name);

export function listToolNames(): string[] {
  return [...BY_NAME.keys()];
}

/** 按名字选工具子集。名字不在注册表里就抛——静默丢弃会让「工具没生效」无从排查。 */
export function selectTools(names: readonly string[] = DEFAULT_TOOL_NAMES): PetrelTool[] {
  return names.map((name) => {
    const tool = BY_NAME.get(name);
    if (!tool) {
      throw new Error(`工具未注册：${name}，可选值为 ${listToolNames().join(" | ")}`);
    }
    return tool;
  });
}
```

- [ ] **Step 5: 把 `current-time.ts` 换成 `PetrelTool`**

修改 `packages/agent/src/tools/current-time.ts`，只改前两行的 import 与类型标注：

```ts
import { Type } from "@earendil-works/pi-ai";
import type { PetrelTool } from "./context.ts";

/** 极简工具，用于验证「LLM → 工具 → LLM」的完整循环：无外部依赖、无副作用。 */
export const currentTime: PetrelTool = {
  name: "get_current_time",
  label: "当前时间",
  description: "获取当前时间，返回 ISO 8601 格式的 UTC 时间字符串",
  parameters: Type.Object({}),
  execute: async () => {
    const now = new Date().toISOString();
    return { content: [{ type: "text", text: now }], details: { now } };
  },
};
```

它不读用户数据，所以不声明 `context` 形参——TS 允许实现比签名少写参数。

- [ ] **Step 6: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/tools/index.test.ts
```

Expected: PASS，5 个用例全过。

- [ ] **Step 7: 提交**

```bash
git add packages/agent/src/tools
git commit -m "feat(agent): 新增工具身份上下文类型与显式注册表

AgentToolContext 只带 userId 与 sessionId。注册表重名在建表时即抛，
不静默覆盖——同名工具模型调到哪个是不确定的。buildRegistry 单独导出
是为了能测这条约束，真实注册表没有重名。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2：改造 `createHarness` 签名

**Files:**
- Modify: `packages/agent/src/harness.ts`
- Modify: `packages/agent/src/compaction.ts:192,210,284`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: 改 `harness.ts`**

替换 `packages/agent/src/harness.ts` 顶部的 import 与 `CreateHarnessOptions`：

```ts
import { AgentHarness, InMemorySessionRepo, Session } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Database } from "@petrel/database";
import { defaultModel, models as defaultModels, findModel, listModels } from "./models/index.ts";
import { PgSessionStorage } from "./session/pg-storage.ts";
import type { AgentToolContext, PetrelTool } from "./tools/context.ts";
import { selectTools } from "./tools/index.ts";

/** 带身份上下文的 harness。createHarness 的返回类型，也是 apps/server 持有的类型。 */
export type PetrelHarness = AgentHarness<AgentToolContext>;
```

注意 `AgentHarnessTool` 这个 import 要删掉（已由 `PetrelTool` 取代），
`currentTime` 的 import 也要删（默认工具改由注册表提供）。

接着替换 `CreateHarnessOptions`：

```ts
export interface CreateHarnessOptions {
  /** 会话状态的载体。生产用 createPgSession()，测试用 InMemorySessionRepo。 */
  session: Session;
  /**
   * 工具执行时的调用者身份来源。**必须是函数**。
   *
   * pi 允许静态对象，本项目一律用函数形式。理由不是「防跨用户泄漏」——
   * 那件事由 harness-registry.acquire() 的归属校验负责，它在装配之前就挡住了越权。
   * 函数形式防的是将来：上下文若加入按请求变化的字段（requestId、请求级开关），
   * 静态值会把首次装配那一刻的快照冻死在常驻实例上，而这类 bug 极难复现。
   */
  toolContext: () => AgentToolContext;
  /** 从注册表按名字选工具子集；不传用全量。上层因此不需要构造 pi 的工具对象。 */
  toolNames?: readonly string[];
  /**
   * 直接注入工具实例，覆盖 toolNames。
   *
   * 与下方 `model` 同性质的测试口子：注册表按名字选，测试要验证「工具能拿到当轮身份」
   * 就必须能塞探针工具进去，而把探针注册进全局注册表会污染生产工具列表。
   * 生产调用方一律用 toolNames。
   */
  tools?: readonly PetrelTool[];
  /** 初始系统提示；常驻实例后续可通过 before_agent_start hook 按 run 覆盖。 */
  systemPrompt?: string;
  /** 模型集合，测试注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 models/ 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent，且 pi 的接线只允许出现在 agent 这个 package。
   */
  modelId?: string;
}
```

最后替换 `createHarness` 函数体：

```ts
export function createHarness(options: CreateHarnessOptions): PetrelHarness {
  const models = options.models ?? defaultModels;
  return new AgentHarness<AgentToolContext>({
    session: options.session,
    models,
    model: resolveModel(options),
    tools: [...(options.tools ?? selectTools(options.toolNames))],
    toolContext: options.toolContext,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  });
}
```

`[...]` 展开是必需的：pi 的 `tools?: TTool[]` 要可变数组，`readonly PetrelTool[]` 不能直接传。

- [ ] **Step 2: 改 `compaction.ts` 的 3 处签名**

`createHarness` 现在返回 `AgentHarness<AgentToolContext>`，它不能赋给
`AgentHarness`（默认泛型 `undefined`）。改 `packages/agent/src/compaction.ts`：

- 第 2 行的 `type AgentHarness` import 保留（`AgentHarnessError` 仍要用），
  另加 `import type { PetrelHarness } from "./harness.ts";`
- `:192`、`:210` 的 `harness: AgentHarness` → `harness: PetrelHarness`
- `:284` 的 `isContextOverflow(harness: AgentHarness, ...)` → `harness: PetrelHarness`

- [ ] **Step 3: 改 `packages/agent/src/index.ts` 的导出**

在既有导出旁加上：

```ts
export type { AgentToolContext, PetrelTool } from "./tools/context.ts";
export { buildRegistry, DEFAULT_TOOL_NAMES, listToolNames, selectTools } from "./tools/index.ts";
```

并把 `./harness.ts` 那一行的导出列表加上 `type PetrelHarness`。

- [ ] **Step 4: 跑 typecheck 确认只剩预期的破坏点**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run typecheck
```

Expected: FAIL。报错应集中在两处且都是「缺少 toolContext」：
`packages/agent/src/harness.test.ts`（Task 3 修）与
`apps/server/src/services/harness-registry.ts`（Task 4 修）。
若出现别的报错，说明改漏了 `compaction.ts` 或 `index.ts`。

- [ ] **Step 5: 不提交，直接进 Task 3**

此时代码不能编译，Task 3、4 修完再一起提交。

---

## Task 3：harness 测试适配 + 钉住「按 turn 解析身份」

**Files:**
- Modify: `packages/agent/src/harness.test.ts`

- [ ] **Step 1: 给既有的 `fauxHarness` 与 `memorySession` 加上 `toolContext`**

`harness.test.ts:22` 的 `createHarness({ session, models, model: faux.getModel() })` 改成：

```ts
  const harness = createHarness({
    session,
    models,
    model: faux.getModel(),
    toolContext: () => ({ userId: "test-user", sessionId: SESSION_ID }),
  });
```

`describe("createHarness 的模型解析")` 里的 5 处 `createHarness({ session: ... })` 同样
补上 `toolContext: () => ({ userId: "test-user", sessionId: SESSION_ID })`。
其中 `:119` 那一处是 `expect(() => createHarness({...})).toThrow("模型未注册")`，
补参数后行为不变（`resolveModel` 在构造 `AgentHarness` 之前抛）。

- [ ] **Step 2: 写新的失败测试**

在 `harness.test.ts` 末尾追加：

```ts
/**
 * 这一组守的是 M0 的核心契约：toolContext 是按 turn 解析的。
 * harness 按 sessionId 常驻，静态上下文会把首次装配那一刻的身份冻住。
 */
describe("createHarness 的工具上下文", () => {
  /** 探针工具：把每次执行时拿到的 userId 记下来 */
  function probeTool(seen: string[]): PetrelTool {
    return {
      name: "whoami",
      label: "whoami",
      description: "返回调用者的用户 id",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
        seen.push(context.userId);
        return { content: [{ type: "text", text: context.userId }] };
      },
    };
  }

  function whoamiRound() {
    return [
      fauxAssistantMessage([fauxToolCall("whoami", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好")]),
    ];
  }

  it("工具拿到的是当轮的身份，不是装配那一刻的", async () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
    const seen: string[] = [];
    let userId = "user-a";

    const harness = createHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [probeTool(seen)],
      toolContext: () => ({ userId, sessionId: SESSION_ID }),
    });

    faux.setResponses(whoamiRound());
    await harness.prompt("我是谁");
    expect(seen).toEqual(["user-a"]);

    // 同一个常驻实例，换一次请求身份再跑一轮
    userId = "user-b";
    faux.setResponses(whoamiRound());
    await harness.prompt("我是谁");

    // 静态 toolContext 会在这里返回 user-a——那正是越权的形状
    expect(seen).toEqual(["user-a", "user-b"]);
  });

  it("toolNames 选出的子集就是 harness 拿到的工具", async () => {
    const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
    const harness = createHarness({
      session,
      toolNames: ["get_current_time"],
      toolContext: () => ({ userId: "test-user", sessionId: SESSION_ID }),
    });

    expect(harness.getTools().map((tool) => tool.name)).toEqual(["get_current_time"]);
  });
});
```

文件顶部的 import 要补上 `Type`（来自 `@earendil-works/pi-ai`）与
`type PetrelTool`（来自 `./tools/context.ts`）。

- [ ] **Step 3: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/harness.test.ts
```

Expected: PASS，原有 9 个用例 + 新增 2 个。

- [ ] **Step 4: 不提交，直接进 Task 4**

`apps/server` 还没改，全仓 typecheck 仍会失败。

---

## Task 4：harness-registry 注入身份

**Files:**
- Modify: `apps/server/src/services/harness-registry.ts`

- [ ] **Step 1: 换掉 `AgentHarness` 类型引用**

`harness-registry.ts:2` 的 `AgentHarness` 换成 `PetrelHarness`，
并把 `:128`、`:179`、`:199` 三处的 `harness: AgentHarness` 改成 `harness: PetrelHarness`。

- [ ] **Step 2: 在 `build()` 里注入身份**

`harness-registry.ts:279` 的装配改成：

```ts
            harness: createRealHarness({
              session,
              systemPrompt: assembly.systemPrompt,
              modelId: assembly.modelId,
              // 函数形式而非静态对象：见 packages/agent/src/harness.ts 的 toolContext 注释。
              // 这里的 userId 对一个会话是不变的——归属校验在 acquire() 里、装配之前就做过了。
              toolContext: () => ({ userId, sessionId }),
            }),
```

`build(sessionId, userId, createdAt, assembly)` 的签名已经带这两个值，不需要改。

- [ ] **Step 3: 给 `ephemeral()` 加 `userId` 参数**

`ephemeral()` 当前签名是 `(sessionId, assembly)`，作用域里没有 `userId`。
改成：

```ts
  async function ephemeral(
    sessionId: string,
    userId: string,
    assembly: HarnessAssemblyOptions = {},
  ): Promise<HarnessHandle> {
```

并在 `:376` 的装配里加同样的 `toolContext: () => ({ userId, sessionId })`。

调用点只有一处，在 `acquire()` 的降级分支（`:417`），那里 `userId` 在作用域内：

```ts
        return ephemeral(sessionId, userId, assembly);
```

- [ ] **Step 4: 跑全仓 typecheck 确认全绿**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run typecheck
```

Expected: 7 个 project 全部 `Done`，无报错。

- [ ] **Step 5: 跑 lint、全量测试与 build**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run lint
pnpm vitest run --exclude '**/.claude/**'
pnpm run build
```

Expected: lint 无违规；测试不少于 683 passed（原 681 + 新增 2）；build 全过。
若 `apps/server` 的测试有失败，多半是某个测试自己包了一层 `createHarness`
（`chat.test.ts` / `isolation.test.ts` 用 faux provider 时会），照 Task 3 的方式补 `toolContext`。

- [ ] **Step 6: 提交**

```bash
git add packages/agent apps/server/src/services/harness-registry.ts
git commit -m "feat(agent): 工具执行时携带调用者身份，createHarness 从注册表选工具

TContext 从 undefined 换成 AgentToolContext 后，pi 的类型系统强制每个装配点
必须传 toolContext，漏传是编译错误而不是运行期越权。toolContext 一律用函数
形式：防跨用户泄漏靠的是 acquire() 里的归属校验，函数形式防的是将来上下文
加入按请求变化的字段时被常驻实例冻住。

tools 参数由 toolNames 取代，apps/server 因此不再需要构造 pi 的工具对象。
保留一个窄口径的 tools 测试口子，与既有的 model 口子同性质。

连带改动：compaction.ts 三处签名、ephemeral() 新增 userId 参数。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 自查清单

- [ ] `selectTools` 与 `buildRegistry` 的错误信息里都带上了可选值，不是光说「不存在」
- [ ] `current-time.ts` 没有为了「显式接收 context」而加一串下划线形参——它不读用户数据
- [ ] `harness-registry` 的两个装配点都传了 `toolContext`，没有漏掉 `ephemeral`
- [ ] 没有把 `email` / `role` 塞进 `AgentToolContext`
- [ ] 没有顺手实现 `web_search`、MCP 或按会话 `setTools()`——那些不在 M0 范围内

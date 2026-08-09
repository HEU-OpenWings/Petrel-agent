# M3：记忆工具接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型能通过 `memory_write` / `memory_search` 读写当前用户的长期记忆，身份只来自工具上下文。

**Architecture:** 两个工具是薄壳：从 `context` 取 `userId` / `sessionId`，调 `@petrel/memory` 的纯函数，把结果序列化进 `content` 的文本块。失败靠 `throw`——pi 会捕获成 `isError` 的 tool result 并让对话继续。未配置 embedding 时两个工具不进注册表。

**Tech Stack:** `packages/agent`（pi 接线的唯一allowed位置）· `@petrel/memory` · Vitest + pi 的 `fauxProvider`

**依赖：** M0 与 M2 都必须已完成。

**设计依据：** [M3 设计](../specs/2026-08-09-memory-m3-tools-design.md) · [记忆系统总设计](../specs/2026-08-09-user-memory-design.md)

**跑命令前置：** 本机 Git Bash 每次执行 `pnpm` 前都要先 `export PATH="/c/Program Files/nodejs:$PATH"`。仓库根跑全量测试要加 `--exclude '**/.claude/**'`。

> **动手前读一遍 M3 设计的 §1。** 它推翻了总设计与 HEU-13 PRD 里「工具返回 isError、不要抛异常」的说法：`AgentToolResult` 上没有 `isError` 字段，`throw` 才是唯一途径，而且不会中断对话。写代码时不要照着旧说法写。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/agent/package.json`（改） | 加 `@petrel/memory` 依赖 |
| `packages/agent/tsconfig.json`（改） | `references` 加 `../memory` |
| `packages/agent/src/tools/memory-search.ts`（新建） | 检索工具壳 |
| `packages/agent/src/tools/memory-write.ts`（新建） | 写入工具壳 |
| `packages/agent/src/tools/index.ts`（改） | 条件注册两个记忆工具 |
| `packages/agent/src/tools/index.test.ts`（改） | 补条件注册的用例 |
| `packages/agent/src/tools/memory.test.ts`（新建） | `fauxProvider` 端到端 |
| `packages/agent/src/harness.ts`（改） | `DEFAULT_SYSTEM_PROMPT` 加一句引导 |

---

## Task 1：接上包依赖并写两个工具壳

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/agent/tsconfig.json`
- Create: `packages/agent/src/tools/memory-search.ts`
- Create: `packages/agent/src/tools/memory-write.ts`

- [ ] **Step 1: 加依赖**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm --filter @petrel/agent add @petrel/memory@workspace:*
```

依赖方向是 `agent → memory → database`，不构成循环（`packages/memory` 不认识 agent）。

然后在 `packages/agent/tsconfig.json` 的 `references` 数组里加一项：

```json
  "references": [{ "path": "../config" }, { "path": "../database" }, { "path": "../memory" }]
```

- [ ] **Step 2: 写 `memory-search.ts`**

创建 `packages/agent/src/tools/memory-search.ts`：

```ts
import { Type } from "@earendil-works/pi-ai";
import { getDb } from "@petrel/database";
import { searchMemories } from "@petrel/memory";
import type { PetrelTool } from "./context.ts";

/**
 * 检索当前用户的长期记忆。
 *
 * userId 只来自 context，参数里没有任何身份字段——模型的参数来自对话内容，
 * 接受模型传身份等价于让用户自己指定读谁的数据。
 *
 * 失败靠 throw：AgentToolResult 上没有 isError 字段，pi 在 agent-loop.js 的
 * try/catch 里捕获异常并生成 isError 的 tool result，对话不会中断
 * （见 docs/superpowers/specs/2026-08-09-memory-m3-tools-design.md §1）。
 * 所以异常信息里不能有凭据或用户记忆原文——它会原样进模型上下文。
 */
export const memorySearch: PetrelTool = {
  name: "memory_search",
  label: "检索记忆",
  description:
    "检索关于当前用户的长期记忆：偏好、习惯、身份信息、正在做的事。" +
    "在回答任何与用户本人相关的问题之前先调用它，不要只凭当前对话里的信息作答。",
  parameters: Type.Object({
    query: Type.String({ description: "想要回忆的内容，用自然语言描述" }),
  }),
  execute: async (_toolCallId, params, signal, _onUpdate, context) => {
    const hits = await searchMemories(
      getDb(),
      { userId: context.userId, query: params.query },
      { signal },
    );
    const payload = {
      query: params.query,
      memories: hits.map((hit) => ({ content: hit.content, similarity: hit.similarity })),
    };
    // 结构化结果必须序列化进 content 的文本块：apps/web 的 extractToolResultText()
    // 只取 content 里 type === "text" 的块，details 目前没有消费方。
    // details 仍然填，它是给日志与将来的工作区面板用的
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  },
};
```

- [ ] **Step 3: 写 `memory-write.ts`**

创建 `packages/agent/src/tools/memory-write.ts`：

```ts
import { Type } from "@earendil-works/pi-ai";
import { getDb } from "@petrel/database";
import { writeMemory } from "@petrel/memory";
import type { PetrelTool } from "./context.ts";

/**
 * 写一条关于当前用户的长期记忆。
 *
 * sourceSessionId 从 context 取而不是让模型传：它是审计维度，
 * 让模型填等于让它可以伪造来源。
 */
export const memoryWrite: PetrelTool = {
  name: "memory_write",
  label: "记住",
  description:
    "记住一条关于用户的长期信息，之后的对话里都能检索到。" +
    "适合记：稳定的偏好与习惯、身份与职业信息、长期在做的项目、明确说过的约定。" +
    "不要记：一次性的问题、只在本次对话里有意义的上下文、密码或密钥这类凭据、" +
    "以及你自己推测而用户没有确认过的信息。",
  parameters: Type.Object({
    content: Type.String({ description: "要记住的信息，一句话说清楚，不要写成对话片段" }),
  }),
  execute: async (_toolCallId, params, signal, _onUpdate, context) => {
    const memory = await writeMemory(
      getDb(),
      { userId: context.userId, sessionId: context.sessionId, content: params.content },
      { signal },
    );
    const payload = { saved: memory.content };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  },
};
```

- [ ] **Step 4: 跑 typecheck**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run typecheck
```

Expected: 全绿。工具还没进注册表，所以现有测试不受影响。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/package.json packages/agent/tsconfig.json packages/agent/src/tools/memory-search.ts packages/agent/src/tools/memory-write.ts pnpm-lock.yaml
git commit -m "feat(agent): 新增 memory_search 与 memory_write 工具壳

两个都是薄壳：从 context 取身份，调 @petrel/memory 的纯函数。
userId 与 sourceSessionId 都不接受模型传参——前者是越权，后者能伪造来源。

失败靠 throw：AgentToolResult 上没有 isError 字段，pi 在 agent-loop 的
try/catch 里捕获并生成 isError 的 tool result，对话不中断。这与 HEU-13
PRD 里的说法相反，已按 dist 核实并记在 M3 设计 §1。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2：条件注册

**Files:**
- Modify: `packages/agent/src/tools/index.ts`
- Modify: `packages/agent/src/tools/index.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `packages/agent/src/tools/index.test.ts` 顶部加 mock（`vi.hoisted` + getter，
与仓库里 `quota.test.ts` / `chat.test.ts` 同一模式），并追加用例：

```ts
const state = vi.hoisted(() => ({ apiKey: "test-key" }));

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        ...actual.env.embedding,
        get apiKey() {
          return state.apiKey;
        },
      },
    },
  };
});
```

```ts
describe("记忆工具的条件注册", () => {
  // 模型看到一个必然失败的工具会反复重试，每次重试都是一次真实的模型调用
  it("配置了 embedding 时两个记忆工具都在", () => {
    expect(listToolNames()).toEqual(
      expect.arrayContaining(["memory_search", "memory_write"]),
    );
  });
});
```

「未配置时不注册」这条不能在同一个文件里测——注册表在模块加载期就建好了，
改 `state.apiKey` 已经晚了。改用动态导入单独验证：

```ts
describe("未配置 embedding 时", () => {
  it("记忆工具不进注册表", async () => {
    state.apiKey = "";
    vi.resetModules();
    const fresh = await import("./index.ts");

    expect(fresh.listToolNames()).not.toContain("memory_search");
    expect(fresh.listToolNames()).not.toContain("memory_write");

    state.apiKey = "test-key";
    vi.resetModules();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/tools/index.test.ts
```

Expected: FAIL，`listToolNames()` 里没有 `memory_search`。

- [ ] **Step 3: 改注册表**

`packages/agent/src/tools/index.ts` 的 import 加：

```ts
import { isEmbeddingConfigured } from "@petrel/memory";
import { memorySearch } from "./memory-search.ts";
import { memoryWrite } from "./memory-write.ts";
```

`ALL` 改成：

```ts
const ALL: readonly PetrelTool[] = [
  currentTime,
  // 未配置 embedding 时不注册：模型看到一个必然失败的工具会反复重试，
  // 每次重试都是一次真实的模型调用。env 在进程启动时求值一次，
  // 所以这里在模块加载期判断就够了，不需要每次装配重算
  ...(isEmbeddingConfigured() ? [memorySearch, memoryWrite] : []),
];
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/tools/index.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/tools/index.ts packages/agent/src/tools/index.test.ts
git commit -m "feat(agent): 未配置 embedding 时记忆工具不进注册表

与 web_search 同口径：模型看到一个必然失败的工具会反复重试，
每次重试都是一次真实的模型调用。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3：`fauxProvider` 端到端验证

**Files:**
- Create: `packages/agent/src/tools/memory.test.ts`

- [ ] **Step 1: 写测试**

创建 `packages/agent/src/tools/memory.test.ts`：

```ts
import { type AgentHarnessEvent, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000bb";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  apiKey: "test-key",
}));

// 工具里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        ...actual.env.embedding,
        get apiKey() {
          return state.apiKey;
        },
      },
    },
  };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});
afterAll(() => close?.());
beforeEach(async () => {
  state.apiKey = "test-key";
  await reset();
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  const { users } = await import("@petrel/database");
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await state.db!.insert(users).values({
    id: OTHER_USER_ID,
    email: "other@example.com",
    passwordHash: "!",
  });
});
afterEach(() => vi.unstubAllGlobals());

/** embedding 服务的替身：每次都返回同一个向量，于是任何 query 都能命中任何记忆 */
function stubEmbedding() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: new Array<number>(MEMORY_EMBEDDING_DIM).fill(0.1) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

async function harnessFor(userId: string) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({
    session,
    models,
    model: faux.getModel(),
    toolContext: () => ({ userId, sessionId: SESSION_ID }),
  });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, events };
}

/** 一次「调工具 → 拿结果 → 作答」的完整回合 */
function toolRound(toolName: string, args: Record<string, unknown>) {
  return [
    fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("好的")]),
  ];
}

function toolEnd(events: AgentHarnessEvent[]) {
  return events.filter((event) => event.type === "tool_execution_end");
}

describe("记忆工具跑在真实 agent loop 上", () => {
  it("模型写入的记忆能被自己检索到", async () => {
    stubEmbedding();
    const writer = await harnessFor(TEST_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "用户在做 Petrel 项目" }));
    await writer.harness.prompt("记住我在做 Petrel");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "我在做什么项目" }));
    await reader.harness.prompt("我在做什么项目");

    const end = toolEnd(reader.events).at(0) as { isError: boolean; result: unknown };
    expect(end.isError).toBe(false);
    expect(JSON.stringify(end.result)).toContain("用户在做 Petrel 项目");
  });

  // 这是记忆系统的安全核心
  it("检索不到别人的记忆", async () => {
    stubEmbedding();
    const writer = await harnessFor(OTHER_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "别人的秘密" }));
    await writer.harness.prompt("记住");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "秘密" }));
    await reader.harness.prompt("有什么秘密");

    const end = toolEnd(reader.events).at(0) as { isError: boolean; result: unknown };
    expect(end.isError).toBe(false);
    expect(JSON.stringify(end.result)).not.toContain("别人的秘密");
  });

  /**
   * pi 把 execute() 抛的异常捕获成 isError 的 tool result 并继续跑
   * （agent-loop.js:467-475）。这条同时钉住「工具失败不中断对话」。
   */
  it("embedding 失败时工具报错，但对话不中断", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const { faux, harness, events } = await harnessFor(TEST_USER_ID);
    faux.setResponses(toolRound("memory_search", { query: "任何东西" }));

    await harness.prompt("我是谁");

    const end = toolEnd(events).at(0) as { isError: boolean };
    expect(end.isError).toBe(true);
    // agent loop 照常收尾，模型拿到错误结果后仍然作答了
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });

  it("检索结果的 JSON 在 content 的文本块里，不是只在 details", async () => {
    stubEmbedding();
    const writer = await harnessFor(TEST_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "用户偏好简洁的回答" }));
    await writer.harness.prompt("记住");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "偏好" }));
    await reader.harness.prompt("我的偏好");

    // apps/web 的 extractToolResultText() 只读 content 里的 text 块，
    // 只放 details 的话前端会退回空白
    const end = toolEnd(reader.events).at(0) as { result: { content: { text?: string }[] } };
    expect(end.result.content.map((block) => block.text).join("")).toContain("用户偏好简洁的回答");
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/tools/memory.test.ts
```

Expected: PASS，4 个用例。
若第一条失败且报「记忆内容不能为空」，检查 `fauxToolCall` 的参数是不是被 schema 校验丢掉了。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/tools/memory.test.ts
git commit -m "test(agent): 记忆工具在真实 agent loop 上的端到端验证

不 mock 内部，用 pi 自带的 fauxProvider 跑完整循环，与 harness.test.ts
同一模式。四条分别钉住：写入-检索闭环、跨用户隔离、工具失败不中断对话、
结果 JSON 落在 content 而不是只在 details。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4：系统提示与收尾验证

**Files:**
- Modify: `packages/agent/src/harness.ts:13`

- [ ] **Step 1: 加一句引导**

`packages/agent/src/harness.ts` 的 `DEFAULT_SYSTEM_PROMPT` 改成：

```ts
/**
 * 记忆那一句只对使用默认提示词的用户生效：user_preferences.systemPrompt 是整体替换，
 * 自定义之后这句就没了。不为此在用户写的提示词上偷偷追加内容——
 * 工具的 description 才是主要引导手段，它不受这个影响。
 */
export const DEFAULT_SYSTEM_PROMPT =
  "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。" +
  "你拥有跨会话的长期记忆：回答与用户本人相关的问题前先用 memory_search 回忆，" +
  "用户透露稳定的偏好、身份或长期目标时用 memory_write 记下来。";
```

- [ ] **Step 2: 确认既有断言不受影响**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/agent/src/harness.test.ts
```

Expected: PASS。`harness.test.ts` 里「systemPrompt 传给模型」那条断言的是
`toContain("Petrel")`，改动后仍然成立。

- [ ] **Step 3: 全量验证**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run lint
pnpm run typecheck
pnpm vitest run --exclude '**/.claude/**'
pnpm run build
```

Expected: 全绿。

- [ ] **Step 4: 容器里手动跑一遍**

```bash
docker compose up -d
```

在 `.env` 里配好 `EMBEDDING_API_KEY` 后重建容器，打开 `http://localhost:5173/agent`：

1. 跟 agent 说一句「记住我偏好简洁的回答」，看它是否调用 `memory_write`
2. 新开一个会话问「你还记得我的偏好吗」，看它是否调用 `memory_search` 并答对
3. 打开设置 → 记忆，确认那条记忆在列表里，且能删掉

**第 2 步是总设计 §9 风险 1 的实测**：纯检索没有常驻注入，模型可能根本不去搜。
如果反复试都不调用 `memory_search`，把结果记进总设计的未决问题，
并考虑补「常驻注入最近 N 条」——表结构不用动。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/harness.ts
git commit -m "feat(agent): 默认系统提示加入记忆使用引导

只对使用默认提示词的用户生效：user_preferences.systemPrompt 是整体替换。
不在用户自定义的提示词上偷偷追加——工具的 description 才是主要引导手段。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 自查清单

- [ ] 两个工具都没有从 `params` 里读任何身份字段
- [ ] `memory_write` 的 `sourceSessionId` 来自 `context.sessionId`，不是模型传的
- [ ] 工具用 `throw` 表达失败，没有自造 `isError` 字段（类型上也不存在）
- [ ] 抛出的异常信息里没有凭据、provider 响应体或记忆原文——它会原样进模型上下文
- [ ] `signal` 透传给了 `searchMemories` / `writeMemory`
- [ ] 结果 JSON 在 `content` 的文本块里，`details` 也填了
- [ ] 没有为记忆结果做前端卡片，没有做常驻注入，没有做 `memory_update`

# M2：embedding 与编排 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接上硅基流动的 `BAAI/bge-m3`，让记忆能被真实写入与语义检索，并让用户在设置里看到与删除自己的记忆。

**Architecture:** `packages/memory` 只做两件事——调 embedding HTTP 接口拿向量、把结果交给 `@petrel/database` 的 repository。它不出现任何 pi 类型，也不发 SQL。REST 挂在 `requireAuth` 之后，只读与删除，不提供手动新增。

**Tech Stack:** `packages/memory`（本轮首次写入实现）· `packages/config` · Hono · Vue 3 · Vitest（`vi.mock("@petrel/config")` + `vi.stubGlobal("fetch")`）

**依赖：** M1（存储地基）必须已完成。

**设计依据：** [M2 设计](../specs/2026-08-09-memory-m2-embedding-api-design.md) · [记忆系统总设计](../specs/2026-08-09-user-memory-design.md)

**跑命令前置：** 本机 Git Bash 每次执行 `pnpm` 前都要先 `export PATH="/c/Program Files/nodejs:$PATH"`。仓库根跑全量测试要加 `--exclude '**/.claude/**'`。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/database/src/schema.ts`（改） | 导出 `MEMORY_EMBEDDING_DIM`，列定义改用它 |
| `packages/config/src/index.ts`（改） | `embedding` 与 `memory` 两组配置 |
| `.env.template`（改） | 新配置项与说明 |
| `packages/memory/src/embedding/client.ts`（新建） | HTTP 客户端：排序、维度校验、超时、错误脱敏 |
| `packages/memory/src/embedding/client.test.ts`（新建） | 客户端行为测试 |
| `packages/memory/src/errors.ts`（新建） | `EmbeddingError` / `MemoryQuotaError` |
| `packages/memory/src/write.ts`（新建） | 条数闸门 → embed → insert |
| `packages/memory/src/search.ts`（新建） | embed → KNN |
| `packages/memory/src/write.test.ts` · `search.test.ts`（新建） | 编排层测试 |
| `packages/memory/src/index.ts`（改） | 换成真实导出 |
| `packages/memory/package.json`（改） | 无新增依赖，确认 deps 已有 config/database |
| `apps/server/src/http/routes/memories.ts`（新建） | GET 列表 / DELETE 单条 |
| `apps/server/src/http/routes/memories.test.ts`（新建） | 路由测试 |
| `apps/server/src/http/app.ts`（改） | 挂载路由 |
| `apps/server/src/http/routes/isolation.test.ts`（改） | 加一条「无 cookie → 401」 |
| `apps/web/src/apis/memory_api.js`（新建） | 前端 API |
| `apps/web/src/components/settings/MemoriesPanel.vue`（新建） | 记忆管理面板 |
| `apps/web/src/components/settings/SettingsModal.vue`（改） | 加 tab |

---

## Task 1：配置与维度常量

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `.env.template`

- [ ] **Step 1: 把列宽收敛成常量**

`packages/database/src/schema.ts`，在 `userMemories` 定义**之前**加：

```ts
/**
 * 记忆向量的维度。BAAI/bge-m3 的 dense 输出就是 1024，与 backend-plan 里
 * 知识库的统一列宽一致。
 *
 * 导出而不是写字面量：embedding 客户端要拿它校验响应长度。两处共用一个常量，
 * 改它必然同时改到列定义与校验，不会出现「配了个 768 维的模型，运行期才在
 * INSERT 上报错」。换模型 = 全量重新索引，不是改个环境变量的事。
 */
export const MEMORY_EMBEDDING_DIM = 1024;
```

并把列定义里的 `{ dimensions: 1024 }` 改成 `{ dimensions: MEMORY_EMBEDDING_DIM }`。

> 这不会产生新的 migration：drizzle 看到的仍是 1024。跑一次
> `pnpm --filter @petrel/database run db:generate` 确认输出是「No schema changes」。

- [ ] **Step 2: 加配置**

`packages/config/src/index.ts` 的 `env` 对象里，在 `quotaEnforcement` 之后加：

```ts
  /**
   * 记忆系统的 embedding（硅基流动，OpenAI 兼容端点）。
   *
   * 走 @petrel/config 而非 pi-ai 的 auth 机制：那个例外只给模型凭据，
   * pi-ai 不认识 embedding 端点。
   *
   * 不设 EMBEDDING_DIM：维度是表的列宽（MEMORY_EMBEDDING_DIM），换模型要全量
   * 重建索引，做成运行时可配等于允许配出一个必然 INSERT 失败的组合。
   */
  embedding: {
    baseUrl: stringEnv("EMBEDDING_BASE_URL", process.env.EMBEDDING_BASE_URL, "https://api.siliconflow.cn/v1"),
    apiKey: process.env.EMBEDDING_API_KEY?.trim() ?? "",
    model: stringEnv("EMBEDDING_MODEL", process.env.EMBEDDING_MODEL, "BAAI/bge-m3"),
    timeoutMs: positiveInt("EMBEDDING_TIMEOUT_MS", process.env.EMBEDDING_TIMEOUT_MS, 10_000),
  },
  /**
   * maxPerUser 是成本闸门而不是产品限制：embedding 按次计费，而写入由模型驱动（M3），
   * 没有上限等于成本可被无限放大。
   */
  memory: {
    maxPerUser: nonNegativeInt("MEMORY_MAX_PER_USER", process.env.MEMORY_MAX_PER_USER, 200),
    searchLimit: positiveInt("MEMORY_SEARCH_LIMIT", process.env.MEMORY_SEARCH_LIMIT, 5),
  },
```

- [ ] **Step 3: 补 `.env.template`**

在文件末尾追加：

```bash
# ---- 记忆系统（M2 起生效） ----
# embedding 服务。默认指向硅基流动的 OpenAI 兼容端点。
# 不配 EMBEDDING_API_KEY 时记忆功能整体关闭：模型看不到记忆工具（M3），
# 设置里的记忆列表为空。这是有意的——模型看到一个必然失败的工具会反复重试。
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=
# 换模型 = 全量重新索引：维度必须仍是 1024（见 packages/database 的 MEMORY_EMBEDDING_DIM）
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_TIMEOUT_MS=10000
# 每用户记忆条数上限。成本闸门，不是产品限制
MEMORY_MAX_PER_USER=200
# 单次 memory_search 返回的条数
MEMORY_SEARCH_LIMIT=5
```

- [ ] **Step 4: 验证并提交**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run typecheck
pnpm vitest run packages/database packages/config
git add packages/database/src/schema.ts packages/config/src/index.ts .env.template
git commit -m "feat(config): 新增 embedding 与记忆系统配置

维度不做成环境变量：它是表的列宽，换模型要全量重建索引，可配等于允许
配出一个必然 INSERT 失败的组合。改为 MEMORY_EMBEDDING_DIM 常量，
列定义与响应校验共用。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2：embedding 客户端

**Files:**
- Create: `packages/memory/src/errors.ts`
- Create: `packages/memory/src/embedding/client.ts`
- Test: `packages/memory/src/embedding/client.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/memory/src/embedding/client.test.ts`：

```ts
import { MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError } from "../errors.ts";
import { embed, isEmbeddingConfigured } from "./client.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ apiKey: "test-key", timeoutMs: 10_000 }));

// vi.stubEnv 改不了已导入的 env，所以 mock @petrel/config，用 getter 动态读 state
vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        baseUrl: "https://embedding.test/v1",
        model: "BAAI/bge-m3",
        get apiKey() {
          return state.apiKey;
        },
        get timeoutMs() {
          return state.timeoutMs;
        },
      },
    },
  };
});

function vectorOf(value: number): number[] {
  return new Array<number>(MEMORY_EMBEDDING_DIM).fill(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  state.apiKey = "test-key";
  state.timeoutMs = 10_000;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embed", () => {
  it("未配置 API key 时抛错，且不发请求", async () => {
    state.apiKey = "";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(embed(["你好"])).rejects.toThrow(EmbeddingError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("空数组直接返回，不发请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await embed([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * 乱序不会报错，只会让「记忆 A 的内容配上记忆 B 的向量」，
   * 表现是检索永远不准——所以必须钉住排序。
   */
  it("按 index 排回入参顺序", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: vectorOf(0.2) },
            { index: 0, embedding: vectorOf(0.1) },
          ],
        }),
      ),
    );

    const vectors = await embed(["第一条", "第二条"]);

    expect(vectors[0]?.[0]).toBe(0.1);
    expect(vectors[1]?.[0]).toBe(0.2);
  });

  it("维度不符时抛 EmbeddingError，且错误信息不含请求文本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] })),
    );

    await expect(embed(["用户的私密记忆"])).rejects.toThrow(/维度不符/);
    await expect(embed(["用户的私密记忆"])).rejects.not.toThrow(/私密/);
  });

  it("非 2xx 时抛错，且不透传响应体", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "your input was 用户的私密记忆" }, 500)),
    );

    await expect(embed(["用户的私密记忆"])).rejects.toThrow(/500/);
    await expect(embed(["用户的私密记忆"])).rejects.not.toThrow(/私密/);
  });

  it("返回条数与入参不符时抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: vectorOf(0.1) }] })),
    );

    await expect(embed(["一", "二"])).rejects.toThrow(/条数不符/);
  });

  it("调用方的 signal 中止时抛错", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        controller.abort();
        init.signal?.throwIfAborted();
        return jsonResponse({ data: [] });
      }),
    );

    await expect(embed(["你好"], { signal: controller.signal })).rejects.toThrow(EmbeddingError);
  });
});

describe("isEmbeddingConfigured", () => {
  it("有 key 为 true，无 key 为 false", () => {
    expect(isEmbeddingConfigured()).toBe(true);
    state.apiKey = "";
    expect(isEmbeddingConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/memory/src/embedding/client.test.ts
```

Expected: FAIL，`Failed to resolve import "../errors.ts"`。

- [ ] **Step 3: 写 `errors.ts`**

创建 `packages/memory/src/errors.ts`：

```ts
/**
 * embedding 相关的全部失败。
 *
 * 这一层不返回错误码：翻译成「工具的 isError 结果」是 packages/agent 里工具壳的事，
 * 翻译成 HTTP 状态码是路由的事。编排层不该知道调用者是谁。
 */
export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

/** 记忆条数超过 MEMORY_MAX_PER_USER。成本闸门，不是产品限制 */
export class MemoryQuotaError extends Error {
  override readonly name = "MemoryQuotaError";
}
```

- [ ] **Step 4: 写客户端**

创建 `packages/memory/src/embedding/client.ts`：

```ts
import { env } from "@petrel/config";
import { MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { EmbeddingError } from "../errors.ts";

/** 未配置 key 时为 false。M3 据此决定记忆工具进不进注册表 */
export function isEmbeddingConfigured(): boolean {
  return env.embedding.apiKey !== "";
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * 批量取 embedding，返回顺序与入参一一对应。
 *
 * 与记忆域零耦合：只认「文本进、向量出」，不认 Memory 类型。
 * 知识库（HEU-21）落地时这个目录可以整体平移。
 */
export async function embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
  if (!isEmbeddingConfigured()) {
    throw new EmbeddingError("未配置 EMBEDDING_API_KEY，记忆功能不可用");
  }
  if (texts.length === 0) return [];

  // 自己的超时与调用方的取消合并：用户点停止时要能真的停下来，同时自己也要有上限，
  // 否则一个不响应的 provider 会把请求挂到 Node 的默认超时
  const timeout = AbortSignal.timeout(env.embedding.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(`${env.embedding.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.embedding.apiKey}`,
      },
      body: JSON.stringify({ model: env.embedding.model, input: texts, encoding_format: "float" }),
      signal,
    });
  } catch (error) {
    // 不带上 texts：错误会进日志，记忆原文不该出现在那里
    throw new EmbeddingError(`embedding 请求失败：${(error as Error).message}`);
  }

  if (!response.ok) {
    // 不透传响应体：provider 的错误响应可能回显请求内容，那里面是用户的记忆原文
    throw new EmbeddingError(`embedding 服务返回 ${response.status}`);
  }

  const payload = (await response.json().catch(() => null)) as EmbeddingResponse | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new EmbeddingError(`embedding 返回条数不符：期望 ${texts.length}，实际 ${data?.length ?? 0}`);
  }

  // 按 index 排回原顺序：OpenAI 的响应实践上有序，但那是实现细节不是契约。
  // 乱序会让「记忆 A 的内容配上记忆 B 的向量」——不报错，只是检索永远不准
  const sorted = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  return sorted.map((item, position) => {
    const values = item.embedding;
    if (!Array.isArray(values) || values.length !== MEMORY_EMBEDDING_DIM) {
      throw new EmbeddingError(
        `embedding 维度不符：第 ${position} 条期望 ${MEMORY_EMBEDDING_DIM}，实际 ${values?.length ?? 0}；` +
          `模型 ${env.embedding.model} 可能与 user_memories.embedding 的列宽不匹配`,
      );
    }
    return values;
  });
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/memory/src/embedding/client.test.ts
```

Expected: PASS，8 个用例全过。

- [ ] **Step 6: 提交**

```bash
git add packages/memory/src/errors.ts packages/memory/src/embedding
git commit -m "feat(memory): 新增 embedding 客户端

按 index 排回入参顺序：OpenAI 的响应实践上有序但那是实现细节不是契约，
乱序会让记忆 A 的内容配上记忆 B 的向量——不报错，只是检索永远不准。

错误不透传 provider 响应体、不带上请求文本：那里面是用户的记忆原文，
而错误会进日志。维度校验共用 MEMORY_EMBEDDING_DIM，配错模型的表现是
第一次写入就明确报错。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3：写入与检索编排

**Files:**
- Create: `packages/memory/src/write.ts`
- Create: `packages/memory/src/search.ts`
- Test: `packages/memory/src/write.test.ts`
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/memory/src/write.test.ts`：

```ts
import { createMemoryRepository, MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingError, MemoryQuotaError } from "./errors.ts";
import { searchMemories } from "./search.ts";
import { writeMemory } from "./write.ts";

const state = vi.hoisted(() => ({ apiKey: "test-key", maxPerUser: 200 }));

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        baseUrl: "https://embedding.test/v1",
        model: "BAAI/bge-m3",
        timeoutMs: 10_000,
        get apiKey() {
          return state.apiKey;
        },
      },
      memory: {
        searchLimit: 5,
        get maxPerUser() {
          return state.maxPerUser;
        },
      },
    },
  };
});

function vectorOf(value: number): number[] {
  return new Array<number>(MEMORY_EMBEDDING_DIM).fill(value);
}

/** 每次调用返回同一个向量。返回 fn 便于断言调用次数 */
function stubEmbedding(value: number) {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: vectorOf(value) }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("writeMemory / searchMemories", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
  });
  afterAll(() => testDb.close());
  beforeEach(() => {
    state.apiKey = "test-key";
    state.maxPerUser = 200;
    return testDb.reset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("写入落库，内容与来源会话都存下来", async () => {
    stubEmbedding(0.1);

    const created = await writeMemory(db, {
      userId: TEST_USER_ID,
      sessionId: null,
      content: "用户偏好简洁的回答",
    });

    expect(created.content).toBe("用户偏好简洁的回答");
    expect(await createMemoryRepository(db).countByUserId(TEST_USER_ID)).toBe(1);
  });

  // 先查数再 embed：超限时不该先花一次 embedding 的钱
  it("条数达上限时抛 MemoryQuotaError，且没有发起 embedding 请求", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "第一条" });

    state.maxPerUser = 1;
    const fetchSpy = stubEmbedding(0.1);

    await expect(
      writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "第二条" }),
    ).rejects.toThrow(MemoryQuotaError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 落一条没有向量的记忆等于写了个查不到的东西——静默失效
  it("embedding 失败时不落库", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(
      writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "写不进去的" }),
    ).rejects.toThrow(EmbeddingError);
    expect(await createMemoryRepository(db).countByUserId(TEST_USER_ID)).toBe(0);
  });

  it("空白内容不写库", async () => {
    const fetchSpy = stubEmbedding(0.1);

    await expect(writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "   " })).rejects.toThrow(
      /内容不能为空/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("检索命中自己写入的记忆", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "用户在做 Petrel 项目" });

    stubEmbedding(0.1);
    const hits = await searchMemories(db, { userId: TEST_USER_ID, query: "他在做什么项目" });

    expect(hits.map((hit) => hit.content)).toEqual(["用户在做 Petrel 项目"]);
  });

  it("检索用的是配置里的默认条数上限", async () => {
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "一" });
    stubEmbedding(0.1);
    await writeMemory(db, { userId: TEST_USER_ID, sessionId: null, content: "二" });

    stubEmbedding(0.1);
    expect(await searchMemories(db, { userId: TEST_USER_ID, query: "q", limit: 1 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/memory/src/write.test.ts
```

Expected: FAIL，`Failed to resolve import "./search.ts"`。

- [ ] **Step 3: 写 `write.ts`**

创建 `packages/memory/src/write.ts`：

```ts
import { env } from "@petrel/config";
import { createMemoryRepository, type Database, type Memory } from "@petrel/database";
import { embed } from "./embedding/client.ts";
import { MemoryQuotaError } from "./errors.ts";

/**
 * 单条记忆的长度上限。
 *
 * content 在库里是无长度限制的 text，而写入方是模型——一次工具调用就能塞进
 * 很长的内容，之后每次检索命中都要整份发回上下文。同 routes/account.ts 的
 * SYSTEM_PROMPT_LENGTH_LIMIT。
 */
export const MEMORY_CONTENT_LENGTH_LIMIT = 500;

export interface WriteMemoryParams {
  userId: string;
  /** 来源会话，只作维度记录；null 表示非会话来源 */
  sessionId: string | null;
  content: string;
}

/**
 * 写一条用户级长期记忆。
 *
 * 顺序是**先查数再 embed**：条数超限时不该先花一次 embedding 的钱。
 */
export async function writeMemory(
  db: Database,
  params: WriteMemoryParams,
  options: { signal?: AbortSignal } = {},
): Promise<Memory> {
  const content = params.content.trim();
  if (content === "") {
    throw new Error("记忆内容不能为空");
  }
  if (content.length > MEMORY_CONTENT_LENGTH_LIMIT) {
    throw new Error(`记忆内容不能超过 ${MEMORY_CONTENT_LENGTH_LIMIT} 字`);
  }

  const repo = createMemoryRepository(db);
  const count = await repo.countByUserId(params.userId);
  if (count >= env.memory.maxPerUser) {
    throw new MemoryQuotaError(
      `记忆条数已达上限 ${env.memory.maxPerUser}，请先删除一些不再需要的记忆`,
    );
  }

  const [embedding] = await embed([content], options);
  // embed() 保证返回条数与入参一致，这里只是让类型收窄
  if (!embedding) throw new Error("embedding 返回为空");

  return repo.insert(params.userId, { content, embedding, sourceSessionId: params.sessionId });
}
```

- [ ] **Step 4: 写 `search.ts`**

创建 `packages/memory/src/search.ts`：

```ts
import { env } from "@petrel/config";
import { createMemoryRepository, type Database, type MemorySearchHit } from "@petrel/database";
import { embed } from "./embedding/client.ts";

export interface SearchMemoriesParams {
  userId: string;
  query: string;
  /** 不传用 MEMORY_SEARCH_LIMIT */
  limit?: number;
}

/**
 * 语义检索当前用户的记忆。
 *
 * userId 只能来自调用方的可信上下文（工具的 context / 路由的 currentUser），
 * **不接受模型传参**——模型的参数来自对话内容，等价于让用户自己指定读谁的数据。
 */
export async function searchMemories(
  db: Database,
  params: SearchMemoriesParams,
  options: { signal?: AbortSignal } = {},
): Promise<MemorySearchHit[]> {
  const query = params.query.trim();
  if (query === "") return [];

  const [embedding] = await embed([query], options);
  if (!embedding) throw new Error("embedding 返回为空");

  return createMemoryRepository(db).searchByEmbedding(
    params.userId,
    embedding,
    params.limit ?? env.memory.searchLimit,
  );
}
```

- [ ] **Step 5: 换掉 `index.ts` 的空骨架**

`packages/memory/src/index.ts` 整个替换成：

```ts
/**
 * 用户级长期记忆的 embedding 与检索编排。
 *
 * 边界：
 * - **本包不出现任何 pi 类型**。memory_write / memory_search 的工具定义在
 *   packages/agent/src/tools/，只调用这里导出的纯函数。
 * - **所有 SQL 留在 @petrel/database 的 repository 里**，本包只做编排。
 * - src/embedding/ 与记忆域零耦合，知识库（HEU-21）落地时可整目录平移。
 */
export { embed, isEmbeddingConfigured } from "./embedding/client.ts";
export { EmbeddingError, MemoryQuotaError } from "./errors.ts";
export { searchMemories, type SearchMemoriesParams } from "./search.ts";
export { MEMORY_CONTENT_LENGTH_LIMIT, writeMemory, type WriteMemoryParams } from "./write.ts";
```

- [ ] **Step 6: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/memory
```

Expected: PASS，14 个用例全过（client 8 + write/search 6）。

- [ ] **Step 7: 提交**

```bash
git add packages/memory
git commit -m "feat(memory): 新增记忆的写入与检索编排

writeMemory 先查数再 embed：条数超限时不该先花一次 embedding 的钱。
embedding 失败不落库——落一条没有向量的记忆等于写了个查不到的东西。

两个函数都只抛领域异常不返回错误码：翻译成工具的 isError 是 packages/agent
的事，翻译成 HTTP 状态码是路由的事，这一层不该知道调用者是谁。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4：REST 路由

**Files:**
- Create: `apps/server/src/http/routes/memories.ts`
- Test: `apps/server/src/http/routes/memories.test.ts`
- Modify: `apps/server/src/http/app.ts`
- Modify: `apps/server/src/http/routes/isolation.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/http/routes/memories.test.ts`：

```ts
import { createMemoryRepository, createUserRepository, MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";
import { __resetAuthRateLimits } from "./auth.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

// 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});
beforeEach(() => {
  __resetAuthRateLimits();
  return reset();
});
afterAll(() => close?.());

/** 注册并登录，返回 { cookie, userId } */
async function registerUser(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  const body = (await response.json()) as { user: { id: string } };
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  await createUserRepository(state.db!).setEmailVerified(body.user.id, new Date());
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return { cookie: login.headers.get("set-cookie") ?? "", userId: body.user.id };
}

async function seedMemory(userId: string, content: string): Promise<string> {
  // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
  const created = await createMemoryRepository(state.db!).insert(userId, {
    content,
    embedding: new Array<number>(MEMORY_EMBEDDING_DIM).fill(0.1),
    sourceSessionId: null,
  });
  return created.id;
}

describe("GET /api/memories", () => {
  it("只返回自己的记忆，且不含 embedding", async () => {
    const mine = await registerUser("mine@example.com");
    const other = await registerUser("other@example.com");
    await seedMemory(mine.userId, "我的记忆");
    await seedMemory(other.userId, "别人的记忆");

    const response = await app.request("/api/memories", { headers: { cookie: mine.cookie } });
    const body = (await response.json()) as { memories: { content: string }[] };

    expect(response.status).toBe(200);
    expect(body.memories.map((memory) => memory.content)).toEqual(["我的记忆"]);
    // 1024 个浮点数不该出现在 HTTP 响应里
    expect(body.memories[0]).not.toHaveProperty("embedding");
  });
});

describe("DELETE /api/memories/:id", () => {
  it("能删自己的", async () => {
    const mine = await registerUser("mine@example.com");
    const id = await seedMemory(mine.userId, "我的记忆");

    const response = await app.request(`/api/memories/${id}`, {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(200);
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    expect(await createMemoryRepository(state.db!).listByUserId(mine.userId)).toEqual([]);
  });

  // 403 会泄漏「这个 id 存在」
  it("删别人的返回 404 且那条记忆仍在", async () => {
    const mine = await registerUser("mine@example.com");
    const other = await registerUser("other@example.com");
    const id = await seedMemory(other.userId, "别人的记忆");

    const response = await app.request(`/api/memories/${id}`, {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(404);
    // biome-ignore lint/style/noNonNullAssertion: test db is always initialized in setup
    expect(await createMemoryRepository(state.db!).listByUserId(other.userId)).toHaveLength(1);
  });

  it("删不存在的返回 404", async () => {
    const mine = await registerUser("mine@example.com");

    const response = await app.request("/api/memories/00000000-0000-0000-0000-0000000000ff", {
      method: "DELETE",
      headers: { cookie: mine.cookie },
    });

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run apps/server/src/http/routes/memories.test.ts
```

Expected: FAIL，GET 返回 404（路由还没挂）。

- [ ] **Step 3: 写路由**

创建 `apps/server/src/http/routes/memories.ts`：

```ts
import { createMemoryRepository, getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";

/**
 * 用户对自己记忆的只读与删除。
 *
 * 没有 POST / PUT：v1 的写入路径只有模型（memory_write 工具），
 * 用户手动新增记忆是另一个产品决定，现在加等于替将来做主——
 * 需要加一条记忆时可以直接跟 agent 说。
 */
export const memories = new Hono<AppEnv>()
  .get("/", async (c) => {
    const repo = createMemoryRepository(getDb());
    return c.json({ memories: await repo.listByUserId(c.get("currentUser").id) });
  })

  /** 不存在与不属于自己一律 404：403 会泄漏「这个 id 存在」 */
  .delete("/:id", async (c) => {
    const repo = createMemoryRepository(getDb());
    const deleted = await repo.deleteById(c.get("currentUser").id, c.req.param("id"));
    if (!deleted) {
      throw new HTTPException(404, { message: "记忆不存在" });
    }
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: 挂载路由**

`apps/server/src/http/app.ts` 加 import 并在 `/api/providers` 之后挂：

```ts
import { memories } from "./routes/memories.ts";
```

```ts
// 记忆管理。挂在 requireAuth 之下；isolation.test.ts 守着「无 cookie → 401」
app.route("/api/memories", memories);
```

- [ ] **Step 5: 给 isolation.test.ts 加一条**

打开 `apps/server/src/http/routes/isolation.test.ts`，照文件里既有的「无 cookie → 401」
用例形状，为 `/api/memories` 加一条同样的断言。这是防「新路由忘了挂在 requireAuth 之下」
的哨兵，`app.ts:20-22` 的注释指的就是它。

- [ ] **Step 6: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run apps/server/src/http/routes/memories.test.ts apps/server/src/http/routes/isolation.test.ts
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/http/routes/memories.ts apps/server/src/http/routes/memories.test.ts apps/server/src/http/app.ts apps/server/src/http/routes/isolation.test.ts
git commit -m "feat(server): 新增记忆管理 REST

只做列表与删除，不提供手动新增：v1 的写入路径只有模型，用户手动新增
是另一个产品决定。删别人的返回 404 而不是 403——403 会泄漏这个 id 存在。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5：设置里的记忆面板

**Files:**
- Create: `apps/web/src/apis/memory_api.js`
- Create: `apps/web/src/components/settings/MemoriesPanel.vue`
- Modify: `apps/web/src/components/settings/SettingsModal.vue`

- [ ] **Step 1: 写 API 模块**

创建 `apps/web/src/apis/memory_api.js`：

```js
import { del, get } from "./http";

/** 当前用户的全部记忆，按创建时间倒序。响应不含 embedding */
export const listMemories = () => get("/api/memories");

/** 删一条。不存在或不属于自己都会得到 404 */
export const deleteMemory = (id) => del(`/api/memories/${id}`);
```

- [ ] **Step 2: 写面板**

创建 `apps/web/src/components/settings/MemoriesPanel.vue`：

```vue
<template>
  <div class="memories-panel">
    <p class="hint">
      这些是助手在对话中记下的、关于你的长期信息。删除会话<strong>不会</strong>删除由它产生的记忆，
      需要清理请在这里操作。
    </p>

    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="error" class="state error">{{ error }}</p>
    <p v-else-if="memories.length === 0" class="state">还没有任何记忆。</p>

    <ul v-else class="list">
      <li v-for="memory in memories" :key="memory.id" class="item">
        <span class="content">{{ memory.content }}</span>
        <button type="button" class="remove" @click="remove(memory.id)">删除</button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { deleteMemory, listMemories } from "@/apis/memory_api";

const memories = ref([]);
const loading = ref(false);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await listMemories();
    memories.value = data.memories;
  } catch (err) {
    error.value = err.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

async function remove(id) {
  try {
    await deleteMemory(id);
    // 本地摘掉而不是重新拉：一次删除不该让整个列表闪一下
    memories.value = memories.value.filter((memory) => memory.id !== id);
  } catch (err) {
    error.value = err.message || "删除失败";
  }
}

onMounted(load);
</script>

<style scoped>
.hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.75;
}
.state {
  font-size: 13px;
  opacity: 0.7;
}
.state.error {
  color: #e5484d;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid rgb(128 128 128 / 0.2);
}
.content {
  flex: 1;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}
.remove {
  flex-shrink: 0;
  border: none;
  background: none;
  color: #e5484d;
  cursor: pointer;
  font-size: 13px;
}
</style>
```

- [ ] **Step 3: 挂进设置弹窗**

`apps/web/src/components/settings/SettingsModal.vue`：

- import 加 `import MemoriesPanel from "./MemoriesPanel.vue";`
- `TABS` 数组在 `providers` 与 `account` 之间插入 `{ key: "memories", label: "记忆" }`
- 模板的 panel 区域加一行：`<MemoriesPanel v-else-if="activeTab === 'memories'" />`

- [ ] **Step 4: 手动验证**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
docker compose up -d
```

浏览器打开 `http://localhost:5173/agent`，登录后开设置 → 记忆 tab。
预期：未写入过任何记忆时显示「还没有任何记忆」，说明文案可见。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/apis/memory_api.js apps/web/src/components/settings/MemoriesPanel.vue apps/web/src/components/settings/SettingsModal.vue
git commit -m "feat(web): 设置里新增记忆管理面板

面板上明写「删除会话不会删除由它产生的记忆」：这是 source_session_id
不做级联外键的直接后果，不写出来用户会以为删了会话就删干净了。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6：真实 pgvector 的集成测试

**Files:**
- Create: `packages/database/src/repositories/memories.integration.test.ts`

- [ ] **Step 1: 写集成测试**

PGlite 与真实 Postgres 的 HNSW 行为可能不同（近似索引带 `WHERE` 过滤时的
召回是总设计 §9 风险 2）。照 `entries.integration.test.ts` 的模式加一个默认跳过的文件：

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_EMBEDDING_DIM } from "../schema.ts";
import * as schema from "../schema.ts";
import { createMemoryRepository } from "./memories.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const USER_ID = "00000000-0000-0000-0000-0000000000cc";

/**
 * 默认跳过。跑法：
 *   docker compose up -d db
 *   pnpm --filter @petrel/database exec drizzle-kit migrate
 *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
 */
describe.skipIf(!DATABASE_URL)("记忆检索（真实 pgvector）", () => {
  let pool: Pool;
  let repo: ReturnType<typeof createMemoryRepository>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = createMemoryRepository(drizzle(pool, { schema }));
  });
  afterAll(() => pool.end());

  beforeEach(async () => {
    const db = drizzle(pool, { schema });
    // 只清自己造的数据，不 TRUNCATE：这个库可能有开发者手动造的数据
    await db.execute(sql`DELETE FROM user_memories WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_ID}, 'memory-integration@example.com', '!')`,
    );
  });

  function vectorOf(weights: Record<number, number>): number[] {
    const values = new Array<number>(MEMORY_EMBEDDING_DIM).fill(0);
    for (const [index, weight] of Object.entries(weights)) {
      values[Number(index)] = weight;
    }
    return values;
  }

  it("HNSW 索引下排序仍然正确", async () => {
    await repo.insert(USER_ID, { content: "正交", embedding: vectorOf({ 5: 1 }), sourceSessionId: null });
    await repo.insert(USER_ID, { content: "一致", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });

    const hits = await repo.searchByEmbedding(USER_ID, vectorOf({ 0: 1 }), 10);

    expect(hits.map((hit) => hit.content)).toEqual(["一致", "正交"]);
  });
});
```

- [ ] **Step 2: 跑一次真实库验证**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
docker compose up -d db
pnpm --filter @petrel/database exec drizzle-kit migrate
DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm vitest run packages/database/src/repositories/memories.integration.test.ts
```

Expected: PASS。若排序不对，说明 HNSW 在带 `WHERE user_id` 过滤时召回不足——
把实测结果记进总设计 §10 未决问题 2，并考虑改用顺序扫描（当前数据量下代价可忽略）。

- [ ] **Step 3: 全量验证并提交**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run lint
pnpm run typecheck
pnpm vitest run --exclude '**/.claude/**'
pnpm run build
```

Expected: 全绿。集成测试在没有 `DATABASE_URL` 时显示为 skipped。

```bash
git add packages/database/src/repositories/memories.integration.test.ts
git commit -m "test(database): 真实 pgvector 上的记忆检索集成测试

PGlite 与真实 Postgres 的 HNSW 行为可能不同（近似索引带 WHERE 过滤时
可能 over-filter）。默认跳过，与 entries.integration.test.ts 同一模式。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 自查清单

- [ ] `embed()` 的任何错误信息里都不含请求文本，也不透传 provider 响应体
- [ ] `writeMemory` 的条数检查在 `embed()` **之前**
- [ ] REST 没有 POST / PUT
- [ ] 删别人的记忆返回 404 而不是 403
- [ ] `isolation.test.ts` 加了 `/api/memories` 的 401 哨兵
- [ ] 前端面板上有「删会话不删记忆」的说明
- [ ] `packages/memory` 里没有出现任何 pi 类型，也没有直接发 SQL
- [ ] 没有顺手实现 `memory_write` / `memory_search` 工具——那是 M3

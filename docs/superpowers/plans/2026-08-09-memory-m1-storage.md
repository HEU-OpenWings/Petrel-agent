# M1：记忆存储地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `user_memories` 表、pgvector 扩展与一个所有方法都按 `userId` 收窄的 repository。

**Architecture:** 先把 PGlite 的 pgvector 扩展装上并单独验证既有测试不受影响，再落 migration 与表，最后写 repository。向量检索用 drizzle 的 `cosineDistance()`，测试喂手造的单位向量——不依赖任何 embedding provider。

**Tech Stack:** drizzle-orm 0.45.2（含 `vector` 列类型与 `cosineDistance`）· drizzle-kit 0.31.10 · `@electric-sql/pglite@0.5.4` + `@electric-sql/pglite-pgvector@0.0.5` · Vitest

**设计依据：** [M1 设计](../specs/2026-08-09-memory-m1-storage-design.md) · [记忆系统总设计](../specs/2026-08-09-user-memory-design.md)

**跑命令前置：** 本机 Git Bash 每次执行 `pnpm` 前都要先 `export PATH="/c/Program Files/nodejs:$PATH"`。仓库根跑全量测试要加 `--exclude '**/.claude/**'`。

> **Task 1 与 Task 2 绝对不能合并提交。** `createTestDb()` 跑全量 migration 且被 18 个测试文件依赖；先落 vector DDL 再装扩展，会让这 18 个文件一起崩，排查时很难看出根因是扩展缺失。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/database/package.json`（改） | 加 `@electric-sql/pglite-pgvector` devDependency |
| `packages/database/src/testing.ts`（改） | 装载 vector 扩展；`reset()` 的 TRUNCATE 列表加 `user_memories` |
| `packages/database/drizzle/0009_enable_vector.sql`（新建，由 drizzle-kit 生成骨架） | `CREATE EXTENSION` |
| `packages/database/drizzle/0010_*.sql`（新建，由 drizzle-kit 生成） | 建表与索引 |
| `packages/database/src/schema.ts`（改） | `userMemories` 表定义 |
| `packages/database/src/repositories/memories.ts`（新建） | CRUD + KNN，全部按 `userId` 收窄 |
| `packages/database/src/repositories/memories.test.ts`（新建） | repo 行为测试 |
| `packages/database/src/index.ts`（改） | 导出新 repository |

---

## Task 1：给 PGlite 装上 pgvector 扩展（不碰任何 DDL）

**Files:**
- Modify: `packages/database/package.json`
- Modify: `packages/database/src/testing.ts:39`

- [ ] **Step 1: 装依赖**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm --filter @petrel/database add -D @electric-sql/pglite-pgvector@0.0.5
```

Expected: 装上 0.0.5。它的 `peerDependencies` 精确锁 `@electric-sql/pglite@0.5.4`，
与仓库当前版本一致，不应有 peer 警告。

- [ ] **Step 2: 在 `createTestDb()` 里装载扩展**

修改 `packages/database/src/testing.ts`。顶部 import 加一行：

```ts
import { vector } from "@electric-sql/pglite-pgvector";
```

`:39` 的 `const client = new PGlite();` 改成：

```ts
  // pglite 0.4.11 起不再内置 pgvector，扩展被拆到 @electric-sql/pglite-pgvector。
  // 不装载的话，migration 里的 CREATE EXTENSION vector 会失败，
  // 而 createTestDb() 被 18 个测试文件依赖——崩的是全部数据层测试，不只是记忆相关的
  const client = new PGlite({ extensions: { vector } });
```

- [ ] **Step 3: 跑全量测试确认 18 个文件没被影响**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run --exclude '**/.claude/**'
```

Expected: PASS，数量与改动前一致（M0 做完的话是 683 passed）。
此时还没有任何 vector DDL，这一步纯粹验证「装扩展本身不破坏现状」。

- [ ] **Step 4: 单独提交**

```bash
git add packages/database/package.json packages/database/src/testing.ts pnpm-lock.yaml
git commit -m "chore(database): 给测试用的 PGlite 装载 pgvector 扩展

pglite 0.4.11 起不再内置 pgvector（0.2.x–0.4.0 有 ./vector export），
扩展被拆到 @electric-sql/pglite-pgvector，其 peerDeps 精确锁 0.5.4。

单独一个提交、且先于任何 vector DDL：createTestDb() 跑全量 migration
且被 18 个测试文件依赖，顺序反了会让全部数据层测试一起崩。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2：CREATE EXTENSION 的自定义 migration

**Files:**
- Create: `packages/database/drizzle/0009_enable_vector.sql`

- [ ] **Step 1: 生成空的自定义 migration**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm --filter @petrel/database exec drizzle-kit generate --custom --name=enable_vector
```

Expected: 生成 `packages/database/drizzle/0009_enable_vector.sql`（空文件）
并在 `drizzle/meta/_journal.json` 里登记。
用 `--custom` 而不是手写文件：手改 journal 容易出错，且顺序错了 migration 不会被应用。

- [ ] **Step 2: 填入 DDL**

把 `packages/database/drizzle/0009_enable_vector.sql` 的内容写成：

```sql
-- pgvector。compose 的 db 镜像是 pgvector/pgvector:pg17，扩展文件已在镜像里；
-- 测试用的 PGlite 靠 @electric-sql/pglite-pgvector 装载（见 src/testing.ts）
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 3: 跑数据层测试确认 migration 能过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/database
```

Expected: PASS。若报 `extension "vector" is not available`，说明 Task 1 Step 2 没生效。

- [ ] **Step 4: 提交**

```bash
git add packages/database/drizzle
git commit -m "feat(database): 启用 pgvector 扩展

用 drizzle-kit generate --custom 生成，避免手改 meta/_journal.json。
必须早于建表 migration：vector(1024) 这个类型在建表时得已经存在。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3：`user_memories` 表

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/testing.ts`（`reset()` 的 TRUNCATE 列表）
- Create: `packages/database/drizzle/0010_*.sql`（由 drizzle-kit 生成）

- [ ] **Step 1: 加表定义**

`packages/database/src/schema.ts` 顶部的 `drizzle-orm/pg-core` import 加上 `vector`，
然后在文件末尾追加：

```ts
/**
 * 用户级长期记忆。跨会话的用户画像、偏好、稳定事实，每人几十到几百条。
 *
 * **embedding 是 notNull**：没有向量的记忆检索不到，等于写了条查不到的东西——
 * 静默失效。写入时 embedding 失败就不落库（工具抛异常，pi 会把它转成 isError
 * 的 tool result 并让对话继续），不留半成品。
 *
 * **source_session_id 故意不做级联外键**，与 token_usage.session_id 同理：
 * 删会话不该让记忆消失，记忆是用户级的不是会话级的。副作用是「删了会话记忆还在」，
 * 这一点必须在前端记忆管理界面上写清楚，否则是隐私暗坑。
 *
 * 维度 1024 与 backend-plan 里知识库的统一列宽一致，也是 BAAI/bge-m3 的 dense 维度。
 * 换 embedding 模型 = 全量重新索引。
 */
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceSessionId: uuid("source_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 记忆管理页按时间倒序列出
    index("user_memories_user_created_idx").on(table.userId, table.createdAt.desc()),
    // 每用户上限 200 条时规划器多半仍走顺序扫描，现在建它是因为知识库（HEU-21）
    // 会复用同一套且届时数据量完全不同。cosine 是安全默认：无论向量是否已归一化，
    // 余弦距离都给出正确排序，内积只在已归一化时与它等价
    index("user_memories_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);
```

- [ ] **Step 2: 生成 migration**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm --filter @petrel/database run db:generate
```

Expected: 生成 `packages/database/drizzle/0010_<随机名>.sql`，内容含
`CREATE TABLE "user_memories"`、`vector(1024)`、两条 `CREATE INDEX`。
**打开确认 HNSW 那条确实生成了**——若没有，检查 `.using("hnsw", ...)` 与 `.op(...)` 的写法。

- [ ] **Step 3: 把新表加进测试的 `reset()`**

`packages/database/src/testing.ts:7` 的 import 列表加 `userMemories`，
`:63` 的 TRUNCATE 语句改成：

```ts
      await db.execute(
        sql`TRUNCATE ${users}, ${sessions}, ${sessionEntries}, ${userPreferences}, ${tokenUsage}, ${userQuotaLimits}, ${userMemories} RESTART IDENTITY CASCADE`,
      );
```

漏加的话记忆会跨用例残留，让检索断言 flake。

- [ ] **Step 4: 写建表验证测试**

在 `packages/database/src/schema.test.ts` 末尾追加：

```ts
describe("user_memories", () => {
  it("删用户会级联删掉他的记忆", async () => {
    await db.insert(userMemories).values({
      userId: TEST_USER_ID,
      content: "用户喜欢简洁的回答",
      embedding: new Array<number>(1024).fill(0),
    });

    await db.delete(users).where(eq(users.id, TEST_USER_ID));

    expect(await db.select().from(userMemories)).toHaveLength(0);
  });

  // 记忆是用户级的，不是会话级的；这条行为的隐私含义要在前端界面上写清楚
  it("删会话不会删掉由它产生的记忆", async () => {
    await db.insert(sessions).values({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });
    await db.insert(userMemories).values({
      userId: TEST_USER_ID,
      content: "用户在做 Petrel 项目",
      embedding: new Array<number>(1024).fill(0),
      sourceSessionId: SESSION_ID,
    });

    await db.delete(sessions).where(eq(sessions.id, SESSION_ID));

    expect(await db.select().from(userMemories)).toHaveLength(1);
  });
});
```

`SESSION_ID` 若该文件里还没有，加 `const SESSION_ID = "44444444-4444-4444-4444-444444444444";`。
需要的 import（`userMemories`、`sessions`、`users`、`eq`、`TEST_USER_ID`）按文件里既有的写法补。

- [ ] **Step 5: 跑测试**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/database
```

Expected: PASS，含新增的 2 个用例。

- [ ] **Step 6: 提交**

```bash
git add packages/database/src/schema.ts packages/database/src/schema.test.ts packages/database/src/testing.ts packages/database/drizzle
git commit -m "feat(database): 新增 user_memories 表

embedding 是 notNull：没有向量的记忆检索不到，等于静默失效。
source_session_id 不做级联外键，删会话不该让记忆消失——与
token_usage.session_id 同理。HNSW 索引现在建是为了知识库将来复用，
当前每用户 200 条的量级下规划器多半仍走顺序扫描。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4：记忆 repository

**Files:**
- Create: `packages/database/src/repositories/memories.ts`
- Test: `packages/database/src/repositories/memories.test.ts`
- Modify: `packages/database/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/database/src/repositories/memories.test.ts`：

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createMemoryRepository } from "./memories.ts";

const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000bb";
const EMBEDDING_DIM = 1024;

/**
 * 造一个 1024 维的稀疏向量：只有指定下标非零。
 *
 * 用它而不是随机数，是为了让相似度可以手算：两个不同下标的单位向量正交（余弦 0），
 * 同一下标的余弦是 1。断言里写死的期望值因此是可验证的，不是「跑出来是多少就写多少」。
 */
function vectorOf(weights: Record<number, number>): number[] {
  const values = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const [index, weight] of Object.entries(weights)) {
    values[Number(index)] = weight;
  }
  return values;
}

describe("createMemoryRepository", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let repo: ReturnType<typeof createMemoryRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    db = testDb.db;
    repo = createMemoryRepository(db);
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await testDb.reset();
    await db.insert(users).values({
      id: OTHER_USER_ID,
      email: "other@example.com",
      passwordHash: "!",
    });
  });

  it("插入后能按用户列出，且不返回 embedding", async () => {
    const created = await repo.insert(TEST_USER_ID, {
      content: "用户喜欢简洁的回答",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(created.content).toBe("用户喜欢简洁的回答");
    // 1024 个浮点数对调用方没用，返回它只会塞进 HTTP 响应和日志
    expect(created).not.toHaveProperty("embedding");
    expect(await repo.listByUserId(TEST_USER_ID)).toHaveLength(1);
  });

  it("countByUserId 只数自己的", async () => {
    await repo.insert(TEST_USER_ID, { content: "a", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });
    await repo.insert(OTHER_USER_ID, { content: "b", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });

    expect(await repo.countByUserId(TEST_USER_ID)).toBe(1);
  });

  it("按余弦相似度倒序返回", async () => {
    await repo.insert(TEST_USER_ID, { content: "正交", embedding: vectorOf({ 5: 1 }), sourceSessionId: null });
    await repo.insert(TEST_USER_ID, { content: "完全一致", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });
    await repo.insert(TEST_USER_ID, { content: "部分相关", embedding: vectorOf({ 0: 0.6, 1: 0.8 }), sourceSessionId: null });

    const hits = await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 10);

    expect(hits.map((hit) => hit.content)).toEqual(["完全一致", "部分相关", "正交"]);
    expect(hits[0]?.similarity).toBeCloseTo(1, 5);
    expect(hits[1]?.similarity).toBeCloseTo(0.6, 5);
    expect(hits[2]?.similarity).toBeCloseTo(0, 5);
  });

  it("limit 生效", async () => {
    await repo.insert(TEST_USER_ID, { content: "a", embedding: vectorOf({ 0: 1 }), sourceSessionId: null });
    await repo.insert(TEST_USER_ID, { content: "b", embedding: vectorOf({ 1: 1 }), sourceSessionId: null });

    expect(await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 1)).toHaveLength(1);
  });

  // 这是本轮的安全核心：检索必须按 userId 收窄
  it("检索不到别人的记忆", async () => {
    await repo.insert(OTHER_USER_ID, {
      content: "别人的秘密",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.searchByEmbedding(TEST_USER_ID, vectorOf({ 0: 1 }), 10)).toEqual([]);
    expect(await repo.listByUserId(TEST_USER_ID)).toEqual([]);
  });

  it("删不掉别人的记忆", async () => {
    const other = await repo.insert(OTHER_USER_ID, {
      content: "别人的秘密",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.deleteById(TEST_USER_ID, other.id)).toBe(false);
    expect(await repo.listByUserId(OTHER_USER_ID)).toHaveLength(1);
  });

  it("删自己的记忆返回 true", async () => {
    const mine = await repo.insert(TEST_USER_ID, {
      content: "我的记忆",
      embedding: vectorOf({ 0: 1 }),
      sourceSessionId: null,
    });

    expect(await repo.deleteById(TEST_USER_ID, mine.id)).toBe(true);
    expect(await repo.listByUserId(TEST_USER_ID)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/database/src/repositories/memories.test.ts
```

Expected: FAIL，`Failed to resolve import "./memories.ts"`。

- [ ] **Step 3: 写 repository**

创建 `packages/database/src/repositories/memories.ts`：

```ts
import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import { userMemories } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface Memory {
  id: string;
  content: string;
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchHit extends Memory {
  /** 余弦相似度：1 = 完全一致，0 = 正交。由 1 - cosineDistance 算得 */
  similarity: number;
}

/**
 * embedding 不出现在任何返回类型里：1024 个浮点数对调用方没有用处，
 * 返回它只会把它塞进 HTTP 响应和日志。
 */
const COLUMNS = {
  id: userMemories.id,
  content: userMemories.content,
  sourceSessionId: userMemories.sourceSessionId,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
};

/**
 * 用户级长期记忆的读写。
 *
 * **所有方法首参都是 userId，不提供任何不带 userId 的查询入口**——
 * 让「忘记按用户收窄」在类型层就写不出来。这是记忆系统用户隔离的主要手段。
 */
export function createMemoryRepository(db: Database) {
  return {
    async insert(
      userId: string,
      values: { content: string; embedding: number[]; sourceSessionId: string | null },
    ): Promise<Memory> {
      const rows = await db
        .insert(userMemories)
        .values({ userId, ...values })
        .returning(COLUMNS);
      // 没有 onConflict，插不进去只可能是异常（已经抛了），所以这里必有一行
      const row = rows[0];
      if (!row) throw new Error("插入记忆后没有返回行");
      return row;
    },

    async countByUserId(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userMemories)
        .where(eq(userMemories.userId, userId));
      return rows[0]?.count ?? 0;
    },

    async listByUserId(userId: string): Promise<Memory[]> {
      return db
        .select(COLUMNS)
        .from(userMemories)
        .where(eq(userMemories.userId, userId))
        .orderBy(desc(userMemories.createdAt));
    },

    /** 返回是否真的删到。删不存在的与删别人的在路由层是同一个响应（404），repo 只如实报告 */
    async deleteById(userId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(userMemories)
        .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
        .returning({ id: userMemories.id });
      return rows.length > 0;
    },

    /**
     * 按余弦相似度倒序取前 limit 条。
     *
     * 用余弦而不是内积：内积只在向量已 L2 归一化时与余弦等价，
     * 而 embedding 模型是否归一化是 provider 的实现细节，不该被这里假设。
     */
    async searchByEmbedding(userId: string, embedding: number[], limit: number): Promise<MemorySearchHit[]> {
      const similarity = sql<number>`1 - (${cosineDistance(userMemories.embedding, embedding)})`;
      return db
        .select({ ...COLUMNS, similarity })
        .from(userMemories)
        .where(eq(userMemories.userId, userId))
        .orderBy(desc(similarity))
        .limit(limit);
    },
  };
}
```

- [ ] **Step 4: 导出 repository**

`packages/database/src/index.ts` 在 `./repositories/entries.ts` 那一行后面加：

```ts
export * from "./repositories/memories.ts";
```

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/database/src/repositories/memories.test.ts
```

Expected: PASS，7 个用例全过。
若「按余弦相似度倒序」那条的 similarity 数值对不上，检查 `vectorOf({0: 0.6, 1: 0.8})`
——它的模长是 1（0.6² + 0.8² = 1），与 `vectorOf({0: 1})` 的余弦正好是 0.6。

- [ ] **Step 6: 全量验证并提交**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run lint
pnpm run typecheck
pnpm vitest run --exclude '**/.claude/**'
pnpm run build
```

Expected: 全绿。

```bash
git add packages/database/src/repositories/memories.ts packages/database/src/repositories/memories.test.ts packages/database/src/index.ts
git commit -m "feat(database): 新增记忆 repository

所有方法首参都是 userId，不提供任何不带 userId 的查询入口——让「忘记按
用户收窄」在类型层就写不出来。embedding 不出现在返回类型里：1024 个浮点数
对调用方没用，返回它只会塞进 HTTP 响应和日志。

检索用余弦而非内积：内积只在向量已 L2 归一化时与余弦等价，而是否归一化
是 embedding provider 的实现细节，不该被这里假设。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 自查清单

- [ ] Task 1 与 Task 2 是两个独立提交，顺序没有颠倒
- [ ] `reset()` 的 TRUNCATE 列表里有 `user_memories`
- [ ] repo 没有任何不带 `userId` 的查询方法
- [ ] 返回类型里没有 `embedding`
- [ ] 生成的 `0010_*.sql` 里确实有 HNSW 索引（不是只有 btree）
- [ ] 没有顺手实现 `updateById`、条数上限或任何 embedding 调用——那些是 M2

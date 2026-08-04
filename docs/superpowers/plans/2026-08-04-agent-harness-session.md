# AgentHarness + Postgres 会话树 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把裸 pi `Agent` 换成 `AgentHarness`，用 append-only 的 `session_entries` 会话树替换线性 `messages` 表，为后续的上下文压缩、tool/skill 管理、记忆系统打好地基。

**Architecture:** SQL 留在 `packages/database`（`createEntryRepository`，不认识 pi）；pi 语义留在 `packages/agent`（`PgSessionStorage` / `PgSessionRepo` / `createHarness`）；进程内运行时状态留在 `apps/server`（`HarnessRegistry` 按 sessionId 缓存常驻 harness）。harness 自己通过 `Session` 落库，`attachPersistence` 那套事件订阅落库逻辑整体删除。

**Tech Stack:** TypeScript ESM · pi 0.83（`@earendil-works/pi-agent-core`）· Hono · Drizzle + Postgres · PGlite（测试）· vitest

**设计文档：** [../specs/2026-08-04-agent-harness-session-design.md](../specs/2026-08-04-agent-harness-session-design.md)。动工前通读一遍，特别是 §2「核对过的 pi 行为」四条。

### 与 spec 的三处偏差（写计划时读 pi 源码才发现，spec 待回填）

1. **`AgentHarness.phase` 是私有字段，没有 getter**。spec §5 的伪代码写成
   `phase === "idle" ? prompt(...) : followUp(...)`，外部读不到。
   改法：`HarnessRegistry` 订阅一次 harness 事件，用 `agent_start` / `settled` 自己维护
   `running` 标记，并在调用点保留 `busy` / `invalid_state` 的兜底重试（Task 5）。
2. **不需要 `PgSessionRepo`**。`AgentHarnessOptions` 只吃 `session: Session`，不吃 `SessionRepo`；
   会话列表/删除走现有的 `sessionRepo`（它有 `userId` 收窄）。spec §4.3 为它留了位置，
   实际是 YAGNI，本计划不实现（将来做分支/fork 时再说）。
3. **`GET /:id/messages` 不能用 `buildContext()`**。它会应用 compaction 变换，
   于是压缩发生后用户刷新页面会看到历史凭空消失。历史展示必须用 `listAll` 过滤
   `type === "message"` 拿完整 transcript；`buildContext()` 只用于喂模型（Task 7）。
4. **`busy` 不会表现为 409**。spec §6 写「保留一层兜底 → 409」，但归属校验之后就进了
   `streamSSE`，此时响应头已发出，改不了状态码。串行入口已从结构上消除 `busy`，
   真出现时表现为 SSE 的 `event: error`。409 这条从 spec 里去掉（Task 10 回填）。

---

## 环境准备（必读，否则第一条命令就会失败）

这个 worktree 里**直接调 `pnpm` 会失败**，报 `'node' is not recognized`。根因不是 node 缺失（`node -v` 正常），而是传给 Windows 子进程的 PATH 是 POSIX 格式（`/c/...` 冒号分隔），cmd.exe 拿到等于空 PATH，pnpm 内部 spawn 就找不到 node。

本计划里所有 pnpm 命令都写成下面这个形式，**两行一起复制**：

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" <args>
```

后文简称这两行为 **`<PNPM>`**。每个任务的命令步骤都会写全，不要凭记忆缩写。

另外：**不要在宿主机起前端 dev server**（项目约定），端到端验收统一走 `docker compose up -d`。

---

## 文件结构

**新建**

| 文件 | 职责 |
| --- | --- |
| `packages/database/src/repositories/entries.ts` | `createEntryRepository`：`session_entries` 的 SQL。不 import 任何 pi 类型 |
| `packages/database/src/repositories/entries.test.ts` | 上者的 PGlite 测试 |
| `packages/agent/src/session/pg-storage.ts` | `PgSessionStorage implements SessionStorage`：唯一懂「11 种条目类型怎么拆进 type + payload」的地方 |
| `packages/agent/src/session/pg-storage.test.ts` | 契约测试，同一套断言跑 PGlite 版与 pi 自带的 `InMemorySessionRepo` |
| `packages/agent/src/harness.ts` | `createPgSession()` + `createHarness()`：装配 `AgentHarness` |
| `packages/agent/src/harness.test.ts` | fauxProvider + 内存 session 跑真实 loop |
| `apps/server/src/services/harness-registry.ts` | 按 sessionId 缓存常驻 harness，TTL / 容量 / 归属校验 / abort |
| `apps/server/src/services/harness-registry.test.ts` | 上者的测试 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `packages/database/src/schema.ts` | 新增 `sessionEntries`；Task 9 删除 `messages` |
| `packages/database/src/testing.ts` | `TRUNCATE` 加新表；更新 `RESTART IDENTITY` 的注释（现在真有 identity 列了） |
| `packages/database/src/index.ts` | 导出 `entries.ts`；Task 9 移除 `messages.ts` |
| `packages/agent/package.json` | 新增 `@petrel/database` 依赖 |
| `packages/agent/tsconfig.json` | `references` 加 `../database` |
| `packages/agent/src/index.ts` | 导出 `createHarness` 与 session 类型；Task 9 删除 `createAgent` |
| `apps/server/src/http/routes/chat.ts` | 改用 registry + harness；新增 abort 端点 |
| `apps/server/src/http/routes/chat.test.ts` | 重写落库相关用例 |
| `apps/server/src/http/routes/sessions.ts` | `/:id/messages` 改从 entries 投影，去掉 `interruptedSeqs` |
| `apps/server/src/services/session.ts` | 删除 `attachPersistence` |
| `apps/web/src/composables/useAgentStream.js` | 停止按钮改调 abort 接口 |
| `apps/web/src/apis/chat_api.js` | 新增 `abortChat` |
| `CLAUDE.md` · `docs/backend-plan.md` | 更新架构与踩坑记录 |

**删除（Task 9）**：`packages/database/src/repositories/messages.ts`（+ 两个测试文件）、`messages` 表、`attachPersistence`、`createAgent`。

---

### Task 1: `session_entries` 表

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/testing.ts:60`
- Modify: `packages/database/src/schema.test.ts`
- Create: `packages/database/drizzle/0003_*.sql`（由 drizzle-kit 生成）

- [ ] **Step 1: 写失败的测试**

在 `packages/database/src/schema.test.ts` 末尾追加：

```ts
describe("session_entries", () => {
  it("条目按 parent_id 串成链，entry_seq 自增", async () => {
    await db.insert(sessions).values({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });

    const first = "aaaaaaaa-0000-0000-0000-000000000001";
    const second = "aaaaaaaa-0000-0000-0000-000000000002";
    await db.insert(sessionEntries).values({
      id: first,
      sessionId: SESSION_ID,
      parentId: null,
      type: "message",
      payload: { message: { role: "user", content: [] } },
    });
    await db.insert(sessionEntries).values({
      id: second,
      sessionId: SESSION_ID,
      parentId: first,
      type: "message",
      payload: { message: { role: "assistant", content: [] } },
    });

    const rows = await db
      .select()
      .from(sessionEntries)
      .orderBy(sessionEntries.entrySeq);
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(rows.map((r) => r.parentId)).toEqual([null, first]);
    // entry_seq 只保证单调递增，不保证从 1 开始（bigserial 是全局序列）
    expect(Number(rows[1]!.entrySeq)).toBeGreaterThan(Number(rows[0]!.entrySeq));
  });

  it("删除会话级联删除条目", async () => {
    await db.insert(sessions).values({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });
    await db.insert(sessionEntries).values({
      id: "aaaaaaaa-0000-0000-0000-000000000003",
      sessionId: SESSION_ID,
      parentId: null,
      type: "leaf",
      payload: { targetId: null },
    });

    await db.delete(sessions).where(eq(sessions.id, SESSION_ID));

    expect(await db.select().from(sessionEntries)).toHaveLength(0);
  });
});
```

文件顶部的 import 里补上 `sessionEntries`（与既有 `sessions` 同一处导入），并确认 `SESSION_ID` 常量存在——若该文件没有，在顶部加：

```ts
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/database/src/schema.test.ts
```

Expected: FAIL —— `sessionEntries` 未从 `./schema.ts` 导出（TS 报错 / 运行时 undefined）。

- [ ] **Step 3: 加 schema 定义**

`packages/database/src/schema.ts` 末尾追加（顶部 import 补 `bigserial`）：

```ts
/**
 * pi 的会话树条目。一条会话是一棵 append-only 的条目树，消息只是其中一种类型
 * （还有 compaction / model_change / label / leaf 等，共 11 种，
 * 见 pi 的 harness/types.d.ts 的 SessionTreeEntry）。
 *
 * 顺序由 parent_id 链决定，不由插入序决定——这是它取代 messages 表的根本原因：
 * 上下文压缩不是删历史，而是新增一个 compaction 条目把它之前的路径挡在上下文之外，
 * 完整 transcript 仍可从根读起。
 */
export const sessionEntries = pgTable(
  "session_entries",
  {
    // 不用 defaultRandom：id 由 pi 的 createEntryId() 生成（uuidv7，本身单调递增）
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // 自引用外键故意不加：条目按 (session_id, parent_id) 成链，而删除只发生在会话级联，
    // 加了它反而会让「先写子后写父」这种将来可能的批量写入变得脆弱
    parentId: uuid("parent_id"),
    // 仅供 getEntries({ afterEntrySeq }) 做游标分页，不参与语义定序。
    // bigserial 是全局序列，同一会话内单调递增即可，不要求从 1 开始也不要求连续
    entrySeq: bigserial("entry_seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    // 该类型条目除 id / parent_id / timestamp / type 之外的字段，pi 结构原样存。
    // 不拆字段：pi 仍在快速演进，拆字段等于把它的内部结构固化进表结构
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 游标分页与全量读
    index("session_entries_session_seq_idx").on(table.sessionId, table.entrySeq),
    // findEntries(type)：取某类条目（如最新的 leaf / session_info）
    index("session_entries_session_type_idx").on(table.sessionId, table.type),
  ],
);
```

- [ ] **Step 4: 生成 migration**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" --filter @petrel/database exec drizzle-kit generate
```

Expected: 生成 `packages/database/drizzle/0003_<随机名>.sql`，内容是 `CREATE TABLE "session_entries"` + 两个 index + 一个外键。**打开确认它只建表不删表**——`messages` 要留到 Task 9 才删。

- [ ] **Step 5: 让测试库知道新表**

`packages/database/src/testing.ts`：import 补 `sessionEntries`，并替换 `reset()` 里的 TRUNCATE 与它上面的注释：

```ts
    async reset() {
      // CASCADE 是必需的：表之间有外键，单独 TRUNCATE users 会被拒绝。
      // RESTART IDENTITY 现在不再是空操作：session_entries.entry_seq 是 bigserial，
      // 不复位的话跨用例的游标断言会依赖上一个用例留下的序号
      await db.execute(
        sql`TRUNCATE ${users}, ${sessions}, ${messages}, ${sessionEntries} RESTART IDENTITY CASCADE`,
      );
      await seedTestUser();
    },
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/database
```

Expected: PASS，全部数据层测试绿（新表是纯新增，不该影响既有用例）。

- [ ] **Step 7: 提交**

```bash
git add packages/database/src/schema.ts packages/database/src/schema.test.ts packages/database/src/testing.ts packages/database/drizzle
git commit -m "feat(database): 新增 session_entries 会话树表"
```

---

### Task 2: `createEntryRepository`

只写 SQL，**不 import 任何 pi 类型**——这是「pi 接线只在 agent/ai」能守住的前提。

**Files:**
- Create: `packages/database/src/repositories/entries.ts`
- Create: `packages/database/src/repositories/entries.test.ts`
- Modify: `packages/database/src/index.ts`

- [ ] **Step 1: 写失败的测试**

`packages/database/src/repositories/entries.test.ts`：

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEntryRepository } from "./entries.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { sessions } from "../schema.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-2222-2222-222222222222";

/** 条目 id 要看得出顺序，用后缀编号而不是随机 uuid */
function entryId(n: number): string {
  return `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let repo: ReturnType<typeof createEntryRepository>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createEntryRepository(db);
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  await db.insert(sessions).values([
    { id: SESSION_ID, userId: TEST_USER_ID, title: "a" },
    { id: OTHER_SESSION_ID, userId: TEST_USER_ID, title: "b" },
  ]);
});

/** 追加一条 message 条目，parent 为上一条 */
async function appendMessage(n: number, parent: number | null, sessionId = SESSION_ID) {
  await repo.append({
    id: entryId(n),
    sessionId,
    parentId: parent === null ? null : entryId(parent),
    type: "message",
    payload: { message: { role: "user", content: [{ type: "text", text: `m${n}` }] } },
  });
}

describe("createEntryRepository", () => {
  it("append 后能按 id 取回，payload 原样", async () => {
    await appendMessage(1, null);

    const row = await repo.byId(SESSION_ID, entryId(1));
    expect(row).toMatchObject({ id: entryId(1), parentId: null, type: "message" });
    expect(row?.payload).toEqual({
      message: { role: "user", content: [{ type: "text", text: "m1" }] },
    });
  });

  it("byId 按 sessionId 收窄，别的会话的条目取不到", async () => {
    await appendMessage(1, null, OTHER_SESSION_ID);

    expect(await repo.byId(SESSION_ID, entryId(1))).toBeUndefined();
  });

  it("pathToRootOrCompaction 返回根到叶的正序", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await appendMessage(3, 2);

    const path = await repo.pathToRootOrCompaction(SESSION_ID, entryId(3));
    expect(path.map((e) => e.id)).toEqual([entryId(1), entryId(2), entryId(3)]);
  });

  it("pathToRootOrCompaction 在 compaction 条目处停下，且包含它", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await repo.append({
      id: entryId(3),
      sessionId: SESSION_ID,
      parentId: entryId(2),
      type: "compaction",
      payload: { summary: "s", tokensBefore: 10 },
    });
    await appendMessage(4, 3);

    const path = await repo.pathToRootOrCompaction(SESSION_ID, entryId(4));
    // 压缩之前的 1、2 被挡在上下文之外，但它们仍然在表里
    expect(path.map((e) => e.id)).toEqual([entryId(3), entryId(4)]);
    expect(await repo.byId(SESSION_ID, entryId(1))).toBeDefined();
  });

  it("leafId 为 null 时 pathToRootOrCompaction 返回空数组", async () => {
    await appendMessage(1, null);

    expect(await repo.pathToRootOrCompaction(SESSION_ID, null)).toEqual([]);
  });

  it("byType 只返回该类型，按 entry_seq 升序", async () => {
    await appendMessage(1, null);
    await repo.append({
      id: entryId(2),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(1) },
    });
    await repo.append({
      id: entryId(3),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(2) },
    });

    const leaves = await repo.byType(SESSION_ID, "leaf");
    expect(leaves.map((e) => e.id)).toEqual([entryId(2), entryId(3)]);
  });

  it("latestLeaf 取最后写入的 leaf 条目", async () => {
    await appendMessage(1, null);
    await repo.append({
      id: entryId(2),
      sessionId: SESSION_ID,
      parentId: entryId(1),
      type: "leaf",
      payload: { targetId: entryId(1) },
    });

    expect((await repo.latestLeaf(SESSION_ID))?.id).toEqual(entryId(2));
    expect(await repo.latestLeaf(OTHER_SESSION_ID)).toBeUndefined();
  });

  it("listAll 按 entry_seq 升序，listAfter 按游标续读", async () => {
    await appendMessage(1, null);
    await appendMessage(2, 1);
    await appendMessage(3, 2);

    const all = await repo.listAll(SESSION_ID);
    expect(all.map((e) => e.id)).toEqual([entryId(1), entryId(2), entryId(3)]);

    const after = await repo.listAfter(SESSION_ID, all[0]!.entrySeq, 10);
    expect(after.map((e) => e.id)).toEqual([entryId(2), entryId(3)]);

    const limited = await repo.listAfter(SESSION_ID, all[0]!.entrySeq, 1);
    expect(limited.map((e) => e.id)).toEqual([entryId(2)]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/database/src/repositories/entries.test.ts
```

Expected: FAIL —— `Cannot find module './entries.ts'`。

- [ ] **Step 3: 实现仓储**

`packages/database/src/repositories/entries.ts`：

```ts
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./sessions.ts";
import { sessionEntries } from "../schema.ts";

/**
 * 一行 session_entries。
 *
 * payload 是 unknown 而不是具体类型：这一层不认识 pi 的 11 种条目类型，
 * 翻译工作全在 packages/agent 的 PgSessionStorage 里（依赖方向的要求：
 * database 不 import 任何 pi 类型）。
 */
export interface StoredEntry {
  id: string;
  parentId: string | null;
  entrySeq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

const COLUMNS = {
  id: sessionEntries.id,
  parentId: sessionEntries.parentId,
  entrySeq: sessionEntries.entrySeq,
  type: sessionEntries.type,
  payload: sessionEntries.payload,
  createdAt: sessionEntries.createdAt,
};

export interface NewEntry {
  id: string;
  sessionId: string;
  parentId: string | null;
  type: string;
  payload: unknown;
}

export function createEntryRepository(db: Database) {
  return {
    /**
     * 追加一条条目。
     *
     * 这里没有事务、没有行锁——与被它取代的 messages.append 的关键区别。
     * 线性模型要在事务里 SELECT ... FOR UPDATE 再算 MAX(seq)+1（读-改-写序列），
     * 而树模型的 parent_id 由调用方（harness 的当前 leaf）在插入前就已知，
     * entry_seq 由数据库序列给，两者都不需要读旧数据。
     */
    async append(entry: NewEntry): Promise<void> {
      await db.insert(sessionEntries).values({
        id: entry.id,
        sessionId: entry.sessionId,
        parentId: entry.parentId,
        type: entry.type,
        payload: entry.payload,
      });
    },

    /** 一律按 (sessionId, id) 收窄：只按条目 id 定位等于跨会话可读 */
    async byId(sessionId: string, id: string): Promise<StoredEntry | undefined> {
      const rows = await db
        .select(COLUMNS)
        .from(sessionEntries)
        .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.id, id)))
        .limit(1);
      return rows[0];
    },

    async byType(sessionId: string, type: string): Promise<StoredEntry[]> {
      return db
        .select(COLUMNS)
        .from(sessionEntries)
        .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.type, type)))
        .orderBy(asc(sessionEntries.entrySeq));
    },

    /** 最后写入的 leaf 条目，即当前活跃末端的记录 */
    async latestLeaf(sessionId: string): Promise<StoredEntry | undefined> {
      const rows = await db
        .select(COLUMNS)
        .from(sessionEntries)
        .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.type, "leaf")))
        .orderBy(desc(sessionEntries.entrySeq))
        .limit(1);
      return rows[0];
    },

    async listAll(sessionId: string): Promise<StoredEntry[]> {
      return db
        .select(COLUMNS)
        .from(sessionEntries)
        .where(eq(sessionEntries.sessionId, sessionId))
        .orderBy(asc(sessionEntries.entrySeq));
    },

    async listAfter(sessionId: string, afterSeq: number, limit: number): Promise<StoredEntry[]> {
      return db
        .select(COLUMNS)
        .from(sessionEntries)
        .where(
          and(eq(sessionEntries.sessionId, sessionId), gt(sessionEntries.entrySeq, afterSeq)),
        )
        .orderBy(asc(sessionEntries.entrySeq))
        .limit(limit);
    },

    /**
     * 从 leafId 沿 parent_id 上溯，遇到 compaction 条目就停（含它自己），返回根到叶的正序。
     *
     * 这是「上下文压缩」在存储层的全部实现：压缩不删任何条目，只是让上溯提前终止，
     * 于是 compaction 之前的历史不再进入模型上下文，但完整 transcript 仍可用 listAll 读出。
     *
     * 用递归 CTE 而不是在 JS 里循环查：一条会话的路径可能有几百个条目，
     * 逐条 round-trip 在真实 Postgres 上是几百次网络往返。
     */
    async pathToRootOrCompaction(sessionId: string, leafId: string | null): Promise<StoredEntry[]> {
      if (leafId === null) return [];
      // drizzle 的 db.execute 在 node-postgres 与 PGlite 上都返回 { rows }，
      // 但列名是 snake_case（不经过 schema 映射），所以下面手工转成 StoredEntry
      const result = await db.execute(sql`
        WITH RECURSIVE up AS (
          SELECT e.id, e.parent_id, e.entry_seq, e.type, e.payload, e.created_at, 0 AS depth
          FROM session_entries e
          WHERE e.session_id = ${sessionId} AND e.id = ${leafId}
          UNION ALL
          SELECT e.id, e.parent_id, e.entry_seq, e.type, e.payload, e.created_at, up.depth + 1
          FROM session_entries e
          JOIN up ON e.id = up.parent_id
          WHERE e.session_id = ${sessionId} AND up.type <> 'compaction'
        )
        SELECT id, parent_id, entry_seq, type, payload, created_at
        FROM up
        ORDER BY depth DESC
      `);
      const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
      return rows.map((row) => ({
        id: row.id as string,
        parentId: (row.parent_id as string | null) ?? null,
        entrySeq: Number(row.entry_seq),
        type: row.type as string,
        payload: row.payload,
        createdAt: new Date(row.created_at as string),
      }));
    },
  };
}
```

- [ ] **Step 4: 导出**

`packages/database/src/index.ts` 在 `messages.ts` 那行**之前**插入一行（保持字母序）：

```ts
export * from "./repositories/entries.ts";
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/database/src/repositories/entries.test.ts
```

Expected: PASS，9 个用例全绿。

若 `pathToRootOrCompaction` 的两个用例报「rows 为 undefined」，说明 `db.execute` 的返回形状与注释里的假设不同：打印 `result` 看实际形状（PGlite 与 node-postgres 可能一个返回 `{ rows }`、一个直接返回数组），按实际形状改那行断言并**更新注释**，不要用 `any` 绕过。

- [ ] **Step 6: 加真实 Postgres 的并发用例**

PGlite 是单后端 WASM Postgres，JS 侧并行发出的语句会被排队串行执行，**结构性地测不出并发问题**（这是仓库里踩过的坑）。被删掉的 `messages.integration.test.ts` 守的是「seq 分配的行锁不能删」；树模型没有那把锁了，但要守一条新的不变式：**并发追加不丢条目**。

新建 `packages/database/src/repositories/entries.integration.test.ts`：

```ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEntryRepository } from "./entries.ts";
import * as schema from "../schema.ts";

const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";
const ROOT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

/**
 * 默认跳过。跑法：
 *   docker compose up -d db
 *   pnpm --filter @petrel/database exec drizzle-kit migrate
 *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm test
 */
describe.skipIf(!DATABASE_URL)("createEntryRepository 并发（真实 Postgres）", () => {
  let pool: Pool;
  let repo: ReturnType<typeof createEntryRepository>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = createEntryRepository(drizzle(pool, { schema }));
  });
  afterAll(() => pool.end());

  beforeEach(async () => {
    const db = drizzle(pool, { schema });
    // 只清自己造的数据，不 TRUNCATE：这个库可能有开发者手动造的会话
    await db.execute(sql`DELETE FROM session_entries WHERE session_id = ${SESSION_ID}`);
    await db.execute(sql`DELETE FROM sessions WHERE id = ${SESSION_ID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_ID}, 'integration@example.com', '!')`,
    );
    await db.execute(
      sql`INSERT INTO sessions (id, user_id, title) VALUES (${SESSION_ID}, ${USER_ID}, 'integration')`,
    );
    await repo.append({
      id: ROOT_ID,
      sessionId: SESSION_ID,
      parentId: null,
      type: "message",
      payload: { message: { role: "user", content: [] } },
    });
  });

  it("12 路并发基于同一 leaf 追加，一条都不丢", async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `bbbbbbbb-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    );

    const results = await Promise.allSettled(
      ids.map((id) =>
        repo.append({
          id,
          sessionId: SESSION_ID,
          parentId: ROOT_ID,
          type: "message",
          payload: { message: { role: "assistant", content: [] } },
        }),
      ),
    );

    // 关键：全部成功。线性 seq 模型在这里会有一批撞唯一约束后静默丢失，
    // 树模型下并发的结果是同一个 parent 下分出多个子节点——数据不丢，只是分叉
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    const all = await repo.listAll(SESSION_ID);
    expect(all).toHaveLength(13);
    // entry_seq 严格递增，游标分页不会漏读
    const seqs = all.map((e) => e.entrySeq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("递归 CTE 在真实 Postgres 上与 PGlite 行为一致", async () => {
    const child = "bbbbbbbb-0000-0000-0000-0000000000ff";
    await repo.append({
      id: child,
      sessionId: SESSION_ID,
      parentId: ROOT_ID,
      type: "message",
      payload: { message: { role: "assistant", content: [] } },
    });

    const path = await repo.pathToRootOrCompaction(SESSION_ID, child);
    expect(path.map((e) => e.id)).toEqual([ROOT_ID, child]);
  });
});
```

第二个用例不是多余的：`db.execute` 的返回形状在 node-postgres 与 PGlite 上可能不同（Task 2 Step 5 的排查提示就是为此），而 `pathToRootOrCompaction` 是唯一用原始 SQL 的方法。它在 PGlite 上绿、在真 Postgres 上红是完全可能的。

- [ ] **Step 7: 提交**

```bash
git add packages/database/src/repositories/entries.ts packages/database/src/repositories/entries.test.ts packages/database/src/repositories/entries.integration.test.ts packages/database/src/index.ts
git commit -m "feat(database): 会话树条目仓储"
```

---

### Task 3: `PgSessionStorage`

pi 的 `SessionStorage` 有 12 个方法。这个类是唯一懂「11 种条目类型怎么拆进 `type` + `payload`」的地方。

**Files:**
- Create: `packages/agent/src/session/pg-storage.ts`
- Create: `packages/agent/src/session/pg-storage.test.ts`
- Modify: `packages/agent/package.json`
- Modify: `packages/agent/tsconfig.json`

- [ ] **Step 1: 接上依赖**

`packages/agent/package.json` 的 `dependencies` 加一行（保持字母序，在 `@petrel/ai` 之后）：

```json
    "@petrel/database": "workspace:*"
```

`packages/agent/tsconfig.json` 的 `references` 改成：

```json
  "references": [{ "path": "../ai" }, { "path": "../database" }]
```

然后装一次依赖（workspace 链接）：

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" install
```

Expected: `+ @petrel/database <link>`。`tsconfig.base.json` 的 paths 与 `vitest.config.ts` 的 alias 都**不用改**（没有新增 package，`@petrel/database` 已在两处登记）。

- [ ] **Step 2: 写失败的契约测试**

`packages/agent/src/session/pg-storage.test.ts`。核心手法：**同一套断言跑两个实现**——PGlite 版与 pi 自带的 `InMemorySessionRepo`。语义等价是这个类唯一的正确性标准，拿对照实现比自己写期望值可靠。

```ts
import { InMemorySessionRepo, Session, type SessionStorage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { createSessionRepository } from "@petrel/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgSessionStorage } from "./pg-storage.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 两个被测实现：内存版是 pi 自己的参考实现，pg 版是我们要验证的 */
type Fixture = { storage: SessionStorage; session: Session };

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  await createSessionRepository(db).upsert({
    id: SESSION_ID,
    userId: TEST_USER_ID,
    title: "契约测试",
  });
});

async function memoryFixture(): Promise<Fixture> {
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  return { storage: session.getStorage(), session };
}

async function pgFixture(): Promise<Fixture> {
  // createdAt 由构造参数传入而不是查库：真实调用方（PgSessionRepo.open）
  // 打开会话时本来就要读 sessions 行，顺手带过来即可
  const storage = new PgSessionStorage(db, SESSION_ID, new Date());
  return { storage, session: new Session(storage) };
}

const IMPLEMENTATIONS: Array<[string, () => Promise<Fixture>]> = [
  ["InMemorySessionRepo（pi 参考实现）", memoryFixture],
  ["PgSessionStorage", pgFixture],
];

describe.each(IMPLEMENTATIONS)("SessionStorage 契约：%s", (_name, makeFixture) => {
  it("appendMessage 后 buildContext 拿回同一条消息", async () => {
    const { session } = await makeFixture();

    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "你好" }],
      timestamp: Date.now(),
    });

    const context = await session.buildContext();
    expect(context.messages).toHaveLength(1);
    expect(JSON.stringify(context.messages)).toContain("你好");
  });

  it("多条消息按 parent 链保序", async () => {
    const { session } = await makeFixture();

    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第一条" }],
      timestamp: Date.now(),
    });
    await session.appendMessage(fauxAssistantMessage([fauxText("第二条")]));
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第三条" }],
      timestamp: Date.now(),
    });

    const context = await session.buildContext();
    const text = JSON.stringify(context.messages);
    expect(context.messages).toHaveLength(3);
    expect(text.indexOf("第一条")).toBeLessThan(text.indexOf("第二条"));
    expect(text.indexOf("第二条")).toBeLessThan(text.indexOf("第三条"));
  });

  it("getLeafId 跟着 append 前进", async () => {
    const { session, storage } = await makeFixture();
    expect(await storage.getLeafId()).toBeNull();

    const id = await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: Date.now(),
    });

    expect(await storage.getLeafId()).toBe(id);
  });

  it("compaction 条目之后，上下文只剩摘要与保留尾部", async () => {
    const { session } = await makeFixture();
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "很久以前" }],
      timestamp: Date.now(),
    });
    await session.appendMessage(fauxAssistantMessage([fauxText("旧回答")]));
    const tail = fauxAssistantMessage([fauxText("保留下来的尾部")]);

    await session.appendCompaction("这是摘要", undefined, 1234, undefined, false, undefined, [tail]);

    const context = await session.buildContext();
    const text = JSON.stringify(context.messages);
    expect(text).toContain("这是摘要");
    expect(text).toContain("保留下来的尾部");
    // 被压缩掉的历史不再进上下文
    expect(text).not.toContain("很久以前");
  });

  it("model_change 与 active_tools_change 被 buildContext 还原", async () => {
    const { session } = await makeFixture();

    await session.appendModelChange("deepseek", "deepseek-v4-flash");
    await session.appendActiveToolsChange(["get_current_time"]);

    const context = await session.buildContext();
    expect(context.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-flash" });
    expect(context.activeToolNames).toEqual(["get_current_time"]);
  });

  it("getEntry 取不存在的 id 返回 undefined", async () => {
    const { storage } = await makeFixture();

    expect(await storage.getEntry("aaaaaaaa-0000-0000-0000-000000000099")).toBeUndefined();
  });

  it("appendSessionName 后 getSessionName 拿到最新的名字", async () => {
    const { session, storage } = await makeFixture();
    expect(await storage.getSessionName()).toBeUndefined();

    await session.appendSessionName("第一个名字");
    await session.appendSessionName("第二个名字");

    expect(await storage.getSessionName()).toBe("第二个名字");
  });

  it("appendLabel 后 getLabel 按目标条目取回", async () => {
    const { session, storage } = await makeFixture();
    const target = await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "被标记的消息" }],
      timestamp: Date.now(),
    });

    await session.appendLabel(target, "重要");

    expect(await storage.getLabel(target)).toBe("重要");
  });

  it("getEntries 的游标能续读", async () => {
    const { session, storage } = await makeFixture();
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "一" }],
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "二" }],
      timestamp: Date.now(),
    });

    const all = await storage.getEntries();
    expect(all).toHaveLength(2);
    const rest = await storage.getEntries({ afterEntrySeq: 1, limit: 10 });
    // 第一条的序号是 1，所以续读只剩第二条
    expect(rest).toHaveLength(1);
    expect(JSON.stringify(rest)).toContain("二");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/agent/src/session/pg-storage.test.ts
```

Expected: FAIL —— `Cannot find module './pg-storage.ts'`。内存版那一半用例此时也一起失败（同一个文件解析不了），这是正常的。

- [ ] **Step 4: 实现 `PgSessionStorage`**

`packages/agent/src/session/pg-storage.ts`：

```ts
import {
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import { createEntryRepository, type Database, type StoredEntry } from "@petrel/database";

/**
 * 条目在表里的存法：id / parent_id / timestamp / type 各占一列，其余字段进 payload。
 *
 * 拆出这两个函数而不是散在各方法里，是因为「拆」与「装」必须严格互逆——
 * 放在一起才看得出对不对。
 */
function toPayload(entry: SessionTreeEntry): Record<string, unknown> {
  const { id: _id, parentId: _parentId, timestamp: _timestamp, type: _type, ...rest } = entry;
  return rest as Record<string, unknown>;
}

function fromStored(stored: StoredEntry): SessionTreeEntry {
  return {
    ...(stored.payload as object),
    id: stored.id,
    parentId: stored.parentId,
    // pi 的 timestamp 是 ISO 字符串（SessionTreeEntryBase.timestamp: string）
    timestamp: stored.createdAt.toISOString(),
    type: stored.type,
  } as SessionTreeEntry;
}

/**
 * pi 的 SessionStorage 的 Postgres 实现。
 *
 * leafId 存成一条 `leaf` 类型条目（与 pi 自带的 jsonl 实现同构），不在 sessions 表上加列：
 * 会话树是 append-only 的事件日志，「当前叶子是谁」本身就是日志里的一条事件。
 *
 * 所有方法都按 sessionId 收窄。归属校验（userId）不在这一层——它发生在更外面的
 * HarnessRegistry.acquire，那里才有当前用户。这一层拿到 sessionId 就意味着已经过检。
 */
export class PgSessionStorage implements SessionStorage {
  private readonly entries: ReturnType<typeof createEntryRepository>;

  /**
   * @param createdAt 会话行的创建时间。由调用方（PgSessionRepo）在打开会话时读到后传入，
   *   这样 getMetadata() 不需要任何查询——它在 pi 内部被频繁调用，
   *   而「会话什么时候建的」在实例存活期间不会变。
   */
  constructor(
    db: Database,
    private readonly sessionId: string,
    private readonly createdAt: Date,
  ) {
    this.entries = createEntryRepository(db);
  }

  async getMetadata(): Promise<SessionMetadata> {
    return { id: this.sessionId, createdAt: this.createdAt.toISOString() };
  }

  async getLeafId(): Promise<string | null> {
    const leaf = await this.entries.latestLeaf(this.sessionId);
    if (!leaf) return null;
    return (leaf.payload as { targetId: string | null }).targetId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    await this.entries.append({
      id: uuidv7(),
      sessionId: this.sessionId,
      // leaf 条目自己不参与 parent 链：它是指针，不是历史的一部分
      parentId: null,
      type: "leaf",
      payload: { targetId: leafId },
    });
  }

  async createEntryId(): Promise<string> {
    return uuidv7();
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    await this.entries.append({
      id: entry.id,
      sessionId: this.sessionId,
      parentId: entry.parentId,
      type: entry.type,
      payload: toPayload(entry),
    });
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const stored = await this.entries.byId(this.sessionId, id);
    return stored ? fromStored(stored) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const rows = await this.entries.byType(this.sessionId, type);
    return rows.map(fromStored) as Array<Extract<SessionTreeEntry, { type: TType }>>;
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.entries.byType(this.sessionId, "label");
    // 同一个目标可以被反复贴标签，最后一条生效
    const latest = labels.filter(
      (row) => (row.payload as { targetId?: string }).targetId === id,
    ).at(-1);
    return latest ? (latest.payload as { label?: string }).label : undefined;
  }

  async getSessionName(): Promise<string | undefined> {
    const infos = await this.entries.byType(this.sessionId, "session_info");
    return (infos.at(-1)?.payload as { name?: string } | undefined)?.name;
  }

  async getSessionStats(): Promise<SessionStats> {
    const rows = await this.entries.byType(this.sessionId, "message");
    const stats: SessionStats = {
      messageCount: rows.length,
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    };
    for (const row of rows) {
      const usage = (row.payload as { message?: { usage?: Record<string, number> } }).message
        ?.usage;
      if (!usage) continue;
      stats.cachedTokens += usage.cacheReadTokens ?? 0;
      stats.uncachedTokens += usage.inputTokens ?? 0;
      stats.totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      stats.costTotal += usage.cost ?? 0;
    }
    return stats;
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    const rows = await this.entries.pathToRootOrCompaction(this.sessionId, leafId);
    return rows.map(fromStored);
  }

  async getEntries(options?: {
    afterEntrySeq?: number;
    limit?: number;
  }): Promise<SessionTreeEntry[]> {
    if (options?.afterEntrySeq === undefined) {
      const all = await this.entries.listAll(this.sessionId);
      return (options?.limit === undefined ? all : all.slice(0, options.limit)).map(fromStored);
    }
    const rows = await this.entries.listAfter(
      this.sessionId,
      options.afterEntrySeq,
      options.limit ?? Number.MAX_SAFE_INTEGER,
    );
    return rows.map(fromStored);
  }
}
```

`fromStored` 里 `timestamp` 用 `createdAt.toISOString()`：pi 的 `SessionTreeEntryBase.timestamp` 是 **string** 而不是 number（已核对 `harness/types.d.ts:244`），写成 `Date.now()` 会通过 TS 但让 pi 的排序与展示拿到错误类型。

- [ ] **Step 5: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/agent/src/session/pg-storage.test.ts
```

Expected: PASS，20 个用例（10 条断言 × 2 个实现）全绿。

两类失败要区别处置：
- **两个实现都红** → 断言本身对 pi 的语义理解错了，改测试。
- **只有 pg 版红** → `PgSessionStorage` 的实现有问题，改实现。这正是双实现对照要买到的信息。

- [ ] **Step 6: typecheck**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run typecheck
```

Expected: 零 error。这一步不能跳：`SessionStorage` 有 12 个方法，漏实现一个或签名不匹配时 vitest 可能照样绿（测试只覆盖用到的那几个），而 `implements` 的报错只有 tsc 看得见。

- [ ] **Step 7: 提交**

```bash
git add packages/agent/package.json packages/agent/tsconfig.json packages/agent/src/session/pg-storage.ts packages/agent/src/session/pg-storage.test.ts pnpm-lock.yaml
git commit -m "feat(agent): SessionStorage 的 Postgres 实现"
```

---

### Task 4: `createHarness()`

`createAgent()` 的替代品。**`createAgent` 本任务不删**（Task 9 才删），这样每一步都能保持全绿。

**Files:**
- Create: `packages/agent/src/harness.ts`
- Create: `packages/agent/src/harness.test.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: 写失败的测试**

`packages/agent/src/harness.test.ts`。用 `InMemorySessionRepo` 而不是 PGlite：**agent 包的测试必须不需要数据库也能跑**（验收标准 5）。

```ts
import { InMemorySessionRepo, type AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 用 pi 自带的 faux provider + 内存 session 跑真实 harness，无需模型凭据也无需数据库 */
async function fauxHarness(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({ session, models, model: faux.getModel() });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, session, events };
}

/** session 里所有 message 条目的 role 序列 */
async function storedRoles(session: Awaited<ReturnType<typeof fauxHarness>>["session"]) {
  const entries = await session.getEntries();
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: { role: string } }).message.role);
}

describe("createHarness", () => {
  it("一轮对话后 user 与 assistant 都进了 session", async () => {
    const { faux, harness, session } = await fauxHarness();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel。")])]);

    await harness.prompt("你好");

    // 落库由 harness 自己完成，没有任何事件订阅落库代码参与
    expect(await storedRoles(session)).toEqual(["user", "assistant"]);
    const entries = await session.getEntries();
    expect(JSON.stringify(entries)).toContain("你好，我是 Petrel。");
  });

  it("工具循环：toolResult 也落进 session", async () => {
    const { faux, harness, session, events } = await fauxHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_current_time", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("现在已经查到时间了。")]),
    ]);

    await harness.prompt("现在几点");

    expect(await storedRoles(session)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(events.map((e) => e.type)).toContain("tool_execution_end");
  });

  it("followUp 的消息在同一个 run 内被消化，agent_end 只发一次", async () => {
    const { faux, harness, session, events } = await fauxHarness({ tokensPerSecond: 50 });
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一轮回答")]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const running = harness.prompt("第一个问题");
    // 等第一轮真的开跑（phase 是私有的，只能靠事件判断）
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.followUp("第二个问题");
    await running;
    await harness.waitForIdle();

    expect(await storedRoles(session)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // 这是 SSE 能用「收到 settled 就收尾」的依据：整个 run 只发一次
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "settled")).toHaveLength(1);
  });

  it("systemPrompt 传给模型", async () => {
    const { faux, harness } = await fauxHarness();
    let seenSystem: string | undefined;
    faux.setResponses([
      (context) => {
        seenSystem = context.systemPrompt;
        return fauxAssistantMessage([fauxText("好")]);
      },
    ]);

    // systemPrompt 只在装配时能给：AgentHarness 没有 setSystemPrompt()
    const { faux: faux2, harness: harness2 } = await fauxHarness();
    void faux2;
    void harness2;
    await harness.prompt("你好");

    expect(seenSystem).toContain("Petrel");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/agent/src/harness.test.ts
```

Expected: FAIL —— `Cannot find module './harness.ts'`。

- [ ] **Step 3: 实现**

`packages/agent/src/harness.ts`：

```ts
import {
  AgentHarness,
  type AgentHarnessTool,
  Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defaultModel, models as defaultModels } from "@petrel/ai";
import type { Database } from "@petrel/database";
import { PgSessionStorage } from "./session/pg-storage.ts";
import { currentTime } from "./tools/current-time.ts";

export const DEFAULT_SYSTEM_PROMPT = "你是 Petrel 智能助手。回答简洁准确，需要实时信息时调用工具。";

/**
 * 打开一个落在 Postgres 上的会话。
 *
 * 与 createHarness 分开导出，是为了让 harness 的装配可以脱离数据库测试：
 * 测试注入 pi 自带的内存 session，生产注入这一个。
 */
export function createPgSession(db: Database, sessionId: string, createdAt: Date): Session {
  return new Session(new PgSessionStorage(db, sessionId, createdAt));
}

export interface CreateHarnessOptions {
  /** 会话状态的载体。生产用 createPgSession()，测试用 InMemorySessionRepo。 */
  session: Session;
  /**
   * 系统提示。只在装配时生效——AgentHarness 没有 setSystemPrompt()，
   * 常驻实例被复用时后续请求传的 systemPrompt 不会生效（见 spec §5）。
   */
  systemPrompt?: string;
  tools?: AgentHarnessTool<undefined>[];
  /** 模型集合，测试注入 faux provider。 */
  models?: Models;
  model?: Model<Api>;
}

/**
 * 装配一个 pi AgentHarness。所有 pi 的接线都收在这个包里，
 * 上层只依赖本函数与 harness 的事件流，便于将来替换内核。
 *
 * 与被它取代的 createAgent 的关键区别：
 * 1. 吃 models 而不是 streamFn（AgentHarness 自己建 streamFn）；
 * 2. 不吃 messages——历史不再由调用方回灌，harness 自己从 session 读；
 * 3. 落库由 harness 通过 session 完成，不需要外部订阅事件写库。
 */
export function createHarness(options: CreateHarnessOptions): AgentHarness {
  const models = options.models ?? defaultModels;
  return new AgentHarness({
    session: options.session,
    models,
    model: options.model ?? defaultModel(),
    tools: options.tools ?? [currentTime],
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  });
}
```

`packages/agent/src/index.ts` 追加导出（`createAgent` 的导出保持不动）：

```ts
export type { AgentHarness, AgentHarnessEvent, Session } from "@earendil-works/pi-agent-core";
export { createHarness, createPgSession, type CreateHarnessOptions } from "./harness.ts";
export { PgSessionStorage } from "./session/pg-storage.ts";
```

`DEFAULT_SYSTEM_PROMPT` 现在有两处定义（`index.ts` 与 `harness.ts`）。**不要在这个任务里合并**——`createAgent` 还在用它。Task 9 删 `createAgent` 时把 `index.ts` 里那份删掉，只留 `harness.ts` 的，并从 `harness.ts` 重新导出。

- [ ] **Step 4: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run packages/agent
```

Expected: PASS。`agent.test.ts`（旧的 createAgent 测试）与 `harness.test.ts` 同时绿。

第三个用例（followUp）若报「followUp 抛 invalid_state」，说明 `setTimeout(10)` 没等到 run 真正开始（faux 太快）。把 `tokensPerSecond` 再调低或改成等 `agent_start` 事件出现：

```ts
    await new Promise<void>((resolve) => {
      const stop = harness.subscribe((event) => {
        if (event.type === "agent_start") {
          stop();
          resolve();
        }
      });
    });
```

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/harness.ts packages/agent/src/harness.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): createHarness 装配 AgentHarness"
```

---

### Task 5: `HarnessRegistry`

按 sessionId 缓存常驻 harness。这是本计划里最需要小心的一个单元：它同时管归属校验、并发串行化、内存上限。

**Files:**
- Create: `apps/server/src/services/harness-registry.ts`
- Create: `apps/server/src/services/harness-registry.test.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server/src/services/harness-registry.test.ts`：

```ts
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHarness } from "@petrel/agent";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarnessRegistry } from "./harness-registry.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000ff";

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(() => reset());

/** 可控时钟，用来测 idle 回收而不用真的等 5 分钟 */
function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/**
 * 用内存 session + faux provider 造 harness，避免测试触碰真实模型。
 *
 * @param chunked 打开后回答被切成小块慢慢吐，用来制造「第一轮还在跑」这个时刻
 */
function fauxFactory(chunked = false) {
  const faux = chunked
    ? fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } })
    : fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxText("答")]),
    fauxAssistantMessage([fauxText("答")]),
    fauxAssistantMessage([fauxText("答")]),
  ]);
  let created = 0;
  return {
    faux,
    get created() {
      return created;
    },
    /** 返回 { harness, session } 两者：registry 需要 session 来读 transcript，
     *  而 harness 不对外暴露它自己的 session */
    async create(sessionId: string) {
      created += 1;
      const session = await new InMemorySessionRepo().create({ id: sessionId });
      return { harness: createHarness({ session, models, model: faux.getModel() }), session };
    },
  };
}

describe("createHarnessRegistry", () => {
  it("同一会话第二次 acquire 复用同一个实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(second.harness).toBe(first.harness);
    expect(factory.created).toBe(1);
  });

  it("会话 id 属于别人时拒绝，且不装配实例", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const owned = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    owned.release();

    await expect(registry.acquire(SESSION_ID, OTHER_USER_ID, "偷看")).rejects.toThrow(
      /不存在或无权访问/,
    );
    // 关键断言：越权请求不能拿到别人的活实例
    expect(factory.created).toBe(1);
  });

  it("idle 超过 TTL 后被回收，下次 acquire 重新装配", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    time.advance(1001);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(factory.created).toBe(2);
    expect(second.harness).not.toBe(first.harness);
  });

  it("还有活连接（refCount > 0）时不回收", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });

    const held = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    time.advance(10_000);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();
    held.release();

    expect(factory.created).toBe(1);
  });

  it("容量到顶且没有可淘汰的实例时抛容量错误", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      maxSessions: 1,
    });
    const sessionRepo = (await import("@petrel/database")).createSessionRepository(db);
    await sessionRepo.upsert({ id: SESSION_ID, userId: TEST_USER_ID, title: "a" });
    const second = "22222222-2222-2222-2222-222222222222";
    await sessionRepo.upsert({ id: second, userId: TEST_USER_ID, title: "b" });

    // 第一个不释放，占满容量
    await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");

    await expect(registry.acquire(second, TEST_USER_ID, "另一个会话")).rejects.toThrow(
      /容量/,
    );
  });

  it("容量到顶但有 idle 实例时，淘汰最旧的那个", async () => {
    const factory = fauxFactory();
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      maxSessions: 1,
    });
    const second = "22222222-2222-2222-2222-222222222222";

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    time.advance(10);

    const other = await registry.acquire(second, TEST_USER_ID, "另一个会话");
    other.release();

    expect(factory.created).toBe(2);
    // 第一个已被淘汰，再要就是第三次装配
    const again = await registry.acquire(SESSION_ID, TEST_USER_ID, "回来了");
    again.release();
    expect(factory.created).toBe(3);
  });

  it("evict 后实例不再被复用", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    first.release();
    await registry.evict(SESSION_ID);
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(factory.created).toBe(2);
  });

  it("运行中的第二条消息走 followUp，在同一个 run 内被消化", async () => {
    // 慢速吐字，保证第二个 send 进临界区时第一轮真的还在跑
    const factory = fauxFactory(true);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const types: string[] = [];
    handle.harness.subscribe((event) => {
      types.push(event.type);
    });

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await Promise.all([first, second]);
    await handle.harness.waitForIdle();
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
    // 这条才是真正区分 followUp 与 prompt 的断言：followUp 的消息在同一个 run 内，
    // 所以整个过程只有一次 agent_end。两条都走 prompt 的话这里会是 2
    expect(types.filter((type) => type === "agent_end")).toHaveLength(1);
  });

  it("abort 只对属于自己的会话生效", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    handle.release();

    await expect(registry.abort(SESSION_ID, OTHER_USER_ID)).rejects.toThrow(/不存在或无权访问/);
    // 属于自己时幂等成功，即使当前没在跑
    await expect(registry.abort(SESSION_ID, TEST_USER_ID)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server/src/services/harness-registry.test.ts
```

Expected: FAIL —— `Cannot find module './harness-registry.ts'`。

- [ ] **Step 3: 实现**

`apps/server/src/services/harness-registry.ts`：

```ts
import type { AgentHarness, Session } from "@petrel/agent";
import { createHarness as createRealHarness, createPgSession } from "@petrel/agent";
import { createSessionRepository, type Database } from "@petrel/database";
import { logger } from "@petrel/logger";
import { HTTPException } from "hono/http-exception";

/** 空闲多久后回收。5 分钟：够覆盖「用户读完回答再追问」，又不会让内存长期挂着。 */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * 同时常驻的会话上限。
 *
 * 200 是单副本内部使用的估值，不是实测值：每个实例常驻的是一颗上下文树的引用，
 * 实际占用取决于会话长度。压测后按真实内存调整，调的时候同步改 spec §5。
 */
const DEFAULT_MAX_SESSIONS = 200;

interface Entry {
  harness: AgentHarness;
  session: Session;
  /** 有几个 SSE 连接正在用它。> 0 时不回收。 */
  refCount: number;
  lastUsedAt: number;
  /**
   * 是否正在跑一轮。
   *
   * AgentHarness.phase 是私有字段、没有 getter，所以只能自己跟：
   * agent_start 置真、settled 置假（settled 在 agent_end 之后发，且整个 run
   * 只发一次，followUp 排队的消息也在同一个 run 内，见 spec §2.3）。
   */
  running: boolean;
  /** 同一会话的调用串行化，避免「判断 running 时空闲、调用时已在跑」的竞态。 */
  chain: Promise<unknown>;
}

export interface HarnessHandle {
  harness: AgentHarness;
  session: Session;
  /** 空闲则 prompt，运行中则排进 followUp 队列。 */
  send(message: string): Promise<void>;
  /** 释放这个连接对实例的占用，允许它被回收。 */
  release(): void;
}

export interface HarnessRegistryOptions {
  db: Database;
  /**
   * 装配 harness。测试注入 faux provider + 内存 session。
   * 返回 session 而不是从 harness 上取：harness 不对外暴露自己的 session，
   * 而 registry 要把它交给调用方（读 transcript、投影历史）。
   */
  createHarness?: (sessionId: string) => Promise<{ harness: AgentHarness; session: Session }>;
  now?: () => number;
  idleTtlMs?: number;
  maxSessions?: number;
}

export function createHarnessRegistry(options: HarnessRegistryOptions) {
  const { db } = options;
  const now = options.now ?? (() => Date.now());
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionRepo = createSessionRepository(db);
  const entries = new Map<string, Entry>();

  /**
   * 惰性清理，不用 setInterval：定时器要管生命周期（测试里要 unref、进程退出要 clear），
   * 而清理只在 acquire 时才有意义——没有新请求时留着几个过期实例不造成问题。
   */
  function sweep(): void {
    for (const [sessionId, entry] of entries) {
      if (entry.refCount === 0 && !entry.running && now() - entry.lastUsedAt > idleTtlMs) {
        entries.delete(sessionId);
      }
    }
  }

  /** 容量到顶时淘汰最旧的空闲实例。@returns 是否腾出了位置 */
  function evictOldestIdle(): boolean {
    let oldest: [string, Entry] | undefined;
    for (const pair of entries) {
      const [, entry] = pair;
      if (entry.refCount > 0 || entry.running) continue;
      if (!oldest || entry.lastUsedAt < oldest[1].lastUsedAt) oldest = pair;
    }
    if (!oldest) return false;
    entries.delete(oldest[0]);
    return true;
  }

  async function build(sessionId: string, createdAt: Date, systemPrompt?: string): Promise<Entry> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : (() => {
          const session = createPgSession(db, sessionId, createdAt);
          // systemPrompt 只有这一次机会生效：AgentHarness 没有 setSystemPrompt()
          return { harness: createRealHarness({ session, systemPrompt }), session };
        })();
    const { harness, session } = built;

    const entry: Entry = {
      harness,
      session,
      refCount: 0,
      lastUsedAt: now(),
      running: false,
      chain: Promise.resolve(),
    };

    // 这一份订阅跟着实例活一辈子，与每个请求各自的 SSE 订阅无关。
    // listener 里只做同步赋值：pi 会 await listener 并把异常计入 run 的 settlement，
    // 抛异常会影响 agent 本身运行
    harness.subscribe((event) => {
      if (event.type === "agent_start") {
        entry.running = true;
      } else if (event.type === "settled") {
        entry.running = false;
        entry.lastUsedAt = now();
      }
    });

    return entry;
  }

  return {
    /**
     * 取一个会话的 harness。
     *
     * 归属校验就是这里的 upsert：会话 id 由前端生成，冲突且不属于自己时
     * DO UPDATE 不执行、returning 为空。**这一步必须在装配之前**——
     * 缓存 key 只有 sessionId，越权请求一旦走到装配就能拿到别人的活实例。
     */
    async acquire(
      sessionId: string,
      userId: string,
      firstMessage: string,
      systemPrompt?: string,
    ): Promise<HarnessHandle> {
      if (!(await sessionRepo.upsert({ id: sessionId, userId, title: buildTitle(firstMessage) }))) {
        throw new HTTPException(403, { message: "会话不存在或无权访问" });
      }

      sweep();

      let entry = entries.get(sessionId);
      if (!entry) {
        if (entries.size >= maxSessions && !evictOldestIdle()) {
          logger.error({ sessionId, size: entries.size }, "harness registry at capacity");
          throw new HTTPException(503, { message: "服务繁忙，请稍后重试（会话容量已满）" });
        }
        const row = await sessionRepo.findById(sessionId, userId);
        entry = await build(sessionId, row?.createdAt ?? new Date(), systemPrompt);
        entries.set(sessionId, entry);
      }

      const held = entry;
      held.refCount += 1;
      held.lastUsedAt = now();

      let released = false;
      return {
        harness: held.harness,
        session: held.session,
        /**
         * 空闲则 prompt，运行中则 followUp。
         *
         * chain 保护的临界区**只有「判断 running + 发起调用」**，绝不能把
         * 「等整轮跑完」也串进去：那样第二个请求会排在第一轮结束之后才发起，
         * 此时 running 已是 false，于是永远走 prompt，followUp 分支形同虚设。
         *
         * running 在发起 prompt 时**同步**置真，而不是等 agent_start 事件——
         * 事件是异步发出的，下一个请求完全可能在那之前就进到临界区。
         */
        send(message: string): Promise<void> {
          let outcome: Promise<void> | undefined;
          const started = held.chain.then(() => {
            if (held.running) {
              // followUp 只是 push 队列 + emit，是瞬时的，等它返回再放行下一个。
              // 它在 harness 内部 phase === "idle" 时会抛 invalid_state，而我们的 running
              // 与那个私有字段之间可能有一瞬不同步（比如上一轮刚好在这两句之间跑完），
              // 所以退回 prompt 而不是把错误抛给用户
              outcome = held.harness.followUp(message).catch((error) => {
                logger.warn({ err: error, sessionId }, "followUp rejected, falling back to prompt");
                held.running = true;
                return held.harness
                  .prompt(message)
                  .then(() => undefined)
                  .finally(() => {
                    held.running = false;
                    held.lastUsedAt = now();
                  });
              });
              return outcome;
            }
            held.running = true;
            outcome = held.harness
              .prompt(message)
              .then(() => undefined)
              // settled 事件通常已经复位过；这里兜住「prompt 抛异常没走到 agent_end」
              // 的情况，否则这个会话会永远卡在 running=true，再也接不了新消息
              .finally(() => {
                held.running = false;
                held.lastUsedAt = now();
              });
            // 不 return outcome：chain 到此放行，下一个请求会看到 running=true
            return undefined;
          });
          held.chain = started.catch(() => undefined);
          return started.then(() => outcome);
        },
        release() {
          // 幂等：SSE 的正常收尾与 onAbort 都会调它
          if (released) return;
          released = true;
          held.refCount -= 1;
          held.lastUsedAt = now();
        },
      };
    },

    /** 显式停止。连接断开不再等于停止，所以这是唯一的中断入口。 */
    async abort(sessionId: string, userId: string): Promise<void> {
      if (!(await sessionRepo.findById(sessionId, userId))) {
        throw new HTTPException(403, { message: "会话不存在或无权访问" });
      }
      // 没有活实例时什么都不做：abort 一个已经跑完的会话不是错误
      await entries.get(sessionId)?.harness.abort();
    },

    /** 会话被删除或用户被禁用时调用，否则内存里还有个活实例往已删会话写。 */
    async evict(sessionId: string): Promise<void> {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entries.delete(sessionId);
      await entry.harness.abort();
    },

    /** 仅供测试与监控。 */
    size(): number {
      return entries.size;
    },
  };
}

const TITLE_MAX_LENGTH = 30;
const FALLBACK_TITLE = "新对话";

/**
 * 标题取首条用户消息的前 30 字。与 services/session.ts 的 buildTitle 同源——
 * Task 9 会把 session.ts 的那份删掉，统一用这里的。
 */
function buildTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return FALLBACK_TITLE;
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}
```

两个容易写错的点，已经体现在上面的代码里，实现时不要「简化」掉：

- **`session` 由工厂一并返回**，不从 harness 上取。`AgentHarness` 没有暴露 `session`，
  用 `as unknown as { session }` 去挖私有字段会在 pi 升级时无声崩掉。
- **`held.chain` 不等 `prompt()` 完成**（见 `send` 的注释）。这是 followUp 分支能否被走到的关键，
  也是 `harness-registry.test.ts` 最后两个用例真正在守的东西。

- [ ] **Step 4: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server/src/services/harness-registry.test.ts
```

Expected: PASS，10 个用例全绿。

- [ ] **Step 5: 加开流前的降级路径（spec §6 上半）**

会话表读写不了时，本轮降级成一个**不落库的内存会话**：照常对话，只是这一轮记不住。
「能用但记不住」好过直接不能用，与认证落地前的降级语义一致。

先在 `packages/agent/src/harness.ts` 加一个导出：

```ts
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";

/**
 * 一次性的内存会话，用于会话表不可用时的降级。
 * 进程重启即丢——这正是「本轮不落库」想要的效果。
 */
export function createMemorySession(sessionId: string): Promise<Session> {
  return new InMemorySessionRepo().create({ id: sessionId });
}
```

`packages/agent/src/index.ts` 的导出补上 `createMemorySession`。

再在 registry 里加降级分支。`acquire` 的开头改成：

```ts
      let owned: boolean;
      try {
        owned = await sessionRepo.upsert({
          id: sessionId,
          userId,
          title: buildTitle(firstMessage),
        });
      } catch (error) {
        // 注意与 owned === false 的区别：那是越权（必须 403），这是故障（可以降级）。
        // 降级实例不进缓存——它没有经过归属校验，留在 Map 里会被后续请求错误复用
        logger.error(
          { err: error, sessionId },
          "session store unavailable, degrading to memory session",
        );
        return ephemeral(sessionId, systemPrompt);
      }
      if (!owned) {
        throw new HTTPException(403, { message: "会话不存在或无权访问" });
      }
```

并在 `build` 旁边加：

```ts
  /**
   * 降级用的一次性 handle：内存会话、不进缓存、不需要 running 标记与 chain
   * （它只服务当前这一个请求，不存在第二个请求撞上来的可能）。
   */
  async function ephemeral(sessionId: string, systemPrompt?: string): Promise<HarnessHandle> {
    const built = options.createHarness
      ? await options.createHarness(sessionId)
      : await (async () => {
          const session = await createMemorySession(sessionId);
          return { harness: createRealHarness({ session, systemPrompt }), session };
        })();
    return {
      harness: built.harness,
      session: built.session,
      send: (message) => built.harness.prompt(message).then(() => undefined),
      release: () => undefined,
    };
  }
```

import 补 `createMemorySession`。

补一条用例：

```ts
  it("会话表读写失败时降级成内存会话，对话仍然能跑且不进缓存", async () => {
    const factory = fauxFactory();
    // 传一个不可用的 db：sessionRepo.upsert 会抛（db.insert 不是函数），触发降级分支
    const registry = createHarnessRegistry({
      db: {} as unknown as TestDb,
      createHarness: factory.create,
    });

    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    await handle.send("你好");
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).toContain("你好");
    // 降级实例不缓存，否则后面的请求会拿到一个没验过归属的实例
    expect(registry.size()).toBe(0);
  });
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server/src/services/harness-registry.test.ts packages/agent
```

Expected: PASS，11 个 registry 用例 + agent 包全绿。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/services/harness-registry.ts apps/server/src/services/harness-registry.test.ts packages/agent/src/harness.ts packages/agent/src/index.ts
git commit -m "feat(server): 按会话缓存常驻 harness"
```

---

### Task 6: chat 路由切到 harness + abort 端点

这一步之后 `messages` 表不再被写入（但表还在，Task 9 才删）。

**Files:**
- Modify: `apps/server/src/http/routes/chat.ts`
- Modify: `apps/server/src/http/routes/chat.test.ts`

- [ ] **Step 1: 改 chat 路由**

`apps/server/src/http/routes/chat.ts` 全文替换为：

```ts
import { getDb } from "@petrel/database";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { createHarnessRegistry } from "../../services/harness-registry.ts";
import type { AppEnv } from "../../types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * registry 是进程级单例：常驻实例的全部意义就是跨请求复用，
 * 每个请求建一个等于没有缓存。
 *
 * 懒初始化而不是模块顶层建：getDb() 会建连接池，顶层调用会让「只导入 app 就连数据库」，
 * 校验类用例也就没法脱离数据库跑（同 routes/sessions.ts 的注释）。
 */
let registry: ReturnType<typeof createHarnessRegistry> | undefined;

/** 导出给 sessions / admin 路由用：删会话、禁用用户时要清掉活实例 */
export function getRegistry() {
  registry ??= createHarnessRegistry({ db: getDb() });
  return registry;
}

/** 仅供测试：单例会跨测试文件把上一个 PGlite 实例带过来 */
export function __resetRegistry(): void {
  registry = undefined;
}

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 message，
 * 直接 body.message?.trim() 会抛成 500——客户端错误报成服务端错误。
 *
 * 校验顺序是 message 先于 sessionId：空消息是最常见的误用。
 */
function parseChatRequest(body: unknown) {
  const fields = body as { message?: unknown; sessionId?: unknown; systemPrompt?: unknown } | null;

  const message = typeof fields?.message === "string" ? fields.message.trim() : "";
  if (!message) {
    throw new HTTPException(400, { message: "message 必须是非空字符串" });
  }

  const sessionId = fields?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }

  const rawSystemPrompt = fields?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === "string" ? rawSystemPrompt : undefined;

  return { message, sessionId, systemPrompt };
}

function requireSessionId(body: unknown): string {
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }
  return sessionId;
}

export const chat = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const { message, sessionId, systemPrompt } = parseChatRequest(body);

    // acquire 里的 upsert 同时完成归属校验与建会话；不属于自己时抛 403。
    // 放在 streamSSE 之外：一旦开了流就只能在流里报错了
    const handle = await getRegistry().acquire(
      sessionId,
      c.get("currentUser").id,
      message,
      systemPrompt,
    );

    return streamSSE(c, async (stream) => {
      // pi 的事件原样透传，前端按事件类型归约为消息状态。
      // 订阅是会话级的，所以同一会话的另一个连接的输出也会流过来——
      // 它们本来就是这个会话的消息，前端按消息 id 归约，多标签页因此自动同步
      const unsubscribe = handle.harness.subscribe(async (event) => {
        await stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
      });

      // 连接断开只退订，不 abort：harness 常驻，回答继续跑完并落库。
      // 用户主动停止走 POST /api/chat/abort
      stream.onAbort(() => {
        unsubscribe();
        handle.release();
      });

      try {
        await handle.send(message);
      } catch (error) {
        logger.error({ err: error, sessionId }, "agent run failed");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        });
      } finally {
        unsubscribe();
        handle.release();
      }
    });
  })

  /**
   * 显式停止。连接断开不再等于停止（见 spec §5），所以这是唯一的中断入口。
   * 会话已经跑完时幂等成功——abort 一个结束了的会话不是错误。
   */
  .post("/abort", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const sessionId = requireSessionId(body);

    await getRegistry().abort(sessionId, c.get("currentUser").id);
    return c.json({ ok: true });
  });
```

- [ ] **Step 2: 改 chat.test.ts 的替身与夹具**

顶部的两个 `vi.mock` 保留（`@petrel/database` 那个不动），把 `@petrel/agent` 的替身从 `createAgent` 换成 `createHarness`：

```ts
vi.mock("@petrel/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/agent")>();
  return {
    ...actual,
    // 底下调的仍是真的 createHarness，只是补上 faux 的 models/model，
    // 所以 harness、agent loop、落库都是真在跑，没有 mock 任何内部
    createHarness: (options: CreateHarnessOptions) =>
      actual.createHarness({ ...options, ...state.harnessOptions }),
  };
});
```

`state` 里把 `agentOptions` 改成：

```ts
  harnessOptions: undefined as Partial<CreateHarnessOptions> | undefined,
```

import 改为 `import { type CreateHarnessOptions, DEFAULT_SYSTEM_PROMPT } from "@petrel/agent";`，
并删掉 `createMessageRepository` 的 import 与 `messageRepo` 变量（改用 entries 读断言）：

```ts
import { createEntryRepository } from "@petrel/database";
...
let entryRepo: ReturnType<typeof createEntryRepository>;
```

`beforeEach` 里加一行重置 registry 单例（否则第二个测试文件拿到的是上一个的 db）：

```ts
  __resetRegistry();
```

并把它 import 进来：`import { __resetRegistry } from "./chat.ts";`

新增一个读 transcript 的辅助函数（替代原来读 messages 表的断言）：

```ts
/** 会话里所有 message 条目的 role 序列，用来替代原先对 messages 表的 seq 断言 */
async function storedRoles(sessionId = SESSION_ID): Promise<string[]> {
  const rows = await entryRepo.listAll(sessionId);
  return rows
    .filter((row) => row.type === "message")
    .map((row) => (row.payload as { message: { role: string } }).message.role);
}
```

- [ ] **Step 3: 删除已经不适用的用例，改写落库用例**

**删掉**这四个（它们守的对象已不存在）：

- `一轮对话后 user 与 assistant 都落库，seq 从 1 连续` → 改写见下
- `第二轮把上一轮的历史回灌给模型，seq 接着往下排` → 改写见下（不再有「回灌」这个动作）
- `并发打同一个 sessionId，两轮都完整落库且 seq 连续无洞` → 改写成 followUp 排队
- `【已知问题】中断后重发，半截消息排到了下一轮用户消息之后` → **这个问题被树模型消掉了**，删掉整条用例，并在 backend-plan 里把它从「已知问题」移到「已解决」（Task 10）

**改写/新增**：

```ts
  it("一轮对话后 user 与 assistant 都进了会话树", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    await readAll(response);

    expect(await storedRoles()).toEqual(["user", "assistant"]);
  });

  it("第二轮能看到第一轮的上下文，不需要调用方回灌", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("第一轮回答")])]);
    await readAll(await postChat({ message: "第一个问题", sessionId: SESSION_ID }));

    let seen: unknown[] | undefined;
    faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage([fauxText("第二轮回答")]);
      },
    ]);
    await readAll(await postChat({ message: "第二个问题", sessionId: SESSION_ID }));

    // 历史由 harness 自己从 session 读出来，chat 路由一行回灌代码都没有
    expect(JSON.stringify(seen)).toContain("第一轮回答");
    expect(await storedRoles()).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("连接断开后 agent 继续跑完，回答完整落库", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    state.harnessOptions = { models: chunkedModels, model: chunkedModel };

    const controller = new AbortController();
    const response = await app.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ message: "讲个长故事", sessionId: SESSION_ID }),
        signal: controller.signal,
      },
      undefined,
    );
    // 读到第一块就掐断连接
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // 关键：断开不再等于停止，等它自己跑完
    await vi.waitFor(async () => {
      const roles = await storedRoles();
      expect(roles).toEqual(["user", "assistant"]);
    }, 5000);
    const rows = await entryRepo.listAll(SESSION_ID);
    expect(JSON.stringify(rows)).toContain(LONG_ANSWER);
  });

  it("同一会话连发两条，第二条排队后也落库", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一轮回答")]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const [first, second] = await Promise.all([
      postChat({ message: "第一个问题", sessionId: SESSION_ID }),
      postChat({ message: "第二个问题", sessionId: SESSION_ID }),
    ]);
    await Promise.all([readAll(first), readAll(second)]);

    await vi.waitFor(async () => {
      expect(await storedRoles()).toEqual(["user", "assistant", "user", "assistant"]);
    }, 5000);
  });

  it("POST /api/chat/abort 停掉正在跑的会话", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText(LONG_ANSWER)])]);
    state.harnessOptions = { models: chunkedModels, model: chunkedModel };

    const streaming = postChat({ message: "讲个长故事", sessionId: SESSION_ID });
    const response = await streaming;
    const reader = response.body!.getReader();
    await reader.read();

    const aborted = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(aborted.status).toBe(200);

    await reader.cancel().catch(() => undefined);
    // 半截回答仍然落库，标记由消息自带的 stopReason 表达，不再有 interrupted 列
    await vi.waitFor(async () => {
      const rows = await entryRepo.listAll(SESSION_ID);
      expect(JSON.stringify(rows)).toContain('"stopReason":"aborted"');
    }, 5000);
  });

  it("abort 别人的会话返回 403", async () => {
    const otherCookie = await registerAndLogin("other@example.com");
    const response = await app.request("/api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(403);
  });

  it("systemPrompt 只在会话首次装配时生效", async () => {
    const seen: (string | undefined)[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("一")]);
      },
      (context) => {
        seen.push(context.systemPrompt);
        return fauxAssistantMessage([fauxText("二")]);
      },
    ]);

    await readAll(
      await postChat({ message: "一", sessionId: SESSION_ID, systemPrompt: "第一个提示" }),
    );
    await readAll(
      await postChat({ message: "二", sessionId: SESSION_ID, systemPrompt: "第二个提示" }),
    );

    // AgentHarness 没有 setSystemPrompt()，常驻实例被复用时第二次的提示不生效。
    // 这条用例存在的意义就是把这个行为钉住，否则将来有人传了新提示却查不出为什么没用
    expect(seen[0]).toBe("第一个提示");
    expect(seen[1]).toBe("第一个提示");
  });
```

其中 `postChat` / `readAll` / `registerAndLogin` / `cookie` / `chunkedModels` / `chunkedModel` 用文件里**已有**的同名辅助（原文件已有 `CHUNKED` 常量与登录辅助）；若某个辅助原文件没有，按下面的形状补：

```ts
/** 发一次对话请求，带当前用户的 cookie */
function postChat(body: { message: string; sessionId: string; systemPrompt?: string }) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/** 把 SSE 流读干，返回原文 */
async function readAll(response: Response): Promise<string> {
  return response.text();
}
```

- [ ] **Step 4: 改写降级用例**

原用例 `已登录但会话仓储查库失败时照常流式输出，只是这一轮不落库` 的**结论仍然成立**（Task 5 Step 5 的降级路径就是为它准备的），但断言方式要换：不再有 `messages` 表可查，改成查 entries 为空。

```ts
  it("已登录但会话仓储查库失败时照常流式输出，只是这一轮不落库", async () => {
    state.sessionRepoBroken = true;
    faux.setResponses([fauxAssistantMessage([fauxText("降级也能答")])]);

    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const body = await readAll(response);

    // upsert 抛错 → 降级成内存会话，SSE 照常输出
    expect(response.status).toBe(200);
    expect(body).toContain("降级也能答");
    expect(body).not.toContain("event: error");
    // 但这一轮什么都没落库
    expect(await storedRoles()).toEqual([]);
  });
```

`state.sessionRepoBroken` 现在要让 `upsert` **抛错**（而不是返回 false）——原有的替身已经是 `upsert: () => Promise.reject(...)`，正好，不用改。

**注意区分两条路径**，这也是这条用例存在的价值：`upsert` 返回 `false` 是越权（403），`upsert` 抛错是故障（降级）。两者共用一个返回值就会把越权也降级成「照常对话」，等于把归属校验绕过去了。补一条守它：

```ts
  it("会话 id 属于别人时返回 403，不降级", async () => {
    // 先用当前用户建出这个会话
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    await readAll(await postChat({ message: "你好", sessionId: SESSION_ID }));

    const otherCookie = await registerAndLogin("other@example.com");
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ message: "偷看", sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(403);
  });
```

保留 `数据库不可用时鉴权本身就会失败，请求进不到 chat handler`（认证仍然每请求查库，行为不变）。

- [ ] **Step 5: 运行测试**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server
```

Expected: PASS。`sessions.test.ts` 的 `/:id/messages` 用例此时**仍然绿**（它还在读 messages 表，只是表里没数据了——如果它断言了具体消息内容会红，那就是 Task 7 要修的）。若它红了，直接进 Task 7 再回来跑。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/http/routes/chat.ts apps/server/src/http/routes/chat.test.ts
git commit -m "feat(server): chat 路由改用常驻 harness，新增 abort 端点"
```

---

### Task 7: `/:id/messages` 从会话树投影

**Files:**
- Modify: `apps/server/src/services/session.ts`
- Modify: `apps/server/src/http/routes/sessions.ts:66-71`
- Modify: `apps/server/src/http/routes/sessions.test.ts`

- [ ] **Step 1: 改测试**

`sessions.test.ts` 里凡是往 `messages` 表塞数据来构造历史的用例，改成塞 entries。加一个辅助：

```ts
/** 造一条 message 条目，parent 串在上一条后面 */
async function appendMessage(sessionId: string, n: number, role: string, text: string) {
  await createEntryRepository(db).append({
    id: `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`,
    sessionId,
    parentId: n === 1 ? null : `aaaaaaaa-0000-0000-0000-${String(n - 1).padStart(12, "0")}`,
    type: "message",
    payload: { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
  });
}
```

并把返回体断言里的 `interruptedSeqs` 全部删掉：

```ts
  it("返回会话的完整消息列表", async () => {
    await sessionRepo.upsert({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });
    await appendMessage(SESSION_ID, 1, "user", "问题");
    await appendMessage(SESSION_ID, 2, "assistant", "回答");

    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    // 契约里不再有 interruptedSeqs：前端从未消费它，中断信息在消息自带的 stopReason 里
    await expect(response.json()).resolves.toEqual({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ],
    });
  });

  it("会话不存在时返回 200 与空数组", async () => {
    const response = await app.request(`/api/sessions/${SESSION_ID}/messages`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messages: [] });
  });
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server/src/http/routes/sessions.test.ts
```

Expected: FAIL —— 返回体里多了 `interruptedSeqs`，且 `messages` 为空（还在读 messages 表）。

- [ ] **Step 3: 改 service**

`apps/server/src/services/session.ts`：import 加 `createEntryRepository`，在 `createSessionService` 里建 `const entryRepo = createEntryRepository(db);`，把 `loadHistory` 换成：

```ts
    /**
     * 前端历史展示用的完整 transcript。
     *
     * **不能用 session.buildContext()**：它会应用 compaction 变换，
     * 于是压缩发生之后用户刷新页面会看到历史凭空消失。
     * buildContext 是喂模型用的（那里正需要被压缩后的版本），两者不能混。
     */
    async loadHistory(sessionId: string) {
      // 先确认归属：条目按 sessionId 查，这条路上没有 userId。
      // 不属于自己时按会话不存在处理，与「新会话后端还没有这一行」的行为一致
      if (!(await sessionRepo.findById(sessionId, userId))) {
        return { messages: [] };
      }
      const rows = await entryRepo.listAll(sessionId);
      return {
        messages: rows
          .filter((row) => row.type === "message")
          .map((row) => (row.payload as { message: unknown }).message),
      };
    },
```

同时删掉 `appendMessage` 方法（没有调用方了——落库归 harness）。

- [ ] **Step 4: 改路由**

`apps/server/src/http/routes/sessions.ts` 第 70 行：

```ts
    return c.json({ messages: history.messages });
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server
```

Expected: PASS，`apps/server` 全绿。

- [ ] **Step 6: 会话删除时清掉常驻实例**

`sessions.ts` 的 `DELETE /:id` 在 `remove` 成功后加一行——否则内存里还有个活 harness 往已删除的会话写，报错发生在没有请求上下文的地方，日志极难查：

```ts
    if (!(await service.remove(id))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    await getRegistry().evict(id);
    return c.json({ ok: true });
```

`getRegistry` 从 `./chat.ts` 导出后 import 进来（在 `chat.ts` 里把 `getRegistry` 也 `export`）。

补一条用例：

```ts
  it("删除会话后常驻实例被清掉", async () => {
    await sessionRepo.upsert({ id: SESSION_ID, userId: TEST_USER_ID, title: "t" });

    const response = await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    // evict 是幂等的：没有活实例时也不该报错
    expect(await app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    }).then((r) => r.status)).toBe(404);
  });
```

- [ ] **Step 7: 禁用用户时停掉他正在跑的会话**

`requireAuth` 每请求查库，所以被禁用的用户拿不到新的 handle——但**他正在跑的那一轮不会自动停**，会继续烧 token 直到跑完。而「禁用一个滥用者必须立即生效」正是认证那一轮的既定原则，所以要主动停。

`apps/server/src/http/routes/admin.ts` 的禁用分支里，在更新成功之后加：

```ts
    // 被禁用者的下一个请求会被 requireAuth 拦住，但正在跑的那一轮不会自己停。
    // 立即生效是认证那一轮定下的原则，所以这里主动停掉他所有活实例
    if (disabled) {
      const owned = await createSessionRepository(getDb()).listByUser(id);
      await Promise.all(owned.map((session) => getRegistry().evict(session.id)));
    }
```

import 补 `createSessionRepository`（从 `@petrel/database`）与 `getRegistry`（从 `../routes/chat.ts`，注意是同目录，路径为 `./chat.ts`）。

`admin.test.ts` 补一条：

```ts
  it("禁用用户后他的会话实例被清掉", async () => {
    // 让目标用户先跑一轮，registry 里就有实例了
    await readAll(await postChatAs(victimCookie, { message: "你好", sessionId: SESSION_ID }));

    const response = await app.request(`/api/admin/users/${victimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ disabled: true }),
    });

    expect(response.status).toBe(200);
    // 实例已清：被禁用者的会话不再占着内存，正在跑的轮次也被 abort
    expect(getRegistry().size()).toBe(0);
  });
```

`postChatAs` / `victimCookie` / `victimId` / `adminCookie` 用该文件已有的夹具（`admin.test.ts` 已经有建 admin 与普通用户的辅助）；若没有发对话请求的辅助，按 Task 6 的 `postChat` 形状加一个带 cookie 参数的版本。

- [ ] **Step 8: 运行测试，确认通过**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" vitest run apps/server
```

Expected: PASS，`apps/server` 全绿。

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/services/session.ts apps/server/src/http/routes/sessions.ts apps/server/src/http/routes/sessions.test.ts apps/server/src/http/routes/chat.ts apps/server/src/http/routes/admin.ts apps/server/src/http/routes/admin.test.ts
git commit -m "feat(server): 历史改从会话树投影，删会话/禁用用户时清实例"
```

---

### Task 8: 清理旧路径

到这一步为止 `messages` 表已经没有任何读写方。现在删干净。

**Files:**
- Delete: `packages/database/src/repositories/messages.ts` · `messages.test.ts` · `messages.integration.test.ts`
- Modify: `packages/database/src/schema.ts` · `index.ts` · `testing.ts`
- Modify: `packages/agent/src/index.ts`（删 `createAgent`）
- Delete: `packages/agent/src/agent.test.ts`
- Modify: `apps/server/src/services/session.ts`（删 `attachPersistence`）
- Modify: `apps/server/src/services/session.test.ts`

- [ ] **Step 1: 确认没有引用残留**

```bash
grep -rn "createMessageRepository\|attachPersistence\|createAgent\|interruptedSeqs" --include="*.ts" --include="*.js" --include="*.vue" apps packages
```

Expected: 只剩下将要删除的那几个文件自身的定义与 `agent.test.ts`。若 `apps/web` 里还有 `interruptedSeqs`，一并处理（应该没有，设计阶段已 grep 确认过）。

- [ ] **Step 2: 删文件**

```bash
git rm packages/database/src/repositories/messages.ts packages/database/src/repositories/messages.test.ts packages/database/src/repositories/messages.integration.test.ts packages/agent/src/agent.test.ts
```

- [ ] **Step 3: 从 schema 与导出里摘掉 messages**

- `packages/database/src/schema.ts`：删除整个 `messages` 表定义（`integer` / `unique` 若不再被用到，一并从顶部 import 里删掉）
- `packages/database/src/index.ts`：删除 `export * from "./repositories/messages.ts";`
- `packages/database/src/testing.ts`：`TRUNCATE` 去掉 `${messages}`，import 同步删

- [ ] **Step 4: 删 `createAgent` 与 `attachPersistence`**

`packages/agent/src/index.ts`：删掉 `CreateAgentOptions` / `createAgent` / 那份 `DEFAULT_SYSTEM_PROMPT`，改为从 `harness.ts` 重新导出（Task 4 留下的两份定义在这里合并）：

```ts
export { DEFAULT_SYSTEM_PROMPT } from "./harness.ts";
```

`apps/server/src/services/session.ts`：删掉整个 `attachPersistence` 函数与它上面那段 70 行注释、`import type { Agent }` 与 `isUniqueViolation` 的 import（`db-errors.ts` 是否还有别的调用方要先 grep，只被这里用到的话它也可以删）。

`apps/server/src/services/session.test.ts`：删掉所有针对 `attachPersistence` 的用例（`partial` / aborted 去重 / 模型报错只落一条那几条）。`buildTitle` / `ensureSession` / `loadHistory` 的用例保留。

- [ ] **Step 5: 生成删表 migration**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" --filter @petrel/database exec drizzle-kit generate
```

Expected: 生成 `0004_*.sql`，内容是 `DROP TABLE "messages" CASCADE;`。打开确认它**只**删 messages，没有顺带动 session_entries。

- [ ] **Step 6: 全量验证**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run typecheck
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run lint
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run build
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" test
```

Expected: typecheck 零 error、lint 零 error 零 warning、build 通过、test 全绿。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor: 删除 messages 表与 attachPersistence 落库路径"
```

---

### Task 9: 前端「停止」改调 abort 接口

**Files:**
- Modify: `apps/web/src/apis/chat_api.js`
- Modify: `apps/web/src/composables/useAgentStream.js:133-134`

- [ ] **Step 1: 加 API**

`apps/web/src/apis/chat_api.js` 末尾追加：

```js
/**
 * 停止正在进行的一轮对话。
 *
 * 后端的 harness 是常驻的，关闭 SSE 连接只会断开推送、不会停止生成
 * （这是有意的：关页面不再丢回答），所以停止必须走一个显式接口。
 */
export async function abortChat(sessionId) {
  const response = await fetch('/api/chat/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  })

  if (!response.ok) {
    if (response.status === 401) {
      throw handleUnauthorized()
    }
    throw new Error(`停止失败（HTTP ${response.status}）`)
  }
}
```

- [ ] **Step 2: 改 composable**

`apps/web/src/composables/useAgentStream.js` 里 sessionId 现在只存在于 `send(message, options)` 的 `options.sessionId`（第 109 行传给 `streamChat`），`abort()` 拿不到它。所以要记一下当前这一轮的会话 id：

第 18 行 `const controller = shallowRef(null)` 旁边加：

```js
  /** 当前这一轮的会话 id。abort 要用它调后端接口，而 send 之外没有别的地方知道它 */
  const activeSessionId = ref(null)
```

`send()` 里紧跟 `controller.value = new AbortController()` 之后加：

```js
    activeSessionId.value = options.sessionId
```

`abort()`（第 133 行）改成：

```js
  /**
   * 停止生成。
   *
   * 两件事都要做：先调后端接口让 agent 真的停下（harness 是常驻的，
   * 断开 SSE 只是不再接收推送，生成会一直跑完），再断开本地读取。
   * 顺序不能反：先断流会让下面那次 await 处在组件收尾流程里，容易被跳过。
   */
  async function abort() {
    try {
      if (activeSessionId.value) {
        await abortChat(activeSessionId.value)
      }
    } finally {
      controller.value?.abort()
    }
  }
```

`import { computed, ref, shallowRef } from 'vue'` 已经有 `ref`，不用改；第 2 行的 import 补成
`import { abortChat, streamChat } from '@/apis/chat_api'`。

`abort()` 从同步变成了 async，调用方（第 35 行附近的 `abort()` 调用与停止按钮的 handler）不需要改——它们不 await 返回值，行为仍然正确。

- [ ] **Step 3: 手工验证（容器里）**

```bash
docker compose up -d
docker logs petrel-api-dev --tail 50
```

浏览器打开 `http://localhost:5173/agent`，发一条会让模型说很久的消息，点「停止」，确认：回答停在半截、刷新页面后半截内容仍在、`docker logs petrel-api-dev` 里没有 error。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/apis/chat_api.js apps/web/src/composables/useAgentStream.js
git commit -m "feat(web): 停止按钮改调 abort 接口"
```

---

### Task 10: 更新文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/backend-plan.md`
- Modify: `docs/superpowers/specs/2026-08-04-agent-harness-session-design.md`

- [ ] **Step 1: 改 CLAUDE.md**

改动点（逐条对照原文改，不要整段重写）：

1. 「架构」里 `packages/agent` 一行：`createAgent()` → `createHarness()` 装配 pi `AgentHarness`，
   补一句「`PgSessionStorage` 把 pi 的会话树落到 Postgres」
2. `packages/database` 一行：`sessions` / `messages` → `sessions` / `session_entries`，
   把「消息用整数 `seq` 排序，`seq` 由数据库分配」整段替换为
   「会话是 append-only 条目树，顺序由 `parent_id` 决定，`entry_seq` 只做游标分页」
3. 依赖方向：`server → agent → ai → config` 改为 `server → agent → { ai, database }`
4. 「对话链路」：删掉「消息按 `message_end` 增量落库，中断的半截回答在 `agent_end` 时补写并标
   `interrupted`」，改为「落库由 harness 通过 `Session` 完成，路由不参与」；
   补上「连接断开不 abort，停止走 `POST /api/chat/abort`」与「同会话第二个请求进 followUp 队列」
5. 「消费 pi AgentEvent 的硬约束」第 5 条（模型报错那条消息也走 `message_end`，
   只把 aborted 当特例会重复落库）**删掉**——它守的 `attachPersistence` 已不存在。
   同时在这一节补一条新的：**`AgentHarness` 没有 `setSystemPrompt()`**，
   常驻实例复用时请求里的 systemPrompt 不生效
6. 「踩过的坑」补一条：**pi 的 `compact()` 硬编码 `DEFAULT_COMPACTION_SETTINGS` 且要求
   `phase === "idle"`；`phase` 是私有字段没有 getter**，要判断是否在跑只能自己订阅
   `agent_start` / `settled` 维护标记

- [ ] **Step 2: 改 backend-plan.md**

1. §3 新增一节「Agent 内核升级（本轮交付）」，链到 spec 与本计划
2. §「会话持久化的已知问题」第 1 条（中断后重发导致 transcript 顺序错乱、
   换 Anthropic provider 会 400）**移到已解决**，写明原因：条目顺序由 `parent_id` 决定，
   不再依赖写入时刻
3. §4「M2 剩余」的 HEU-10 条目更新：`persisted` 事件与断线重连仍未做，
   但 `getEntries({ afterEntrySeq })` 游标已就位
4. §7 风险补一条：**常驻 harness 在多副本部署下需要会话亲和**，否则两个副本会各自持有
   同一会话的实例并发写同一颗树（结果是分叉而非丢消息）。多副本部署前必须解决

- [ ] **Step 3: 回填 spec 的三处偏差**

把本计划开头「与 spec 的三处偏差」写回 spec：§4.3 删掉 `PgSessionRepo`（改为说明为什么不需要）、
§5 的伪代码把 `phase === "idle"` 改成 registry 自己维护的 running 标记、
§5 的历史读取改成 `listAll` 过滤 message 条目并说明为什么不能用 `buildContext()`。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/backend-plan.md docs/superpowers/specs/2026-08-04-agent-harness-session-design.md
git commit -m "docs: 更新架构说明与已知问题（会话树落地）"
```

---

### Task 11: 端到端验收

**Files:** 无（只跑验证）

- [ ] **Step 1: 全量检查**

```bash
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run build
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run typecheck
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" run lint
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" test
```

Expected: 四条全绿。

- [ ] **Step 2: 带真实 Postgres 跑集成测试**

```bash
docker compose up -d db
PNPM_ENV='PATH=C:\Program Files\nodejs;C:\Users\HP\AppData\Roaming\npm;C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd'
env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" --filter @petrel/database exec drizzle-kit migrate
DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel env "$PNPM_ENV" "/c/Program Files/nodejs/node.exe" "/c/Users/HP/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" test
```

Expected: 全绿。注意 migration 会执行 `DROP TABLE messages`——dev 库里的旧消息按设计丢弃。

- [ ] **Step 3: 容器端到端**

```bash
docker compose up -d
docker logs petrel-api-dev --tail 100
```

Expected: 日志有 `database migrations applied` 与 `agent-server listening`，无 error。

逐条走 spec §8 的验收清单，每条记下结果（这些是 HTTP + psql 验证，不是浏览器点击）：

| # | 检查项 | 怎么验 |
| --- | --- | --- |
| 1 | 首次启动自动建表 | 另建空库起 api，`\dt` 看到 `session_entries` |
| 2 | 发消息后刷新历史在 | `GET /api/sessions/:id/messages` 返回完整 transcript |
| 3 | 标题取首句 | `GET /api/sessions` 的 title |
| 4 | 两会话不串 | 两个 id 各发消息，互不可见 |
| 5 | 重命名后保持 | 改名后再发消息，标题没被打回首句 |
| 6 | 删除级联 | `DELETE` 后 `select count(*) from session_entries` 为 0 |
| 7 | 工具调用后刷新能重建 | transcript 里 `assistant(toolCall)` → `toolResult` → `assistant` 齐全 |
| 8 | 旧会话发消息跳顶 | `GET /api/sessions` 顺序 |
| 9 | 不发消息不产生空会话 | 只 GET 一个陌生 id 不建行 |
| 10 | **关连接回答仍落库** | 3 秒后掐断 curl，等一会 `select count(*)` 仍增长到完整 |
| 11 | **同会话连发两条排队** | 并发两个 curl，最终 4 条 message 条目 |
| 12 | **abort 能停** | 跑起来后 `POST /api/chat/abort`，落库的助手消息带 `"stopReason":"aborted"` |

- [ ] **Step 4: 浏览器观感**

打开 `http://localhost:5173/agent`：发消息、切会话、重命名、删除、点停止。确认没有控制台报错，停止按钮行为符合预期。

- [ ] **Step 5: 把验收结果写进 backend-plan**

在 Task 10 加的那一节里补一张验收结果表（照现有 11 项验收表的格式），标出实际结果。

```bash
git add docs/backend-plan.md
git commit -m "docs: 补齐会话树的端到端验收结果"
```

---

## 完成标准

全部 11 个任务的 checkbox 打完，且：

1. `pnpm run build` / `typecheck` / `lint` / `test` 四条全绿；带 `DATABASE_URL` 的集成测试全绿
2. Task 11 的 12 项端到端逐条通过
3. `grep -rn "createMessageRepository\|attachPersistence\|createAgent\|interruptedSeqs" apps packages` 无结果
4. `packages/agent` 的测试不需要数据库凭据也能跑（`fauxProvider` + `InMemorySessionRepo`）
5. spec 的三处偏差已回填

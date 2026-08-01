# 数据层与会话持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `apps/api` 补上 Postgres 数据层并把 pi 的对话记录落库，让前端左栏的会话列表从静态骨架变成真实功能。

**Architecture:** 新增 `packages/database`（Drizzle schema + 连接 + repository），`apps/api` 加一层 `services/session.ts` 承担会话业务逻辑与 agent 事件订阅落库，路由保持薄。session id 由前端生成，SSE 协议不变。

**Tech Stack:** Drizzle ORM 0.45 · Postgres 17（pgvector 镜像）· PGlite（测试用内存 Postgres）· Hono · vitest

设计文档：[2026-08-01-session-persistence-design.md](../specs/2026-08-01-session-persistence-design.md)

---

## 完成情况（截至 2026-08-01，7/12）

| # | 任务 | 状态 | commit |
| --- | --- | --- | --- |
| 1 | database 包骨架与 schema | ✅ | `21e16be` |
| 2 | sessions repository | ✅ | `269f9dc` |
| 3 | messages repository | ✅ | `c01b132` |
| 4 | 生产连接、migration 与 Postgres 服务 | ✅ | `62ee5b1` |
| 5 | 会话服务 | ✅ | `66bc640` |
| 6 | agent 事件订阅落库 | ✅ | `8dcc488` |
| 7 | 会话 CRUD 路由 | ❌ 未做 | — |
| 8 | `/api/chat` 接入持久化 | ❌ 未做 | — |
| 9 | 前端会话 API 与 store | ✅ | `5ad3656` |
| 10 | useAgentStream 与 chat_api 接入 sessionId | ❌ 未做 | — |
| 11 | 左栏接真实数据与 ChatView 整合 | ❌ 未做 | — |
| 12 | 全量验收与文档 | ❌ 未做 | — |

计划外还有一个 `7bb2f73`「修复 lint 与测试稳定性」。

**当前链路尚未打通**：数据层能存，但没有接口把它暴露出去（Task 7 缺），`/api/chat`
也还没接上持久化（Task 8 缺），前端 store 写好了却没有页面在用（Task 10 · 11 缺）。
从用户视角看，左栏仍然是静态骨架，对话依然不会被保存。

接手时从 **Task 7** 开始，顺序往下做即可。

### Task 6 的实现修正了本计划的一个错误

计划原文让在 `agent_end` 里读 `agent.state.streamingMessage` 取中断的半截消息。
**实测 pi 0.83 在触发 `agent_end` listener 之前已经把 `streamingMessage` 清成
`undefined`**，照计划写永远拿不到。

实际实现改为：用订阅闭包里的 `partial` 变量在 `message_start` / `message_update` 时
持续记录，`agent_end` 时用它。另外还发现中断时 `message_end` 会发出一条空内容、
`stopReason: "aborted"` 的助手消息，直接落库会写进一条空消息，所以要跳过它。

这段修正是对的，以实现为准，不要按计划原文改回去。

### 三个已知问题

1. **测试 flaky（需要修）**。`pnpm test` 全量跑时有 2 个用例因 `beforeEach` 超时失败，
   单独跑 `pnpm vitest run packages/database apps/api` 则 39 个全通过。
   直接原因是 `7bb2f73` 只给 `schema.test.ts` 补了 30 秒超时，**漏了
   `repositories/sessions.test.ts` 与 `repositories/messages.test.ts`**。
   根本原因是本计划里「PGlite 毫秒级启动」的假设不成立——实测每个实例要数秒，
   全量并行时竞争 CPU 就超时。**治本做法是每个测试文件共用一个实例**
   （`beforeAll` 建库、`beforeEach` truncate 各表），而不是继续加大超时。

2. **最微妙的逻辑没有测试覆盖**。`attachPersistence` 只有 3 个用例，
   而上面那段中断路径（`partial` 闭包、跳过 aborted 消息）——正是计划写错、
   靠实测才修对的部分——**一个测试都没有**。补 Task 7 之前应该先补这个测试。

3. **lint 有 2 个 warning**（`!` 非空断言，位于 `repositories/sessions.test.ts`），
   来自本计划给出的测试代码，非阻塞。

### 已验证

- `pnpm run typecheck` 全部包通过
- `pnpm vitest run packages/database apps/api` 39 个用例通过
- 容器未验证（Task 4 Step 8 的 `docker compose up -d` 与建表检查未留下记录）

---

## Global Constraints

每个任务的要求都隐含包含本节。

- **TypeScript ESM**。`verbatimModuleSyntax: true`，所以类型导入必须写 `import type { X } from "..."`
- **相对导入必须带 `.ts` 后缀**（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`），例如 `import { x } from "./schema.ts"`
- **`noUncheckedIndexedAccess: true`**：数组下标访问返回 `T | undefined`，必须处理
- **`@petrel/config` 是全仓唯一读取 `process.env` 的位置**。唯一例外是 pi-ai 从 `SILICONFLOW_API_KEY` 解析模型凭据。数据库连接串必须走 config
- **依赖方向** `api → database → config`，不允许反向或跨层
- **pi 的接线只允许出现在 `agent-core` 与 `ai` 两个 package**，本次不碰这条
- 注释用中文，解释「为什么」而不是「做了什么」
- LF 换行
- **每次 commit 的 message 结尾必须加一行**：
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

### 新增 package 必须同步改三处（漏改会让容器启动即崩）

1. `tsconfig.base.json` 的 `paths`
2. `vitest.config.ts` 的 `alias`
3. `docker-compose.yml` 里 api 服务的 src 挂载

`apps/api/Dockerfile` **不用改**——它用 `pnpm fetch` 依据 lockfile 预取，不逐个 COPY package.json。

### 命令

```bash
pnpm install
pnpm test                                    # 全量测试
pnpm vitest run packages/database            # 只跑数据层测试
pnpm --filter @petrel/web run build          # 前端构建
pnpm run build                               # 全量构建
docker compose up -d                         # 起容器（含新增的 db 服务）
docker logs petrel-api-dev --tail 50
```

---

## 文件结构

### 新增

| 文件 | 职责 |
| --- | --- |
| `packages/database/package.json` | 包定义，依赖 drizzle-orm / pg / @petrel/config |
| `packages/database/tsconfig.json` · `tsconfig.check.json` | 与其他 package 一致的编译配置 |
| `packages/database/drizzle.config.ts` | drizzle-kit 配置（schema 路径、输出目录、方言） |
| `packages/database/src/schema.ts` | 三张表定义，表结构的唯一真相 |
| `packages/database/src/client.ts` | 生产用连接池 + drizzle 实例 |
| `packages/database/src/migrate.ts` | 启动时执行 migration + 播种默认用户 |
| `packages/database/src/testing.ts` | 测试用 PGlite 实例工厂 |
| `packages/database/src/index.ts` | 包出口 |
| `packages/database/src/repositories/sessions.ts` | 会话数据访问 |
| `packages/database/src/repositories/messages.ts` | 消息数据访问 |
| `packages/database/src/repositories/sessions.test.ts` | 会话 repository 测试 |
| `packages/database/src/repositories/messages.test.ts` | 消息 repository 测试 |
| `packages/database/drizzle/*.sql` | drizzle-kit 生成的 migration，提交进仓库 |
| `apps/api/src/services/session.ts` | 会话业务逻辑与持久化订阅 |
| `apps/api/src/services/session.test.ts` | 服务层测试（含 fauxProvider 跑真实 agent loop） |
| `apps/api/src/http/routes/sessions.ts` | 会话 CRUD 路由 |
| `apps/web/src/apis/session_api.js` | 前端会话接口调用 |
| `apps/web/src/stores/session.js` | 前端会话状态 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `packages/config/src/index.ts` | 新增 `databaseUrl` |
| `apps/api/package.json` | 依赖加 `@petrel/database` |
| `apps/api/src/index.ts` | 启动时跑 migration |
| `apps/api/src/http/app.ts` | 挂载 `/api/sessions` |
| `apps/api/src/http/routes/chat.ts` | 接 `sessionId`、历史回灌、持久化订阅、降级 |
| `tsconfig.base.json` | paths 加 `@petrel/database` |
| `vitest.config.ts` | alias 加 `@petrel/database` |
| `docker-compose.yml` | 加 db 服务、api 挂载 database/src、api 加 DATABASE_URL 与 depends_on |
| `.env.template` | 加 `DATABASE_URL` |
| `apps/web/src/composables/useAgentStream.js` | 加 `loadHistory()`，`send` 传 sessionId |
| `apps/web/src/apis/chat_api.js` | `streamChat` 加 sessionId |
| `apps/web/src/components/shell/SessionSidebar.vue` | 空态换真实列表 + CRUD |
| `apps/web/src/views/ChatView.vue` | 切换会话加载历史、新建时生成 id |

---

## Task 1: database 包骨架与 schema

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/tsconfig.check.json`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/schema.ts`
- Create: `packages/database/src/testing.ts`
- Create: `packages/database/src/index.ts`
- Test: `packages/database/src/schema.test.ts`
- Modify: `tsconfig.base.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `users` / `sessions` / `messages` 三个 Drizzle 表对象
  - `DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"`
  - `createTestDb(): Promise<{ db: TestDb, close: () => Promise<void> }>` — PGlite 实例，已跑完 migration 并播种默认用户
  - 类型 `Database`（drizzle 实例类型，供 repository 与 service 标注参数）

- [ ] **Step 1: 建包并装依赖**

创建 `packages/database/package.json`：

```json
{
  "name": "@petrel/database",
  "version": "0.5.0-dev",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "default": "./dist/testing.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.check.json",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@petrel/config": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "pg": "^8.22.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.4",
    "@types/pg": "^8.20.2",
    "drizzle-kit": "^0.31.10"
  }
}
```

创建 `packages/database/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

创建 `packages/database/tsconfig.check.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false
  }
}
```

然后执行：

```bash
pnpm install
```

- [ ] **Step 2: 注册 package 路径（漏一处容器就起不来）**

`tsconfig.base.json` 的 `paths` 加一条（保持字母序，在 `@petrel/config` 之后）：

```json
      "@petrel/database": ["packages/database/src/index.ts"],
```

`vitest.config.ts` 的 `alias` 加一条（同样位置）：

```ts
      "@petrel/database": fileURLToPath(new URL("./packages/database/src/index.ts", import.meta.url)),
```

- [ ] **Step 3: 写 schema**

创建 `packages/database/src/schema.ts`：

```ts
import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * 认证（HEU-7）落地前的占位用户表。
 * 本轮只建表并播种一条默认用户，所有会话都挂在它下面；
 * 认证落地后这条记录要么被真实用户接管，要么作为历史数据的归属保留。
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    // 不用 defaultRandom：id 由前端生成后随首条消息传上来
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 左栏按最近更新倒序拉列表，走这个索引
  (table) => [index("sessions_user_updated_idx").on(table.userId, table.updatedAt.desc())],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // 用整数序号而不是 created_at 排序：agent 一轮会连续产出 assistant 与 toolResult
    // 多条消息，插入时间戳可能落在同一毫秒，靠时间戳排序不稳定
    seq: integer("seq").notNull(),
    // 冗余自 message，让「找首条 user 消息」这类查询变成普通 WHERE
    role: text("role").notNull(),
    // pi 的 AgentMessage 原样存。pi 仍在快速演进，拆字段等于把它的内部结构
    // 固化进表结构，它一改就要 migration
    message: jsonb("message").notNull(),
    interrupted: boolean("interrupted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("messages_session_seq_unique").on(table.sessionId, table.seq)],
);

/** 认证落地前，所有会话的归属用户 */
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_USERNAME = "default";
```

- [ ] **Step 4: 写 drizzle 配置并生成 migration**

创建 `packages/database/drizzle.config.ts`：

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // generate 不需要连数据库，这里给占位值即可；
  // 真正的连接串在运行时由 @petrel/config 提供
  dbCredentials: { url: "postgres://petrel:petrel@localhost:5432/petrel" },
});
```

生成 migration：

```bash
pnpm --filter @petrel/database run db:generate
```

Expected: 在 `packages/database/drizzle/` 下生成一个 `.sql` 文件和 `meta/` 目录。**这些都要提交进仓库。**

- [ ] **Step 5: 写测试库工厂**

创建 `packages/database/src/testing.ts`：

```ts
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DEFAULT_USER_ID, DEFAULT_USERNAME, users } from "./schema.ts";
import * as schema from "./schema.ts";

/** migration 目录是包内的相对位置，测试从仓库根跑，所以要解析成绝对路径 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * 建一个跑在内存里的 Postgres 并跑完 migration。
 *
 * 用 PGlite 而不是 testcontainers：毫秒级启动、每个用例一个干净实例、
 * CI 不需要 Docker，而外键、级联、唯一约束、事务这些语义都是真的。
 */
export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle({ client, schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await db.insert(users).values({ id: DEFAULT_USER_ID, username: DEFAULT_USERNAME });

  return { db, close: () => client.close() };
}
```

- [ ] **Step 6: 写包出口**

创建 `packages/database/src/index.ts`：

```ts
export * from "./schema.ts";
```

- [ ] **Step 7: 写失败的测试**

创建 `packages/database/src/schema.test.ts`：

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID, messages, sessions, users } from "./schema.ts";
import { createTestDb, type TestDb } from "./testing.ts";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  return () => close();
});

/** 造一个会话，返回它的 id */
async function seedSession(id = "11111111-1111-1111-1111-111111111111") {
  await db.insert(sessions).values({ id, userId: DEFAULT_USER_ID, title: "测试会话" });
  return id;
}

describe("schema", () => {
  it("migration 跑完后默认用户已存在", async () => {
    const rows = await db.select().from(users).where(eq(users.id, DEFAULT_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe("default");
  });

  it("同一会话的 seq 不允许重复", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "user", message: { role: "user" } });

    await expect(
      db.insert(messages).values({ sessionId, seq: 1, role: "user", message: { role: "user" } }),
    ).rejects.toThrow();
  });

  it("不同会话可以有相同的 seq", async () => {
    const first = await seedSession("11111111-1111-1111-1111-111111111111");
    const second = await seedSession("22222222-2222-2222-2222-222222222222");

    await db.insert(messages).values({ sessionId: first, seq: 1, role: "user", message: {} });
    await db.insert(messages).values({ sessionId: second, seq: 1, role: "user", message: {} });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(2);
  });

  it("删除会话会级联删掉它的消息", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "user", message: {} });

    await db.delete(sessions).where(eq(sessions.id, sessionId));

    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("会话必须挂在存在的用户下", async () => {
    await expect(
      db.insert(sessions).values({
        id: "33333333-3333-3333-3333-333333333333",
        userId: "99999999-9999-9999-9999-999999999999",
        title: "孤儿会话",
      }),
    ).rejects.toThrow();
  });

  it("interrupted 默认为 false", async () => {
    const sessionId = await seedSession();
    await db.insert(messages).values({ sessionId, seq: 1, role: "assistant", message: {} });

    const rows = await db.select().from(messages);
    expect(rows[0]?.interrupted).toBe(false);
  });

  it("AgentMessage 原样存取，结构不丢失", async () => {
    const sessionId = await seedSession();
    const agentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "现在是下午三点" },
        { type: "toolCall", id: "call_1", name: "get_current_time", arguments: {} },
      ],
    };

    await db.insert(messages).values({ sessionId, seq: 1, role: "assistant", message: agentMessage });

    const rows = await db.select().from(messages);
    expect(rows[0]?.message).toEqual(agentMessage);
  });
});
```

- [ ] **Step 8: 运行测试确认失败**

Run: `pnpm vitest run packages/database/src/schema.test.ts`
Expected: FAIL。如果报 `Cannot find module 'drizzle-orm/pglite/migrator'`，先确认 Step 1 的 `pnpm install` 成功；如果报 migration 目录不存在，说明 Step 4 没生成成功。

- [ ] **Step 9: 让测试通过**

Step 3~6 的代码就是实现。若测试失败，按报错修正——常见问题是 migration 未生成（回到 Step 4）。

Run: `pnpm vitest run packages/database/src/schema.test.ts`
Expected: PASS，7 个用例通过

- [ ] **Step 10: 确认没破坏已有测试**

Run: `pnpm test`
Expected: PASS，48 个已有用例 + 7 个新用例

- [ ] **Step 11: Commit**

```bash
git add packages/database tsconfig.base.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(database): 会话持久化的表结构与测试基建"
```

---

## Task 2: sessions repository

**Files:**
- Create: `packages/database/src/repositories/sessions.ts`
- Test: `packages/database/src/repositories/sessions.test.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `sessions` 表、`createTestDb()`（Task 1）
- Produces: `createSessionRepository(db)` 返回对象，方法签名：
  - `listByUser(userId: string): Promise<SessionSummary[]>` — 按 `updatedAt` 倒序，`SessionSummary = { id, title, createdAt, updatedAt }`
  - `findById(id: string): Promise<Session | undefined>`
  - `upsert(input: { id, userId, title }): Promise<void>` — 已存在时**不覆盖 title**
  - `rename(id: string, title: string): Promise<boolean>` — 返回是否命中
  - `remove(id: string): Promise<boolean>` — 返回是否命中
  - `touch(id: string): Promise<void>` — 更新 `updatedAt` 为当前时间

- [ ] **Step 1: 写失败的测试**

创建 `packages/database/src/repositories/sessions.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../schema.ts";
import { createTestDb, type TestDb } from "../testing.ts";
import { createSessionRepository } from "./sessions.ts";

let db: TestDb;
let repo: ReturnType<typeof createSessionRepository>;

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  repo = createSessionRepository(db);
  return () => created.close();
});

describe("sessionRepository", () => {
  it("upsert 建出新会话", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "第一个会话" });

    const found = await repo.findById(ID_A);
    expect(found?.title).toBe("第一个会话");
  });

  it("upsert 命中已存在的会话时不覆盖标题", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "原标题" });
    await repo.rename(ID_A, "用户改过的标题");
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "又一条消息的首句" });

    const found = await repo.findById(ID_A);
    expect(found?.title).toBe("用户改过的标题");
  });

  it("findById 找不到时返回 undefined", async () => {
    expect(await repo.findById(ID_A)).toBeUndefined();
  });

  it("列表按 updatedAt 倒序", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "旧会话" });
    await repo.upsert({ id: ID_B, userId: DEFAULT_USER_ID, title: "新会话" });
    // 显式 touch 一次，避免两条记录的 defaultNow() 落在同一时刻
    await repo.touch(ID_A);

    const list = await repo.listByUser(DEFAULT_USER_ID);
    expect(list.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  it("rename 改标题并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "旧名" });

    expect(await repo.rename(ID_A, "新名")).toBe(true);
    expect((await repo.findById(ID_A))?.title).toBe("新名");
  });

  it("rename 不存在的会话返回 false", async () => {
    expect(await repo.rename(ID_A, "新名")).toBe(false);
  });

  it("remove 删除并返回 true", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "待删" });

    expect(await repo.remove(ID_A)).toBe(true);
    expect(await repo.findById(ID_A)).toBeUndefined();
  });

  it("remove 不存在的会话返回 false", async () => {
    expect(await repo.remove(ID_A)).toBe(false);
  });

  it("touch 推进 updatedAt", async () => {
    await repo.upsert({ id: ID_A, userId: DEFAULT_USER_ID, title: "会话" });
    const before = (await repo.findById(ID_A))?.updatedAt;

    await repo.touch(ID_A);
    const after = (await repo.findById(ID_A))?.updatedAt;

    expect(after!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/database/src/repositories/sessions.test.ts`
Expected: FAIL，无法解析 `./sessions.ts`

- [ ] **Step 3: 实现 repository**

创建 `packages/database/src/repositories/sessions.ts`：

```ts
import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { sessions } from "../schema.ts";

/** 生产走 node-postgres、测试走 PGlite，两者的查询构造 API 是同一套 */
export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createSessionRepository(db: Database) {
  return {
    async listByUser(userId: string): Promise<SessionSummary[]> {
      return db
        .select({
          id: sessions.id,
          title: sessions.title,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.updatedAt));
    },

    async findById(id: string) {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return rows[0];
    },

    /**
     * 已存在时只更新 updatedAt，不碰 title——
     * 否则用户重命名过的会话会在下一条消息时被打回首句截断。
     */
    async upsert(input: { id: string; userId: string; title: string }): Promise<void> {
      await db
        .insert(sessions)
        .values(input)
        .onConflictDoUpdate({
          target: sessions.id,
          set: { updatedAt: new Date() },
        });
    },

    async rename(id: string, title: string): Promise<boolean> {
      const updated = await db
        .update(sessions)
        .set({ title, updatedAt: new Date() })
        .where(eq(sessions.id, id))
        .returning({ id: sessions.id });
      return updated.length > 0;
    },

    async remove(id: string): Promise<boolean> {
      const deleted = await db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
      return deleted.length > 0;
    },

    async touch(id: string): Promise<void> {
      await db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id));
    },
  };
}
```

- [ ] **Step 4: 导出**

`packages/database/src/index.ts` 追加：

```ts
export * from "./repositories/sessions.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run packages/database/src/repositories/sessions.test.ts`
Expected: PASS，9 个用例通过

- [ ] **Step 6: Commit**

```bash
git add packages/database/src
git commit -m "feat(database): 会话 repository"
```

---

## Task 3: messages repository

**Files:**
- Create: `packages/database/src/repositories/messages.ts`
- Test: `packages/database/src/repositories/messages.test.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `messages` 表、`Database` 类型（Task 2）
- Produces: `createMessageRepository(db)` 返回对象：
  - `append(input: { sessionId, seq, role, message, interrupted? }): Promise<void>`
  - `listBySession(sessionId: string): Promise<StoredMessage[]>` — 按 seq 升序，`StoredMessage = { seq, role, message, interrupted }`
  - `maxSeq(sessionId: string): Promise<number>` — 空会话返回 0

- [ ] **Step 1: 写失败的测试**

创建 `packages/database/src/repositories/messages.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID, sessions } from "../schema.ts";
import { createTestDb, type TestDb } from "../testing.ts";
import { createMessageRepository } from "./messages.ts";

let db: TestDb;
let repo: ReturnType<typeof createMessageRepository>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  repo = createMessageRepository(db);
  await db.insert(sessions).values({ id: SESSION_ID, userId: DEFAULT_USER_ID, title: "测试会话" });
  return () => created.close();
});

describe("messageRepository", () => {
  it("append 后能按 seq 升序读回", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 2, role: "assistant", message: { role: "assistant" } });
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: { role: "user" } });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.seq)).toEqual([1, 2]);
    expect(list.map((item) => item.role)).toEqual(["user", "assistant"]);
  });

  it("空会话的 maxSeq 是 0", async () => {
    expect(await repo.maxSeq(SESSION_ID)).toBe(0);
  });

  it("maxSeq 返回当前最大序号", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: {} });
    await repo.append({ sessionId: SESSION_ID, seq: 7, role: "assistant", message: {} });

    expect(await repo.maxSeq(SESSION_ID)).toBe(7);
  });

  it("interrupted 默认 false，可显式置 true", async () => {
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "assistant", message: {} });
    await repo.append({
      sessionId: SESSION_ID,
      seq: 2,
      role: "assistant",
      message: {},
      interrupted: true,
    });

    const list = await repo.listBySession(SESSION_ID);
    expect(list.map((item) => item.interrupted)).toEqual([false, true]);
  });

  it("AgentMessage 的嵌套结构原样返回", async () => {
    const agentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "get_current_time", arguments: { tz: "Asia/Shanghai" } }],
    };
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "assistant", message: agentMessage });

    const list = await repo.listBySession(SESSION_ID);
    expect(list[0]?.message).toEqual(agentMessage);
  });

  it("只返回指定会话的消息", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    await db.insert(sessions).values({ id: other, userId: DEFAULT_USER_ID, title: "另一个会话" });
    await repo.append({ sessionId: SESSION_ID, seq: 1, role: "user", message: {} });
    await repo.append({ sessionId: other, seq: 1, role: "user", message: {} });

    expect(await repo.listBySession(SESSION_ID)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run packages/database/src/repositories/messages.test.ts`
Expected: FAIL，无法解析 `./messages.ts`

- [ ] **Step 3: 实现 repository**

创建 `packages/database/src/repositories/messages.ts`：

```ts
import { asc, eq, max } from "drizzle-orm";
import { messages } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface StoredMessage {
  seq: number;
  role: string;
  message: unknown;
  interrupted: boolean;
}

export function createMessageRepository(db: Database) {
  return {
    async append(input: {
      sessionId: string;
      seq: number;
      role: string;
      message: unknown;
      interrupted?: boolean;
    }): Promise<void> {
      await db.insert(messages).values({
        sessionId: input.sessionId,
        seq: input.seq,
        role: input.role,
        message: input.message,
        interrupted: input.interrupted ?? false,
      });
    },

    async listBySession(sessionId: string): Promise<StoredMessage[]> {
      return db
        .select({
          seq: messages.seq,
          role: messages.role,
          message: messages.message,
          interrupted: messages.interrupted,
        })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.seq));
    },

    /** 空会话返回 0，这样调用方统一用 maxSeq + 1 作为下一个序号 */
    async maxSeq(sessionId: string): Promise<number> {
      const rows = await db
        .select({ value: max(messages.seq) })
        .from(messages)
        .where(eq(messages.sessionId, sessionId));
      return rows[0]?.value ?? 0;
    },
  };
}
```

- [ ] **Step 4: 导出**

`packages/database/src/index.ts` 追加：

```ts
export * from "./repositories/messages.ts";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run packages/database/src/repositories/messages.test.ts`
Expected: PASS，6 个用例通过

- [ ] **Step 6: Commit**

```bash
git add packages/database/src
git commit -m "feat(database): 消息 repository"
```

---

## Task 4: 生产连接、migration 与 Postgres 服务

**Files:**
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/migrate.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/index.ts`
- Modify: `docker-compose.yml`
- Modify: `.env.template`

**Interfaces:**
- Consumes: `schema`、`DEFAULT_USER_ID`（Task 1）
- Produces:
  - `getDb(): Database` — 单例，生产用的 drizzle 实例
  - `runMigrations(): Promise<void>` — 跑 migration 并播种默认用户
  - `closeDb(): Promise<void>`
  - `env.databaseUrl: string`（来自 `@petrel/config`）

本任务没有单元测试——它连的是真实 Postgres，验证靠容器启动。数据层逻辑已由 Task 1~3 用 PGlite 覆盖。

- [ ] **Step 1: config 加连接串**

`packages/config/src/index.ts` 的 `env` 对象里追加一行（在 `logLevel` 之后）：

```ts
  databaseUrl: process.env.DATABASE_URL ?? "postgres://petrel:petrel@localhost:5432/petrel",
```

- [ ] **Step 2: 写连接管理**

创建 `packages/database/src/client.ts`：

```ts
import { env } from "@petrel/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

let pool: Pool | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** 连接池是进程级单例：每个请求新建连接会迅速耗尽 Postgres 的连接数 */
export function getDb() {
  if (!db) {
    pool = new Pool({ connectionString: env.databaseUrl });
    db = drizzle({ client: pool, schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
```

- [ ] **Step 3: 写 migration 执行**

创建 `packages/database/src/migrate.ts`：

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./client.ts";
import { DEFAULT_USER_ID, DEFAULT_USERNAME, users } from "./schema.ts";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * 启动时执行。失败就让进程退出——带着没建表的数据库启动，
 * 只会让每个请求都在运行时炸，不如启动时就失败得清楚。
 */
export async function runMigrations(): Promise<void> {
  const db = getDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // 播种默认用户。幂等，重启不会重复插入
  await db
    .insert(users)
    .values({ id: DEFAULT_USER_ID, username: DEFAULT_USERNAME })
    .onConflictDoNothing();
}
```

- [ ] **Step 4: 导出**

`packages/database/src/index.ts` 追加：

```ts
export * from "./client.ts";
export * from "./migrate.ts";
```

- [ ] **Step 5: api 依赖 database 并在启动时跑 migration**

`apps/api/package.json` 的 `dependencies` 加一条（字母序，在 `@petrel/config` 之后）：

```json
    "@petrel/database": "workspace:*",
```

`apps/api/src/index.ts` 整份替换为：

```ts
import { serve } from "@hono/node-server";
import { env } from "@petrel/config";
import { runMigrations } from "@petrel/database";
import { logger } from "@petrel/logger";
import { app } from "./http/app.ts";

await runMigrations();
logger.info("database migrations applied");

serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, ({ port }) => {
  logger.info({ port, nodeEnv: env.nodeEnv }, "agent-server listening");
});
```

然后执行 `pnpm install` 让 workspace 链接生效。

- [ ] **Step 6: compose 加 Postgres 服务**

`docker-compose.yml` 在 `services:` 下、`api:` 之前插入：

```yaml
  db:
    # 直接用 pgvector 镜像：本轮用不到向量，但知识库那轮要，
    # 现在用普通 postgres 到时候换镜像得重建数据卷
    image: pgvector/pgvector:pg17
    container_name: petrel-db-dev
    environment:
      POSTGRES_USER: petrel
      POSTGRES_PASSWORD: petrel
      POSTGRES_DB: petrel
    ports:
      - "5432:5432"
    volumes:
      - petrel-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U petrel -d petrel"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
```

`api` 服务里加环境变量与依赖（`env_file` 之后、`restart` 之前）：

```yaml
    environment:
      - DATABASE_URL=postgres://petrel:petrel@db:5432/petrel
    depends_on:
      db:
        condition: service_healthy
```

`api` 的 `volumes` 列表加一行（在 logger 之后）：

```yaml
      - ./packages/database/src:/app/packages/database/src
```

文件末尾追加顶层 `volumes`：

```yaml

volumes:
  petrel-pgdata:
```

- [ ] **Step 7: .env.template 加连接串**

`.env.template` 末尾追加：

```
# Postgres 连接串。compose 内用服务名 db，宿主机直连用 localhost
DATABASE_URL=postgres://petrel:petrel@db:5432/petrel
```

- [ ] **Step 8: 验证容器起得来**

```bash
docker compose up -d
docker logs petrel-api-dev --tail 30
```

Expected: 日志里有 `database migrations applied` 和 `agent-server listening`，没有连接错误。

```bash
docker exec petrel-db-dev psql -U petrel -d petrel -c "\dt"
```

Expected: 列出 `users`、`sessions`、`messages` 三张表和 drizzle 的 migration 记录表。

> 改了 `.env` 或 compose 的环境变量后必须 `docker compose up -d`，不能 `restart`——
> 容器的环境变量在创建时固定，`restart` 只重启进程。

- [ ] **Step 9: 确认测试仍通过**

Run: `pnpm test`
Expected: PASS，62 个用例（48 已有 + 7 + 9 + 6）

- [ ] **Step 10: Commit**

```bash
git add packages/database packages/config apps/api docker-compose.yml .env.template pnpm-lock.yaml
git commit -m "feat: Postgres 服务与启动时 migration"
```

---

## Task 5: 会话服务

**Files:**
- Create: `apps/api/src/services/session.ts`
- Test: `apps/api/src/services/session.test.ts`

**Interfaces:**
- Consumes: `createSessionRepository` / `createMessageRepository` / `DEFAULT_USER_ID`（Task 2·3）、`createTestDb`（Task 1）
- Produces: `createSessionService(db)` 返回对象：
  - `buildTitle(text: string): string` — 首 30 字，超出加省略号
  - `ensureSession(sessionId: string, firstMessage: string): Promise<void>` — upsert，标题取自首条消息
  - `loadHistory(sessionId: string): Promise<{ messages: unknown[]; interruptedSeqs: number[]; nextSeq: number }>`
  - `appendMessage(sessionId, seq, message, interrupted?): Promise<void>` — 从 message 里取 role
  - `list()` / `rename(id, title)` / `remove(id)` — 透传 repository，带默认用户归属

- [ ] **Step 1: 写失败的测试**

创建 `apps/api/src/services/session.test.ts`：

```ts
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createSessionService } from "./session.ts";

let db: TestDb;
let service: ReturnType<typeof createSessionService>;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  service = createSessionService(db);
  return () => created.close();
});

describe("buildTitle", () => {
  it("短消息原样作标题", () => {
    expect(service.buildTitle("现在几点")).toBe("现在几点");
  });

  it("超过 30 字截断并加省略号", () => {
    const long = "一".repeat(40);
    const title = service.buildTitle(long);

    expect(title).toHaveLength(31);
    expect(title.endsWith("…")).toBe(true);
  });

  it("首尾空白不计入", () => {
    expect(service.buildTitle("  现在几点  ")).toBe("现在几点");
  });

  it("空消息回落到默认标题", () => {
    expect(service.buildTitle("   ")).toBe("新对话");
  });
});

describe("ensureSession", () => {
  it("首次调用建出会话并用首句作标题", async () => {
    await service.ensureSession(SESSION_ID, "帮我查一下时间");

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("帮我查一下时间");
  });

  it("再次调用不覆盖已改过的标题", async () => {
    await service.ensureSession(SESSION_ID, "第一条消息");
    await service.rename(SESSION_ID, "我改的名字");
    await service.ensureSession(SESSION_ID, "第二条消息");

    const list = await service.list();
    expect(list[0]?.title).toBe("我改的名字");
  });
});

describe("loadHistory 与 appendMessage", () => {
  it("空会话返回空历史，下一个序号是 1", async () => {
    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toEqual([]);
    expect(history.nextSeq).toBe(1);
  });

  it("按写入顺序读回消息，nextSeq 递增", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, 2, { role: "assistant", content: "你也好" });

    const history = await service.loadHistory(SESSION_ID);

    expect(history.messages).toHaveLength(2);
    expect(history.nextSeq).toBe(3);
  });

  it("role 从 message 里自动取出", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "toolResult", content: [] });

    const history = await service.loadHistory(SESSION_ID);
    expect((history.messages[0] as { role: string }).role).toBe("toolResult");
  });

  it("中断的消息在 interruptedSeqs 里", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });
    await service.appendMessage(SESSION_ID, 2, { role: "assistant", content: "半截" }, true);

    const history = await service.loadHistory(SESSION_ID);
    expect(history.interruptedSeqs).toEqual([2]);
  });
});

describe("CRUD", () => {
  it("rename 命中返回 true，不存在返回 false", async () => {
    await service.ensureSession(SESSION_ID, "会话");

    expect(await service.rename(SESSION_ID, "新名")).toBe(true);
    expect(await service.rename("22222222-2222-2222-2222-222222222222", "新名")).toBe(false);
  });

  it("remove 删掉会话及其消息", async () => {
    await service.ensureSession(SESSION_ID, "会话");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "你好" });

    expect(await service.remove(SESSION_ID)).toBe(true);
    expect(await service.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/api/src/services/session.test.ts`
Expected: FAIL，无法解析 `./session.ts`

- [ ] **Step 3: 实现服务**

创建 `apps/api/src/services/session.ts`：

```ts
import {
  createMessageRepository,
  createSessionRepository,
  DEFAULT_USER_ID,
  type Database,
} from "@petrel/database";

const TITLE_MAX_LENGTH = 30;
const FALLBACK_TITLE = "新对话";

export function createSessionService(db: Database) {
  const sessionRepo = createSessionRepository(db);
  const messageRepo = createMessageRepository(db);

  /**
   * 标题取首条用户消息的前 30 字。
   * 不调模型生成：那要多一次 API 调用和成本，而当前只注册了一个模型。
   * 用户可以随时重命名。
   */
  function buildTitle(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return FALLBACK_TITLE;
    if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
  }

  return {
    buildTitle,

    async ensureSession(sessionId: string, firstMessage: string): Promise<void> {
      await sessionRepo.upsert({
        id: sessionId,
        userId: DEFAULT_USER_ID,
        title: buildTitle(firstMessage),
      });
    },

    async loadHistory(sessionId: string) {
      const stored = await messageRepo.listBySession(sessionId);
      return {
        messages: stored.map((row) => row.message),
        interruptedSeqs: stored.filter((row) => row.interrupted).map((row) => row.seq),
        nextSeq: (stored.at(-1)?.seq ?? 0) + 1,
      };
    },

    async appendMessage(
      sessionId: string,
      seq: number,
      message: unknown,
      interrupted = false,
    ): Promise<void> {
      // role 冗余存一列，让「找首条 user 消息」这类查询不必写 JSONB 表达式
      const role = (message as { role?: string }).role ?? "unknown";
      await messageRepo.append({ sessionId, seq, role, message, interrupted });
    },

    async list() {
      return sessionRepo.listByUser(DEFAULT_USER_ID);
    },

    async rename(sessionId: string, title: string): Promise<boolean> {
      return sessionRepo.rename(sessionId, title);
    },

    async remove(sessionId: string): Promise<boolean> {
      return sessionRepo.remove(sessionId);
    },

    async touch(sessionId: string): Promise<void> {
      await sessionRepo.touch(sessionId);
    },
  };
}
```

- [ ] **Step 4: 让 `@petrel/database/testing` 能被解析**

`vitest.config.ts` 的 alias 追加一条（在 `@petrel/database` 之后）：

```ts
      "@petrel/database/testing": fileURLToPath(new URL("./packages/database/src/testing.ts", import.meta.url)),
```

`tsconfig.base.json` 的 paths 同样追加：

```json
      "@petrel/database/testing": ["packages/database/src/testing.ts"],
```

> 注意顺序：alias 是前缀匹配，更具体的 `@petrel/database/testing` 必须排在
> `@petrel/database` **之前**，否则会被后者截胡。请把这一条插到 `@petrel/database` 上面。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run apps/api/src/services/session.test.ts`
Expected: PASS，12 个用例通过

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services vitest.config.ts tsconfig.base.json
git commit -m "feat(api): 会话服务"
```

---

## Task 6: agent 事件订阅落库

**Files:**
- Modify: `apps/api/src/services/session.ts`
- Test: `apps/api/src/services/session.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `createSessionService`（Task 5）、`createAgent`（`@petrel/agent-core`）
- Produces: `attachPersistence(agent, sessionId, startSeq)` — 订阅 agent 事件并落库，返回取消订阅函数

**这段是本次最容易出错的地方**，四条经过核实的事实决定了实现方式：

1. `subscribe(listener)` 的 listener promise **会被 agent await 并计入 run 的 settlement**，
   所以 listener 内必须 try/catch——抛出去会影响 agent 本身运行
2. `agent_end` 带完整 `messages: AgentMessage[]`，但那是整个 transcript（含回灌的历史），
   一次性写会重复，所以按 `message_end` 增量写
3. `state.streamingMessage` 是流式中的半截消息，**不在** `state.messages` 里，
   中断时只能从这里取
4. **用户消息也走 `message_start` / `message_end`**。`packages/agent-core/src/agent.test.ts`
   里实测的单轮事件序列是：
   ```
   agent_start → turn_start → message_start/message_end（用户消息）
               → message_start/message_end（助手消息）→ turn_end → agent_end
   ```
   所以订阅 `message_end` 一处就能收下用户消息和助手回复两者，**调用方不要再手动存一遍
   用户消息**，否则会重复。回灌的历史消息不经过事件流，不会被重复写入。

- [ ] **Step 1: 写失败的测试**

`apps/api/src/services/session.test.ts` 顶部的 import 追加：

```ts
import { createAgent } from "@petrel/agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { attachPersistence } from "./session.ts";
```

文件末尾追加：

```ts
/**
 * 用 pi 自带的 faux provider 跑真实 agent loop，不需要模型凭据也不 mock 内部。
 * 这个装配方式与 packages/agent-core/src/agent.test.ts 里的一致。
 */
function fauxAgent() {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = createAgent({ models, model: faux.getModel() });
  return { faux, agent };
}

describe("attachPersistence", () => {
  it("用户消息与助手回复都会落库", async () => {
    await service.ensureSession(SESSION_ID, "你好");

    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel")])]);
    attachPersistence(service, agent, SESSION_ID, 1);

    await agent.prompt("你好");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // pi 的事件序列里用户消息同样走 message_end，所以订阅一处就能把两条都收下
    expect(history.messages).toHaveLength(2);
    expect((history.messages[0] as { role: string }).role).toBe("user");
    expect((history.messages[1] as { role: string }).role).toBe("assistant");
  });

  it("seq 从传入的起点连续递增", async () => {
    await service.ensureSession(SESSION_ID, "你好");
    await service.appendMessage(SESSION_ID, 1, { role: "user", content: "上一轮" });

    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    attachPersistence(service, agent, SESSION_ID, 2);

    await agent.prompt("这一轮");
    await agent.waitForIdle();

    const history = await service.loadHistory(SESSION_ID);
    // 1 是上一轮已有的，2 是本轮用户消息，3 是助手回复
    expect(history.nextSeq).toBe(4);
  });

  it("落库失败不会让 agent 运行抛异常", async () => {
    const { faux, agent } = fauxAgent();
    faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    // 不建 session，外键约束必然让每次写入都失败
    attachPersistence(service, agent, "44444444-4444-4444-4444-444444444444", 1);

    await expect(agent.prompt("你好")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/api/src/services/session.test.ts -t attachPersistence`
Expected: FAIL，`attachPersistence` 未导出

> 如果报 `Cannot find module '@earendil-works/pi-ai/faux'`，先查
> `packages/agent-core/src/agent.test.ts` 里 faux provider 的实际导入方式并照抄——
> 那个文件里已经在用它。

- [ ] **Step 3: 实现订阅**

`apps/api/src/services/session.ts` 追加（文件末尾）：

```ts
import type { Agent } from "@earendil-works/pi-agent-core";
import { logger } from "@petrel/logger";

type SessionService = ReturnType<typeof createSessionService>;

/**
 * 订阅 agent 事件并落库。
 *
 * 按 message_end 增量写而不在 agent_end 一次性写：agent_end 带的是整个 transcript，
 * 包含恢复时回灌的历史，一次性写会重复；增量写还有个好处是中断时已完成的消息
 * 本来就已落库，不需要特殊处理。
 *
 * @param startSeq 本次运行的第一个序号，由调用方从已有历史算出
 */
export function attachPersistence(
  service: SessionService,
  agent: Agent,
  sessionId: string,
  startSeq: number,
): () => void {
  let seq = startSeq;

  return agent.subscribe(async (event) => {
    // listener 的 promise 会被 agent await 并计入 run 的 settlement，
    // 异常泄漏出去会影响 agent 本身运行，所以这里必须全部吞掉
    try {
      if (event.type === "message_end") {
        await service.appendMessage(sessionId, seq, event.message);
        seq += 1;
        return;
      }

      if (event.type === "agent_end") {
        // 半截消息不在 state.messages 里，只能从 streamingMessage 取
        const partial = agent.state.streamingMessage;
        if (partial) {
          await service.appendMessage(sessionId, seq, partial, true);
          seq += 1;
        }
        await service.touch(sessionId);
      }
    } catch (error) {
      // 对话本身不该因为存不进数据库而崩掉
      logger.error({ err: error, sessionId }, "failed to persist agent message");
    }
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/api/src/services/session.test.ts`
Expected: PASS，14 个用例通过

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(api): agent 事件订阅落库"
```

---

## Task 7: 会话 CRUD 路由

**Files:**
- Create: `apps/api/src/http/routes/sessions.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/src/http/app.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `createSessionService`（Task 5）、`getDb`（Task 4）
- Produces: 四个路由
  - `GET /api/sessions` → `{ sessions: SessionSummary[] }`
  - `GET /api/sessions/:id/messages` → `{ messages: unknown[], interruptedSeqs: number[] }`
  - `PATCH /api/sessions/:id` body `{ title }` → `{ ok: true }` / 404
  - `DELETE /api/sessions/:id` → `{ ok: true }` / 404

- [ ] **Step 1: 写失败的测试**

`apps/api/src/http/app.test.ts` 末尾追加：

```ts
describe("session routes", () => {
  it("列表接口返回数组", async () => {
    const response = await app.request("/api/sessions");

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("sessions");
  });

  it("非法 UUID 直接 400，不进数据库", async () => {
    const response = await app.request("/api/sessions/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新名" }),
    });

    expect(response.status).toBe(400);
  });

  it("重命名时标题为空返回 400", async () => {
    const response = await app.request("/api/sessions/11111111-1111-1111-1111-111111111111", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });

    expect(response.status).toBe(400);
  });

  it("删除不存在的会话返回 404", async () => {
    const response = await app.request("/api/sessions/11111111-1111-1111-1111-111111111111", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
  });
});
```

> 这些用例连的是真实数据库。`GET /api/sessions` 在没有数据库时会 500，
> 所以本测试要求 `docker compose up -d` 已经起了 db 服务。
> 如果 CI 不方便起容器，把这个 describe 标记为 `describe.skipIf(!process.env.DATABASE_URL)`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/api/src/http/app.test.ts`
Expected: FAIL，`/api/sessions` 返回 404（路由还没挂）

- [ ] **Step 3: 实现路由**

创建 `apps/api/src/http/routes/sessions.ts`：

```ts
import { getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSessionService } from "../../services/session.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id 由前端生成，进数据库前先挡掉明显非法的，避免让 Postgres 报类型错 */
function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HTTPException(400, { message: "会话 id 必须是 UUID" });
  }
  return value;
}

export const sessions = new Hono()
  .get("/", async (c) => {
    const service = createSessionService(getDb());
    return c.json({ sessions: await service.list() });
  })

  .get("/:id/messages", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb());
    const history = await service.loadHistory(id);
    return c.json({ messages: history.messages, interruptedSeqs: history.interruptedSeqs });
  })

  .patch("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const body = await c.req.json<{ title?: string }>().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });

    const title = body.title?.trim();
    if (!title) {
      throw new HTTPException(400, { message: "title 不能为空" });
    }

    const service = createSessionService(getDb());
    if (!(await service.rename(id, title))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    return c.json({ ok: true });
  })

  .delete("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb());
    if (!(await service.remove(id))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: 挂载路由**

`apps/api/src/http/app.ts`：import 追加

```ts
import { sessions } from "./routes/sessions.ts";
```

路由挂载区追加（在 `chat` 之后）：

```ts
app.route("/api/sessions", sessions);
```

- [ ] **Step 5: 运行测试确认通过**

```bash
docker compose up -d
pnpm vitest run apps/api/src/http/app.test.ts
```

Expected: PASS，6 个用例（2 已有 + 4 新增）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http
git commit -m "feat(api): 会话 CRUD 路由"
```

---

## Task 8: /api/chat 接入持久化

**Files:**
- Modify: `apps/api/src/http/routes/chat.ts`

**Interfaces:**
- Consumes: `createSessionService` / `attachPersistence`（Task 5·6）、`getDb`（Task 4）
- Produces: `POST /api/chat` 请求体变为 `{ message, sessionId, systemPrompt? }`，SSE 响应格式**不变**

- [ ] **Step 1: 整份重写 chat 路由**

`apps/api/src/http/routes/chat.ts` 全文替换为：

```ts
import { createAgent } from "@petrel/agent-core";
import { getDb } from "@petrel/database";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { attachPersistence, createSessionService } from "../../services/session.ts";

interface ChatRequest {
  message?: string;
  sessionId?: string;
  systemPrompt?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 加载历史并确保会话存在。
 *
 * 这里**不手动存用户消息**：pi 的事件序列里用户消息同样会触发 message_end，
 * attachPersistence 订阅一处就收下了，手动再存一遍会重复。
 *
 * 数据库不可用时整段降级：对话照常进行，只是这一轮不会被保存，
 * 多轮上下文退化成单轮。能用但记不住，好过直接不能用。
 */
async function prepareSession(sessionId: string, message: string) {
  try {
    const service = createSessionService(getDb());
    await service.ensureSession(sessionId, message);

    const history = await service.loadHistory(sessionId);
    return { service, history: history.messages, nextSeq: history.nextSeq };
  } catch (error) {
    logger.error({ err: error, sessionId }, "session unavailable, continuing without persistence");
    return undefined;
  }
}

export const chat = new Hono().post("/", async (c) => {
  const body = await c.req.json<ChatRequest>().catch(() => {
    throw new HTTPException(400, { message: "请求体必须是 JSON" });
  });

  const message = body.message?.trim();
  if (!message) {
    throw new HTTPException(400, { message: "message 不能为空" });
  }

  const sessionId = body.sessionId;
  if (!sessionId || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }

  const prepared = await prepareSession(sessionId, message);

  return streamSSE(c, async (stream) => {
    const agent = createAgent({
      systemPrompt: body.systemPrompt,
      // 复用同一个 id 传给 pi，供 provider 做缓存感知
      sessionId,
      // 历史回灌：pi 的 AgentMessage 原样存原样取，不需要转换
      messages: prepared?.history,
    });

    // pi 的 AgentEvent 原样透传，前端按事件类型归约为消息状态
    agent.subscribe(async (event) => {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
    });

    if (prepared) {
      attachPersistence(prepared.service, agent, sessionId, prepared.nextSeq);
    }

    stream.onAbort(() => agent.abort());

    try {
      await agent.prompt(message);
    } catch (error) {
      logger.error({ err: error }, "agent run failed");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});
```

- [ ] **Step 2: 让 createAgent 支持 messages 与 sessionId**

`packages/agent-core/src/index.ts` 的 `CreateAgentOptions` 追加两个可选字段：

```ts
  /** 恢复会话时回灌的历史消息 */
  messages?: AgentMessage[];
  /** 透传给 pi，供 provider 做缓存感知 */
  sessionId?: string;
```

import 补上类型：

```ts
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
```

`createAgent` 的 `new Agent({...})` 改为：

```ts
  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: options.model ?? defaultModel(),
      tools: options.tools ?? [currentTime],
      ...(options.messages ? { messages: options.messages } : {}),
    },
    sessionId: options.sessionId,
    streamFn: models.streamSimple.bind(models),
  });
```

- [ ] **Step 3: 验证空 message 仍被挡下**

Run: `pnpm vitest run apps/api/src/http/app.test.ts`
Expected: PASS，已有的「rejects an empty message」用例仍通过

- [ ] **Step 4: 全量测试**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: 手工验证一次真实对话**

```bash
docker compose up -d
curl -N -X POST http://localhost:5050/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"现在几点","sessionId":"11111111-1111-1111-1111-111111111111"}'
```

Expected: SSE 流正常输出。然后：

```bash
curl -s http://localhost:5050/api/sessions | head -c 400
docker exec petrel-db-dev psql -U petrel -d petrel -c "select seq, role from messages order by seq;"
```

Expected: 会话列表里有这条会话；messages 表里有 user 与 assistant（可能还有 toolResult）多行，seq 从 1 连续递增。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src packages/agent-core/src
git commit -m "feat(api): chat 接入会话持久化与历史回灌"
```

---

## Task 9: 前端会话 API 与 store

**Files:**
- Create: `apps/web/src/apis/session_api.js`
- Create: `apps/web/src/stores/session.js`

**Interfaces:**
- Consumes: `apis/http.js` 的 `get` / `patch` / `del`（已存在，`put` 也在）
- Produces:
  - `session_api.js`：`listSessions()` / `fetchMessages(id)` / `renameSession(id, title)` / `deleteSession(id)`
  - `useSessionStore()`：state `list` / `currentId`；actions `refresh()` / `startNew()` / `select(id)` / `rename(id, title)` / `remove(id)`

前端没有测试栈，本任务靠构建 + 后续人工验收。

- [ ] **Step 1: 写接口封装**

创建 `apps/web/src/apis/session_api.js`：

```js
/**
 * 会话接口。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：前者带 JWT 注入与 401 处理，
 * 认证落地后不用再改这里。
 */
import { del, get, request } from '@/apis/http'

export function listSessions() {
  return get('/api/sessions').then((data) => data.sessions ?? [])
}

export function fetchMessages(sessionId) {
  return get(`/api/sessions/${sessionId}/messages`)
}

export function renameSession(sessionId, title) {
  return request(`/api/sessions/${sessionId}`, { method: 'PATCH', body: { title } })
}

export function deleteSession(sessionId) {
  return del(`/api/sessions/${sessionId}`)
}
```

- [ ] **Step 2: 写 store**

创建 `apps/web/src/stores/session.js`：

```js
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { deleteSession, listSessions, renameSession } from '@/apis/session_api'

export const useSessionStore = defineStore('session', () => {
  const list = ref([])
  const currentId = ref(null)
  const loading = ref(false)

  async function refresh() {
    loading.value = true
    try {
      list.value = await listSessions()
    } catch {
      // 列表拉不到不该阻塞对话本身，保持上一次的结果
      list.value = list.value ?? []
    } finally {
      loading.value = false
    }
  }

  /**
   * 新建会话是纯前端操作：生成 id、切过去就完了，不调任何接口。
   * 这个会话要等用户发出第一条消息、后端 upsert 建行之后才会出现在列表里。
   * 好处是开了新对话又没说话就切走，不会留下一堆空会话。
   */
  function startNew() {
    currentId.value = crypto.randomUUID()
    return currentId.value
  }

  function select(id) {
    currentId.value = id
  }

  async function rename(id, title) {
    await renameSession(id, title)
    const target = list.value.find((item) => item.id === id)
    if (target) target.title = title
  }

  async function remove(id) {
    await deleteSession(id)
    list.value = list.value.filter((item) => item.id !== id)
    if (currentId.value === id) currentId.value = null
  }

  return { list, currentId, loading, refresh, startNew, select, rename, remove }
})
```

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/apis/session_api.js apps/web/src/stores/session.js
git commit -m "feat(web): 会话接口与 store"
```

---

## Task 10: useAgentStream 与 chat_api 接入 sessionId

**Files:**
- Modify: `apps/web/src/apis/chat_api.js`
- Modify: `apps/web/src/composables/useAgentStream.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `streamChat({ message, sessionId, systemPrompt, signal }, onFrame)`
  - `useAgentStream()` 新增 `loadHistory(messages)`；`send(message, { sessionId, systemPrompt })`

**`useAgentStream.js` 上一轮是「一行不改」的红线**，那是因为那轮纯粹换渲染层。
这轮它必须能被灌入历史、必须知道 sessionId，所以要改——但 **AgentEvent 的归约逻辑
（`apply` 函数）一行不动**，只加载入口。

- [ ] **Step 1: chat_api 加 sessionId**

`apps/web/src/apis/chat_api.js` 的 `streamChat` 函数签名与 body 改为：

```js
export async function streamChat({ message, sessionId, systemPrompt, signal }, onFrame) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, systemPrompt }),
    signal
  })
```

同时更新它上方的 JSDoc：

```js
/**
 * 发起一次对话并逐帧回调。
 *
 * @param {{ message: string, sessionId: string, systemPrompt?: string, signal?: AbortSignal }} params
 * @param {(frame: { event: string, data: any }) => void} onFrame
 */
```

- [ ] **Step 2: useAgentStream 加 loadHistory 与 sessionId**

`apps/web/src/composables/useAgentStream.js` 的 `reset` 函数之后追加：

```js
  /** 切换会话时把历史消息灌进来。归约逻辑不参与，直接覆盖整个数组。 */
  function loadHistory(history) {
    messages.value = Array.isArray(history) ? [...history] : []
    toolCalls.value = {}
    error.value = ''
    activeIndex = -1
  }
```

`send` 函数改为接受 sessionId 并透传：

```js
  async function send(message, options = {}) {
    if (running.value || !message.trim()) return
    running.value = true
    error.value = ''
    controller.value = new AbortController()

    try {
      await streamChat(
        {
          message,
          sessionId: options.sessionId,
          systemPrompt: options.systemPrompt,
          signal: controller.value.signal
        },
        (frame) => {
          if (frame.event === 'error') {
            error.value = frame.data?.message ?? '服务端返回未知错误'
            return
          }
          if (frame.event === 'agent' && frame.data) {
            apply(frame.data)
          }
        }
      )
    } catch (err) {
      if (err.name !== 'AbortError') {
        error.value = err.message
      }
    } finally {
      running.value = false
      controller.value = null
    }
  }
```

返回值追加 `loadHistory`：

```js
  return { messages, toolCalls, running, error, canSend, send, abort, reset, loadHistory }
```

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/apis/chat_api.js apps/web/src/composables/useAgentStream.js
git commit -m "feat(web): 对话流支持 sessionId 与历史加载"
```

---

## Task 11: 左栏接真实数据与 ChatView 整合

**Files:**
- Modify: `apps/web/src/components/shell/SessionSidebar.vue`
- Modify: `apps/web/src/views/ChatView.vue`

**Interfaces:**
- Consumes: `useSessionStore`（Task 9）、`useAgentStream().loadHistory`（Task 10）、`fetchMessages`（Task 9）
- Produces: 无

- [ ] **Step 1: 左栏渲染真实列表**

`apps/web/src/components/shell/SessionSidebar.vue` 的 `.sessions` 区块替换为：

```vue
    <div class="sessions">
      <div class="group-title">会话</div>

      <div v-if="sessionStore.loading" class="empty">加载中…</div>
      <div v-else-if="sessionStore.list.length === 0" class="empty">暂无历史会话</div>

      <div
        v-for="item in sessionStore.list"
        :key="item.id"
        class="session-item"
        :class="{ active: item.id === sessionStore.currentId }"
        @click="emit('select', item.id)"
      >
        <span class="session-title">{{ item.title }}</span>
        <button class="icon-btn" type="button" title="重命名" @click.stop="onRename(item)">
          <Pencil :size="14" />
        </button>
        <button class="icon-btn" type="button" title="删除" @click.stop="onRemove(item)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
```

script 部分追加：

```js
import { onMounted } from 'vue'
import { Pencil, Trash2 } from 'lucide-vue-next'
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()

onMounted(() => sessionStore.refresh())

async function onRename(item) {
  const next = window.prompt('重命名会话', item.title)
  if (!next || !next.trim() || next === item.title) return
  await sessionStore.rename(item.id, next.trim())
}

async function onRemove(item) {
  if (!window.confirm(`删除会话「${item.title}」？`)) return
  await sessionStore.remove(item.id)
  if (item.id === sessionStore.currentId) emit('new-chat')
}
```

`defineEmits` 改为：

```js
const emit = defineEmits(['new-chat', 'select'])
```

样式追加：

```less
.session-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;

  .icon-btn {
    opacity: 0;
  }

  &:hover {
    background: var(--surface-hover);
    color: var(--text-strong);

    .icon-btn {
      opacity: 1;
    }
  }

  &.active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.session-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
}
```

- [ ] **Step 2: AppShell 转发 select 事件**

`apps/web/src/layouts/AppShell.vue` 的 `<SessionSidebar>` 改为：

```vue
      <SessionSidebar @new-chat="onNewChat" @select="onSelectSession" />
```

script 追加：

```js
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()

// 选中会话统一走 store，ChatView 监听 currentId 变化加载历史
function onSelectSession(id) {
  sessionStore.select(id)
  if (route.path !== '/agent') router.push('/agent')
}
```

`onNewChat` 改为同时开一个新的 session id：

```js
function onNewChat() {
  sessionStore.startNew()
  if (route.path === '/agent') {
    chatKey.value += 1
  } else {
    router.push('/agent')
  }
}
```

- [ ] **Step 3: ChatView 接上 sessionId 与历史**

`apps/web/src/views/ChatView.vue` 的 script 追加 import 与逻辑。

> 该文件已有 `import { computed, nextTick, onUnmounted, ref, watch } from 'vue'`——
> 把 `onMounted` **合并进这一条**，不要新起第二条 vue import。

```js
// onMounted 合并进已有的 vue import，这里单列只是为了标明用到了它
import { fetchMessages } from '@/apis/session_api'
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()

// 进入对话页时若还没有当前会话，开一个新的
onMounted(() => {
  if (!sessionStore.currentId) sessionStore.startNew()
  else void loadSession(sessionStore.currentId)
})

async function loadSession(id) {
  try {
    const data = await fetchMessages(id)
    loadHistory(data.messages ?? [])
  } catch {
    // 历史拉不到就当空会话继续，不阻塞用户提问
    loadHistory([])
  }
}

watch(
  () => sessionStore.currentId,
  (id) => {
    if (id) void loadSession(id)
  }
)
```

`useAgentStream()` 的解构追加 `loadHistory`：

```js
const { messages, toolCalls, running, error, send, abort, reset, loadHistory } = useAgentStream()
```

`submit` 改为带上 sessionId，并在发出后刷新列表：

```js
async function submit() {
  const text = draft.value.trim()
  if (!text || running.value) return

  const sessionId = sessionStore.currentId ?? sessionStore.startNew()
  const isFirstMessage = messages.value.length === 0

  draft.value = ''
  await send(text, { sessionId })

  // 首条消息会让后端建出这个会话，刷新列表把它显示出来；
  // 后续消息只是更新 updatedAt，也要刷新以保证排序正确
  await sessionStore.refresh()
  if (isFirstMessage) sessionStore.select(sessionId)
}
```

`newChat` 改为同时开新 session：

```js
function newChat() {
  abort()
  reset()
  workspace.clear()
  draft.value = ''
  sessionStore.startNew()
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm --filter @petrel/web run build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): 左栏接真实会话数据"
```

---

## Task 12: 全量验收与文档

**Files:**
- Modify: `docs/backend-plan.md`
- Modify: `docs/frontend-plan.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 全量构建与测试**

```bash
pnpm install
pnpm run build
pnpm test
```

Expected: 三条全部成功。

- [ ] **Step 2: 起容器**

```bash
docker compose up -d
docker logs petrel-db-dev --tail 20
docker logs petrel-api-dev --tail 30
docker logs petrel-web-dev --tail 20
```

Expected: 三个容器都正常，api 日志有 `database migrations applied`。

- [ ] **Step 3: 逐项人工验收**

浏览器打开 `http://localhost:5173/agent`：

| # | 检查项 | ✓ |
| --- | --- | --- |
| 1 | 首次启动自动建表，api 日志无 migration 报错 | |
| 2 | 发一条消息后刷新页面，对话内容还在 | |
| 3 | 左栏出现该会话，标题是首条消息的前 30 字 | |
| 4 | 新建第二个会话，两个会话能来回切换且内容不串 | |
| 5 | 重命名会话，刷新后新名字保持 | |
| 6 | 删除会话，其消息一并消失，左栏不再显示 | |
| 7 | 发消息中途点停止，刷新后能看到半截回答 | |
| 8 | 触发工具调用的对话（问「现在几点」），刷新后工具卡片与结果正确重建 | |
| 9 | 左栏按最近更新排序，在旧会话里发消息后它跳到顶部 | |
| 10 | 点「新对话」但不发消息就切走，左栏不会多出空会话 | |
| 11 | `docker compose stop db` 后发消息，对话仍能流式输出，api 日志有 error | |

第 11 项验证「落库失败不中断对话」这条决策。验完记得 `docker compose start db`。

- [ ] **Step 4: 更新后端计划**

`docs/backend-plan.md` 的「## 3. 已完成」一节末尾追加：

```markdown
### M1 数据层 + M2 会话持久化（HEU-6 / HEU-10，2026-08-01 交付）

`packages/database`：Drizzle schema（`users` · `sessions` · `messages`）+ 连接池 + migration +
两个 repository。compose 加 `pgvector/pgvector:pg17` 服务，api 启动时跑 migration。

`POST /api/chat` 接 `sessionId`：加载历史回灌 `initialState.messages`，
按 `message_end` 增量落库，`agent_end` 时把 `state.streamingMessage`（中断的半截回答）
标记 `interrupted` 存下。新增 `/api/sessions` 四个 CRUD 接口。

三个设计决定与 backend-plan 原计划不同，都是有意的：

1. **没建 `tool_calls` 表**。pi 的工具结果是一条独立的 `toolResult` 类型 `AgentMessage`，
   存进 `messages` 已经完整。单独的表是给 Dashboard 统计做的反范式，等 HEU-28 再加。
2. **没做 `persisted` 事件**。它是断线重连的幂等去重手段，而断线重连需要前端重连状态机，
   是另一个量级的复杂度，单独一轮做。
3. **session id 由前端生成**（对照 Vercel ai-chatbot 的做法），因此 SSE 协议不用新增
   事件类型来回传 id。

**消息排序用整数 `seq` 而不是 `created_at`**：agent 一轮会连续产出 assistant 与 toolResult
多条消息，插入时间戳可能落在同一毫秒。OpenAI Agents SDK 的 SQLAlchemySession 用
`created_at` 主 + `id` 次排序，本质是在打这个补丁；`seq` 一步到位。

数据层测试用 PGlite（Node 内的 WASM Postgres）而不是 testcontainers：毫秒级启动、
CI 不需要 Docker，而外键、级联、唯一约束、事务这些语义都是真的。
```

- [ ] **Step 5: 更新前端计划**

`docs/frontend-plan.md` 的「## 2. 当前状态」一节末尾追加：

```markdown
### 已完成：会话列表接真实数据（2026-08-01）

`stores/session.js` + `apis/session_api.js`，左栏支持列表 / 新建 / 切换 / 重命名 / 删除，
刷新后能恢复历史。

**「新建会话」是纯前端操作**：点新对话只生成一个 UUID 并清空当前对话，不调任何接口。
这个会话要等用户发出第一条消息、后端 upsert 建行之后才出现在左栏。所以新建后立刻刷新页面，
那个空会话会消失——这是预期行为，与 ChatGPT 一致，避免攒下一堆空会话。

`composables/useAgentStream.js` 这次改了（上一轮它是「一行不改」的红线）：新增
`loadHistory(messages)` 入口、`send` 接受 `sessionId`。**AgentEvent 的归约逻辑没动**，
只加了加载入口。

断线重连与 `persisted` 幂等去重仍未做，等后端的 `persisted` 事件。
```

- [ ] **Step 6: 更新 CLAUDE.md**

`CLAUDE.md` 的「## 架构」一节，package 列表里 `packages/config` 之前插入：

```markdown
- `packages/database` — Drizzle schema 与 repository。`sessions` / `messages` 存 pi 的
  `AgentMessage` JSONB，消息用整数 `seq` 排序（同一轮的多条消息时间戳可能相同）。
  测试用 PGlite 内存 Postgres，不需要 Docker。
```

依赖方向那段改为：

```markdown
依赖方向固定为 `apps → packages`，package 之间只能指向更底层的 package：
`api → agent-core → ai → config`、`api → database → config`、`api → logger → config`。
```

「### 对话链路」小节的请求体说明改为：

```markdown
`POST /api/chat`，请求体 `{ message, sessionId, systemPrompt? }`，响应 SSE：
```

并在该小节末尾追加：

```markdown
`sessionId` 由**前端生成**（`crypto.randomUUID()`），后端 upsert。所以 SSE 不需要回传
新会话 id。会话 CRUD 在 `/api/sessions`。
```

- [ ] **Step 7: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: 记录数据层与会话持久化交付状态"
```

---

## 附：本次未做的事

以下都是有意留下的：

- **断线重连与 `persisted` 事件**——需要前端重连状态机，单独一轮
- **认证**（HEU-7）——只建了 users 表与默认用户，登录、JWT 中间件、超管初始化都没做
- **`tool_calls` 表**——等 HEU-28 Dashboard 真要统计时再加
- **会话搜索与分页**——会话多了才需要
- **消息编辑与重新生成**——涉及 transcript 截断与分支，单独设计
- **知识库、Dashboard、评测、agent 注册表**——各自独立的子系统

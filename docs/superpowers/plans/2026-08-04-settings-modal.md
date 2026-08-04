# 设置面板与用户偏好 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新 UI（`AppShell`）里启用一个个人偏好设置模态框（默认模型 · 默认 system prompt · 主题 · 修改密码），并补齐它需要的后端 API。

**Architecture:** 偏好落库在新表 `user_preferences`（一人一行，两列可空，`null` = 跟随系统默认），通过 `GET`/`PUT /api/account/preferences` 读写；前端把偏好读进 pinia，发消息时随 `POST /api/chat` 请求体上传 `model` 与 `systemPrompt`，后端只校验 `model` 在注册表白名单里。改密码是 `POST /api/account/password`，复用 `services/auth.ts` 里既有的密码规则与失败限流。可用模型清单由 `packages/ai` 的静态注册表派生，经 `packages/agent` 转出给 server——server 永远不直接 import `@petrel/ai`，也不碰 pi 的类型。

**Tech Stack:** TypeScript ESM monorepo（Node 24 + pnpm workspace）· Hono · Drizzle ORM + Postgres（测试用 PGlite）· Vue 3 + Vite + Ant Design Vue + pinia（JS，未 TS 化）· vitest · pi (`@earendil-works/pi-agent-core` / `pi-ai`)

**Spec:** [docs/superpowers/specs/2026-08-04-settings-modal-design.md](../specs/2026-08-04-settings-modal-design.md)

---

## 偏离 spec 之处（先看这一节）

实施过程中发现三处 spec 未覆盖、但必须定下来的细节。都已写进下面的任务，**如果不同意就在开工前否掉**：

1. **`ModelSummary` 多一个 `isDefault` 字段。** spec §3.2 写的是 `{ id, name, provider, providerName }`。但验收标准 #3 要求「输入框旁显示的模型名与实际使用的模型一致」，而偏好为 `null`（跟随系统默认）时前端无从知道系统默认是哪个，只能显示空。加 `isDefault: model.id === DEFAULT_MODEL_ID` 解决，成本一行。
2. **`systemPrompt` 加长度上限 4000 字并清 NUL。** spec 没提。`system_prompt` 与 `sessions.title` 一样是无长度限制的 `text` 列，而 `routes/sessions.ts` 已经为 title 加过 `TITLE_LENGTH_LIMIT`，理由完全适用：一次请求就能塞进几十万字，之后每轮对话都要整份发给模型。NUL 同理——Postgres 的 `text` 存不了 NUL，漏过去是 500（`requireTitle` 踩过）。
3. **`getAuthService()` 单例从 `routes/auth.ts` 移到 `services/auth.ts`。** spec §3.3 说改密码复用登录的内存 limiter，但那个 limiter 存在 service **实例内部**，而单例现在是 `routes/auth.ts` 的模块私有变量。不移出来，`routes/account.ts` 就只能新建一个实例 = 两套计数器，限流形同虚设。

---

## File Structure

### 后端

| 文件 | 责任 |
| --- | --- |
| `packages/database/src/schema.ts` （改） | 加 `userPreferences` 表定义 |
| `packages/database/drizzle/0003_*.sql` （生成） | migration，由 `db:generate` 产出 |
| `packages/database/src/testing.ts` （改） | `TRUNCATE` 清表列表要加上新表，否则用例之间不隔离 |
| `packages/database/src/repositories/preferences.ts` （新） | 偏好的读与全量写，仅此两个操作 |
| `packages/database/src/repositories/users.ts` （改） | 加 `setPasswordHash` |
| `packages/database/src/index.ts` （改） | 导出新 repository |
| `packages/ai/src/index.ts` （改） | `listModels()` / `findModel()`，模型注册表的单一来源 |
| `packages/agent/src/index.ts` （改） | 转出 `listModels`；`createAgent` 加 `modelId` 选项 |
| `apps/server/src/services/auth.ts` （改） | `changePassword` + 共享的 `getAuthService()` 单例 |
| `apps/server/src/http/routes/auth.ts` （改） | 改用 services 里的共享单例 |
| `apps/server/src/http/routes/account.ts` （新） | 偏好读写 + 改密码三个端点 |
| `apps/server/src/http/routes/chat.ts` （改） | `parseChatRequest` 收 `model` 并校验白名单 |
| `apps/server/src/http/app.ts` （改） | 在 `requireAuth` 之下挂 `/api/account` |

### 前端

| 文件 | 责任 |
| --- | --- |
| `apps/web/src/apis/account_api.js` （新） | 三个端点的调用封装 |
| `apps/web/src/stores/preferences.js` （新） | 偏好状态 + 模型清单 + 三态加载 |
| `apps/web/src/components/settings/SettingsModal.vue` （新） | 只管开关与当前 tab，不认识任何设置项 |
| `apps/web/src/components/settings/GeneralPanel.vue` （新） | 默认模型 · system prompt · 主题 |
| `apps/web/src/components/settings/AccountPanel.vue` （新） | 邮箱只读 · 修改密码 |
| `apps/web/src/layouts/AppShell.vue` （改） | 挂载模态框，持开关状态 |
| `apps/web/src/components/shell/SessionSidebar.vue` （改） | 底部用户行加齿轮入口 |
| `apps/web/src/apis/chat_api.js` （改） | 请求体加 `model` |
| `apps/web/src/composables/useAgentStream.js` （改） | `send()` 转发 `options.model` |
| `apps/web/src/views/ChatView.vue` （改） | 发消息带上偏好；模型名改成读 store |

### 删除

`apps/web/src/components/SettingsModal.vue` · `apps/web/src/components/BasicSettingsSection.vue` · `apps/web/src/layouts/AppLayout.vue`

---

## 环境提示（每个任务都适用）

- 测试从**仓库根**跑：`pnpm vitest run <路径>`，单个用例加 `-t "名字"`。
- 后端数据层测试用 PGlite 内存 Postgres，**不需要 Docker**。
- **不要在宿主机起前端 dev server**；`pnpm run build` / `typecheck` / `lint` / `test` 可以在宿主机跑。
- `apps/web` 没有 typecheck，`pnpm run lint` 也不可用（v0.4 遗留），前端的唯一自动化关卡是 `pnpm run build`。
- 仓库统一 LF 换行。写文件时不要引入 CRLF，会与 Biome 冲突。

---

## Task 1: `user_preferences` 表与 migration

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/testing.ts`
- Test: `packages/database/src/schema.test.ts`
- Create（生成物）: `packages/database/drizzle/0003_*.sql`

- [ ] **Step 1: 写失败的测试**

在 `packages/database/src/schema.test.ts` 里，把顶部的 import 改成也引入新表：

```ts
import { messages, sessions, userPreferences, users } from "./schema.ts";
```

然后在 `describe("schema", ...)` 的最后一个 `it` 之后追加三个用例：

```ts
  it("偏好一人一行：同一用户插两次会撞主键", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "a" });

    await expect(
      db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "b" }),
    ).rejects.toThrow();
  });

  it("两列都可空：null 表示跟随系统默认", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID });

    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, TEST_USER_ID));
    expect(rows[0]).toMatchObject({ defaultModel: null, systemPrompt: null });
  });

  it("删除用户会级联删掉它的偏好", async () => {
    await db.insert(userPreferences).values({ userId: TEST_USER_ID, defaultModel: "a" });

    await db.delete(users).where(eq(users.id, TEST_USER_ID));

    expect(await db.select().from(userPreferences)).toHaveLength(0);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/database/src/schema.test.ts`
Expected: FAIL —— `userPreferences` 不是 `./schema.ts` 的导出，模块解析就报错。

- [ ] **Step 3: 加表定义**

在 `packages/database/src/schema.ts` 末尾追加（`messages` 之后）：

```ts
/**
 * 用户偏好。一人一行，所以 user_id 直接做主键，没有单独的自增 id。
 *
 * 不做成 users 表上的一个 jsonb 列：requireAuth 每个请求都要 findById 查一次
 * users（apps/server/src/http/middleware/auth.ts），把可能几 KB 的 system prompt
 * 挂在那张表上等于每个请求都白读一遍。
 *
 * 两列都可空，null 表示「跟随系统默认」——不是空字符串。route 层会把空串归一成 null，
 * 否则清空 system prompt 会存一个 ""，然后被当作有效值发给模型。
 */
export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultModel: text("default_model"),
  systemPrompt: text("system_prompt"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`pgTable` / `text` / `timestamp` / `uuid` 都已经在文件顶部的 import 里，不用改 import。

- [ ] **Step 4: 生成 migration**

Run: `pnpm --filter @petrel/database db:generate`
Expected: 输出类似 `[✓] Your SQL migration file ➜ drizzle/0003_xxx.sql`，`packages/database/drizzle/` 下多一个 `0003_*.sql`，`drizzle/meta/` 里的快照同步更新。

用 `git status` 确认新增的是 `0003_*.sql` 与 `meta/` 下的文件，**没有**改动 `0000`~`0002`。

- [ ] **Step 5: 把新表加进测试清表列表**

`packages/database/src/testing.ts` 有两处要改。先是 import：

```ts
import { messages, sessions, userPreferences, users } from "./schema.ts";
```

然后是 `reset()` 里的 `TRUNCATE`：

```ts
      await db.execute(
        sql`TRUNCATE ${users}, ${sessions}, ${messages}, ${userPreferences} RESTART IDENTITY CASCADE`,
      );
```

漏掉这一步的后果很具体：`user_preferences` 有指向 `users` 的外键，`TRUNCATE users ... CASCADE` 会把它一起清掉，所以数据隔离**看起来**是好的；但一旦将来这个外键变了，用例之间就会串数据，而且没人会想到来这里查。显式列出来。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run packages/database/src/schema.test.ts`
Expected: PASS，全部用例（含原有 8 个）通过。

- [ ] **Step 7: 提交**

```bash
git add packages/database/src/schema.ts packages/database/src/schema.test.ts packages/database/src/testing.ts packages/database/drizzle
git commit -m "feat(database): 加 user_preferences 表"
```

---

## Task 2: 偏好 repository

**Files:**
- Create: `packages/database/src/repositories/preferences.ts`
- Create: `packages/database/src/repositories/preferences.test.ts`
- Modify: `packages/database/src/index.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/database/src/repositories/preferences.test.ts`：

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createPreferencesRepository } from "./preferences.ts";

let db: TestDb;
let repo: ReturnType<typeof createPreferencesRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离（同 schema.test.ts）
beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
  repo = createPreferencesRepository(db);
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

describe("createPreferencesRepository", () => {
  // 响应形状恒定是个契约：调用方不该需要区分「没这行」和「两项都跟随默认」
  it("没有行时返回两项都是 null，而不是 undefined", async () => {
    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: null,
    });
  });

  it("save 会懒创建这一行", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "你是助手" });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: "m-1",
      systemPrompt: "你是助手",
    });
  });

  it("save 第二次走更新而不是插入，不撞主键", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "第一版" });

    await repo.save(TEST_USER_ID, { defaultModel: "m-2", systemPrompt: "第二版" });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: "m-2",
      systemPrompt: "第二版",
    });
  });

  // 全量语义：null 是「清回系统默认」，不是「这项别动」
  it("save 传 null 会把已有的值清掉", async () => {
    await repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: "你是助手" });

    await repo.save(TEST_USER_ID, { defaultModel: null, systemPrompt: null });

    await expect(repo.findByUserId(TEST_USER_ID)).resolves.toEqual({
      defaultModel: null,
      systemPrompt: null,
    });
  });

  it("save 返回落库后的值，调用方不用再查一次", async () => {
    await expect(
      repo.save(TEST_USER_ID, { defaultModel: "m-1", systemPrompt: null }),
    ).resolves.toEqual({ defaultModel: "m-1", systemPrompt: null });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/database/src/repositories/preferences.test.ts`
Expected: FAIL —— `Failed to load ./preferences.ts`（文件还不存在）。

- [ ] **Step 3: 写实现**

创建 `packages/database/src/repositories/preferences.ts`：

```ts
import { eq, sql } from "drizzle-orm";
import { userPreferences } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface UserPreferences {
  /** null = 跟随 @petrel/ai 的 DEFAULT_MODEL_ID */
  defaultModel: string | null;
  /** null = 跟随 @petrel/agent 的 DEFAULT_SYSTEM_PROMPT */
  systemPrompt: string | null;
}

/**
 * 没有行与「两项都跟随默认」是同一件事，所以查不到时返回这个而不是 undefined。
 * 调用方（route）因此不需要分支，响应形状也恒定。
 */
const EMPTY: UserPreferences = { defaultModel: null, systemPrompt: null };

/** 与 sessions.ts 一样用数据库时钟，不用 JS 的 new Date()，避免两个时钟源混用 */
const NOW = sql`now()`;

export function createPreferencesRepository(db: Database) {
  return {
    async findByUserId(userId: string): Promise<UserPreferences> {
      const rows = await db
        .select({
          defaultModel: userPreferences.defaultModel,
          systemPrompt: userPreferences.systemPrompt,
        })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);
      return rows[0] ?? EMPTY;
    },

    /**
     * 全量写入：传进来的 null 会真的把库里的值清掉，这是「清回系统默认」的唯一途径。
     * 懒创建——没改过设置的用户一行都不占。
     */
    async save(userId: string, values: UserPreferences): Promise<UserPreferences> {
      // 0 参 returning()：TS 在 NodePgDatabase | PgliteDatabase 联合上调用带泛型的
      // returning(fields) 会误解析到 0 参重载而报 TS2554（同 sessions.ts 的说明）
      const rows = await db
        .insert(userPreferences)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { ...values, updatedAt: NOW },
        })
        .returning();

      const row = rows[0];
      if (!row) return EMPTY;
      return { defaultModel: row.defaultModel, systemPrompt: row.systemPrompt };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/database/src/repositories/preferences.test.ts`
Expected: PASS，5 个用例全绿。

- [ ] **Step 5: 从包入口导出**

`packages/database/src/index.ts` 加一行，保持字母序（在 `messages` 之后、`sessions` 之前）：

```ts
export * from "./repositories/preferences.ts";
```

- [ ] **Step 6: typecheck**

Run: `pnpm run typecheck`
Expected: 全部包通过，无输出错误。

- [ ] **Step 7: 提交**

```bash
git add packages/database/src/repositories/preferences.ts packages/database/src/repositories/preferences.test.ts packages/database/src/index.ts
git commit -m "feat(database): 加偏好 repository"
```

---

## Task 3: `users.setPasswordHash`

**Files:**
- Modify: `packages/database/src/repositories/users.ts`
- Test: `packages/database/src/repositories/users.test.ts`

- [ ] **Step 1: 先读一遍现有测试的 setup**

Run: `sed -n 1,40p packages/database/src/repositories/users.test.ts`

记下三件事：仓储实例的变量名（下面假设是 `repo`）、建用户用的调用形式（下面假设是 `repo.create({ email, passwordHash })`）、以及清表是在 `beforeEach` 里还是别处。Step 2 的代码按实际的名字写，**不要照抄下面的示例名**。

- [ ] **Step 2: 写失败的测试**

在 `packages/database/src/repositories/users.test.ts` 的最后一个 `describe` 块内追加：

```ts
  it("setPasswordHash 换掉哈希", async () => {
    const user = await repo.create({ email: "a@x.io", passwordHash: "old" });

    await expect(repo.setPasswordHash(user.id, "new")).resolves.toBe(true);

    const found = await repo.findByEmail("a@x.io");
    expect(found?.passwordHash).toBe("new");
  });

  it("setPasswordHash 用户不存在时返回 false", async () => {
    await expect(
      repo.setPasswordHash("00000000-0000-0000-0000-0000000000ff", "new"),
    ).resolves.toBe(false);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run packages/database/src/repositories/users.test.ts`
Expected: FAIL —— `repo.setPasswordHash is not a function`。

- [ ] **Step 4: 写实现**

在 `packages/database/src/repositories/users.ts` 的 `setRole` 之后追加：

```ts
    /** 只有「用户自己改密码」这一条路径会调它。admin 无权替人改密码 */
    async setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
      const updated = await db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, id))
        .returning();
      return updated.length > 0;
    },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/database/src/repositories/users.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/database/src/repositories/users.ts packages/database/src/repositories/users.test.ts
git commit -m "feat(database): 加 setPasswordHash"
```

---

## Task 4: 模型清单（`packages/ai`）

**Files:**
- Modify: `packages/ai/src/index.ts`
- Create: `packages/ai/src/models.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `packages/ai/src/models.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, findModel, listModels } from "./index.ts";

describe("listModels", () => {
  it("列出所有已注册的模型", () => {
    const ids = listModels().map((model) => model.id);

    expect(ids).toContain(DEFAULT_MODEL_ID);
    expect(ids).toContain("deepseek-ai/DeepSeek-V3");
  });

  it("每一项都带展示用的名字与 provider", () => {
    const model = listModels().find((item) => item.id === DEFAULT_MODEL_ID);

    expect(model).toMatchObject({
      id: DEFAULT_MODEL_ID,
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
  });

  // 前端靠这个标记显示「跟随系统默认」时到底用的哪个模型，
  // 否则偏好为 null 时输入框旁只能显示空
  it("恰好一个模型标着 isDefault，且是 DEFAULT_MODEL_ID", () => {
    const defaults = listModels().filter((model) => model.isDefault);

    expect(defaults.map((model) => model.id)).toEqual([DEFAULT_MODEL_ID]);
  });

  // 摘要是给 HTTP 响应用的，不该把 baseUrl / cost / 内部开关吐给前端
  it("摘要里没有 baseUrl 与 cost", () => {
    expect(JSON.stringify(listModels())).not.toContain("baseUrl");
    expect(JSON.stringify(listModels())).not.toContain("cost");
  });
});

describe("findModel", () => {
  it("按 id 查得到已注册的模型", () => {
    expect(findModel(DEFAULT_MODEL_ID)?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("未注册的 id 返回 undefined", () => {
    expect(findModel("gpt-does-not-exist")).toBeUndefined();
  });

  // listModels 与 findModel 必须同源，否则会出现「清单里有但查不到」的模型
  it("清单里的每一个 id 都查得到", () => {
    for (const summary of listModels()) {
      expect(findModel(summary.id)?.id).toBe(summary.id);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/ai/src/models.test.ts`
Expected: FAIL —— `listModels` / `findModel` 不是 `./index.ts` 的导出。

- [ ] **Step 3: 写实现**

`packages/ai/src/index.ts` 顶部的 import 加上 `type Api`：

```ts
import { type Api, createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
```

然后在文件末尾（`defaultModel()` 之后）追加：

```ts
/** 给 HTTP 响应用的模型摘要。不含 baseUrl / cost / 内部开关 */
export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  /** 偏好为 null（跟随系统默认）时，前端靠这个知道实际用的是哪个 */
  isDefault: boolean;
}

/**
 * 已注册模型的单一来源，listModels() 与 findModel() 都从这里派生。
 *
 * 不去翻 pi 的 Models 有没有枚举 API：本地静态数组更简单、可测，而且模型对象
 * 本来就在这个文件里定义。新增模型时只加到这里，两个函数自动跟上。
 */
const REGISTERED: readonly { model: Model<Api>; providerName: string }[] = [
  { model: deepseekV4Flash, providerName: "DeepSeek" },
  { model: deepseekV3, providerName: "SiliconFlow" },
];

export function listModels(): ModelSummary[] {
  return REGISTERED.map(({ model, providerName }) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    providerName,
    isDefault: model.id === DEFAULT_MODEL_ID,
  }));
}

/**
 * 按 model id 查。两个 provider 的 id 不重名，所以不需要同时传 provider——
 * 偏好里只存一个字符串，多带一个 provider 只是让前端多存一份能推出来的信息。
 */
export function findModel(id: string): Model<Api> | undefined {
  return REGISTERED.find((entry) => entry.model.id === id)?.model;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/ai/src/models.test.ts`
Expected: PASS，7 个用例全绿。

- [ ] **Step 5: typecheck**

Run: `pnpm run typecheck`
Expected: 通过。

若 `REGISTERED` 那行报 `Model<"openai-responses">` 不能赋给 `Model<Api>`：不要改成 `as`，把数组元素类型写成
`{ model: Model<"openai-responses"> | Model<"openai-completions">; providerName: string }`，
并把 `findModel` 的返回类型改成同一个联合。（现有代码里 `options.model ?? defaultModel()`
已经在做同样的赋值，所以正常情况下不会报。）

- [ ] **Step 6: 提交**

```bash
git add packages/ai/src/index.ts packages/ai/src/models.test.ts
git commit -m "feat(ai): 导出模型清单与按 id 查询"
```

---

## Task 5: `createAgent` 支持 `modelId`

**Files:**
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/src/agent.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `packages/agent/src/agent.test.ts` 末尾追加一个新的 describe 块：

```ts
describe("模型选择", () => {
  it("未注册的 modelId 抛错，而不是静默用默认模型", () => {
    // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
    expect(() => createAgent({ modelId: "gpt-does-not-exist" })).toThrow("模型未注册");
  });

  it("modelId 传 undefined 时用系统默认模型", () => {
    const agent = createAgent();

    expect(agent.state.model.id).toBe(DEFAULT_MODEL_ID);
  });

  it("modelId 命中注册表时用该模型", () => {
    const agent = createAgent({ modelId: "deepseek-ai/DeepSeek-V3" });

    expect(agent.state.model.id).toBe("deepseek-ai/DeepSeek-V3");
  });

  // chat.test.ts / isolation.test.ts 的 faux provider 注入靠这条优先级：
  // 它们把 model 铺在 options 之上，此时 modelId 必须让位
  it("显式的 model 优先于 modelId", () => {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    const models = createModels();
    models.setProvider(faux.provider);

    const agent = createAgent({ modelId: DEFAULT_MODEL_ID, models, model: faux.getModel() });

    expect(agent.state.model.id).toBe(faux.getModel().id);
  });
});
```

顶部的 import 补上 `DEFAULT_MODEL_ID`（来自 `@petrel/ai`）：

```ts
import { DEFAULT_MODEL_ID } from "@petrel/ai";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/agent/src/agent.test.ts -t "模型选择"`
Expected: FAIL —— `createAgent({ modelId })` 的 `modelId` 不在 `CreateAgentOptions` 上（TS 报错），运行时也不抛「模型未注册」。

- [ ] **Step 3: 写实现**

`packages/agent/src/index.ts` 三处改动。

其一，import 补上 `findModel` 与 `listModels`：

```ts
import { defaultModel, findModel, listModels, models as defaultModels } from "@petrel/ai";
```

其二，`CreateAgentOptions` 里 `model` 之后加一个字段：

```ts
  model?: Model<Api>;
  /**
   * 按 id 选模型，从 @petrel/ai 的注册表里查。
   *
   * 上层（apps/server）只传字符串、不碰 pi 的 Model 类型——依赖方向是
   * server → agent → ai，且 pi 的接线只允许出现在 agent 与 ai 两个 package。
   */
  modelId?: string;
```

其三，把 `initialState.model` 那一行换成调用一个新函数，并在 `createAgent` 之前定义它：

```ts
/**
 * 优先级：显式 model > modelId > 系统默认。
 *
 * 保留 model 这个口子是给测试的：chat.test.ts 与 isolation.test.ts 在模块边界
 * 包一层 createAgent，把 faux provider 的 models/model 铺在调用方 options 之上，
 * 所以它必须能盖掉 modelId。
 */
function resolveModel(options: CreateAgentOptions): Model<Api> {
  if (options.model) return options.model;
  if (options.modelId === undefined) return defaultModel();

  const model = findModel(options.modelId);
  if (!model) {
    // 列出可选值：这个错误会经 routes/chat.ts 变成 400 给到客户端，
    // 只说「未注册」的话对方不知道该改成什么
    throw new Error(
      `模型未注册：${options.modelId}，可选值为 ${listModels()
        .map((item) => item.id)
        .join(" | ")}`,
    );
  }
  return model;
}
```

`createAgent` 内部：

```ts
      model: resolveModel(options),
```

最后，把 `listModels` 与它的类型转出去给 server 用（在文件底部 `export { currentTime };` 旁）：

```ts
// 转出给 apps/server：让它拿到模型清单又不必依赖 @petrel/ai，
// 守住「pi 的接线只在 agent 与 ai」这条约束
export { listModels, type ModelSummary } from "@petrel/ai";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/agent/src/agent.test.ts`
Expected: PASS，原有 3 个用例 + 新增 4 个全绿。

- [ ] **Step 5: typecheck**

Run: `pnpm run typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/agent/src/index.ts packages/agent/src/agent.test.ts
git commit -m "feat(agent): createAgent 支持按 id 选模型并转出模型清单"
```

---

## Task 6: `changePassword` 与共享的 auth service 单例

**Files:**
- Modify: `apps/server/src/services/auth.ts`
- Modify: `apps/server/src/http/routes/auth.ts`
- Test: `apps/server/src/services/auth.test.ts`

- [ ] **Step 1: 先读一遍现有测试的 setup**

Run: `sed -n 1,45p apps/server/src/services/auth.test.ts`

记下 service 实例的变量名（下面假设是 `service`）与它是在 `beforeAll` 还是 `beforeEach` 里构造的。**关键一点**：失败计数器存在 service 实例内部，`reset()` 只清数据库不清它。如果该文件每个用例都新建一个 service 实例，下面的限流用例可以直接用；如果整个文件共用一个实例，那么涉及失败计数的用例（最后三条）要各用一个独占的邮箱，否则会互相干扰。Step 2 按实际情况调整邮箱。

- [ ] **Step 2: 写失败的测试**

在 `apps/server/src/services/auth.test.ts` 末尾追加一个 describe 块：

```ts
describe("changePassword", () => {
  const OLD = "hunter2hunter2";
  const NEW = "correcthorsebattery";

  async function seedUser() {
    return service.register("a@x.io", OLD);
  }

  it("旧密码正确时换掉密码", async () => {
    const user = await seedUser();

    await service.changePassword(user, OLD, NEW);

    await expect(service.login("a@x.io", NEW)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("换完之后旧密码登不进来", async () => {
    const user = await seedUser();
    await service.changePassword(user, OLD, NEW);

    await expect(service.login("a@x.io", OLD)).rejects.toMatchObject({ status: 401 });
  });

  it("旧密码不正确时 401 且不改动密码", async () => {
    const user = await seedUser();

    await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
      status: 401,
      message: "当前密码不正确",
    });
    await expect(service.login("a@x.io", OLD)).resolves.toMatchObject({ email: "a@x.io" });
  });

  it("新密码太短返回 400", async () => {
    const user = await seedUser();

    await expect(service.changePassword(user, OLD, "short")).rejects.toMatchObject({
      status: 400,
    });
  });

  // 长度校验排在旧密码校验之前：否则改成一个 3 位新密码要先白跑一次 scrypt，
  // 而且这种输入错误不该计进失败次数
  it("新密码太短时不消耗失败次数", async () => {
    const user = await seedUser();

    for (let i = 0; i < 6; i += 1) {
      await expect(service.changePassword(user, OLD, "short")).rejects.toMatchObject({
        status: 400,
      });
    }

    await expect(service.changePassword(user, OLD, NEW)).resolves.toBeUndefined();
  });

  it("旧密码连错 5 次后返回 429", async () => {
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
        status: 401,
      });
    }

    await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
      status: 429,
    });
  });

  // 计数器与 login 共用，这是有意的取舍：人已经在登录态里，锁住的只是重新登录，
  // 代价小于为它单开一套计数与清理逻辑。行为要有测试钉住，不然以后会被当成 bug 改掉
  it("改密码打满失败次数会连带锁住登录", async () => {
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(service.changePassword(user, "wrong-password", NEW)).rejects.toMatchObject({
        status: 401,
      });
    }

    await expect(service.login("a@x.io", OLD)).rejects.toMatchObject({ status: 429 });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/services/auth.test.ts -t "changePassword"`
Expected: FAIL —— `service.changePassword is not a function`。

- [ ] **Step 4: 写实现**

`apps/server/src/services/auth.ts` 三处改动。

其一，import 加上 `getDb`：

```ts
import { createUserRepository, type Database, getDb, type PublicUser } from "@petrel/database";
```

其二，在 `LOGIN_FAILED_MESSAGE` 常量旁加一条改密码专用文案：

```ts
/**
 * 改密码的失败文案可以具体，不像登录那样必须统一。
 * 走到这个端点的人已经通过 requireAuth，「当前密码不正确」不泄漏任何身份信息。
 */
const CHANGE_PASSWORD_FAILED_MESSAGE = "当前密码不正确";
const TOO_MANY_ATTEMPTS_MESSAGE = "尝试次数过多，请 15 分钟后再试";
```

其三，在 `createAuthService` 返回对象里、`login` 之后追加方法：

```ts
    /**
     * 改密码。调用方必须已通过 requireAuth，user 是库里查出来的当前用户。
     *
     * 注意本方法不会失效其他设备上的旧 token——JWT 无状态，7 天内仍然有效。
     * 彻底解决要给 users 加 tokenVersion 并让 requireAuth 比对，见 CLAUDE.md「尚未实现」。
     */
    async changePassword(
      user: PublicUser,
      currentPassword: string,
      newPassword: string,
    ): Promise<void> {
      const email = user.email;
      const now = Date.now();
      pruneExpired(now);

      // 与 login 共用同一个 failures：这个端点同样能无限触发 scrypt（每次 64MB），
      // 不限流的话并发一拉就是内存耗尽。共用的副作用是改密码连错 5 次也会锁住
      // 登录 15 分钟——有意的取舍，人已经在登录态里，锁住的只是重新登录
      if (isLockedOut(email, now)) {
        throw new AuthError(TOO_MANY_ATTEMPTS_MESSAGE, 429);
      }

      // 长度校验排在验旧密码之前：新密码不合规时不该先白跑一次 scrypt，
      // 也不该把这种输入错误计进失败次数
      if (newPassword.length < PASSWORD_MIN_LENGTH) {
        throw new AuthError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`, 400);
      }
      if (newPassword.length > PASSWORD_MAX_LENGTH) {
        throw new AuthError(`密码不能超过 ${PASSWORD_MAX_LENGTH} 位`, 400);
      }

      // findById 只返回 PublicUser，拿不到哈希，所以按 email 查
      const found = await userRepo.findByEmail(email);
      // requireAuth 刚确认过这个用户存在，查不到只能是并发删号
      if (!found) {
        throw new AuthError(CHANGE_PASSWORD_FAILED_MESSAGE, 401);
      }

      if (!(await verifyPassword(currentPassword, found.passwordHash))) {
        recordFailure(email, now);
        throw new AuthError(CHANGE_PASSWORD_FAILED_MESSAGE, 401);
      }

      failures.delete(email);
      await userRepo.setPasswordHash(found.id, await hashPassword(newPassword));
    },
```

其四，在文件末尾（`toPublic` 之后）加共享单例：

```ts
/**
 * 全应用共用一个实例。
 *
 * 失败计数存在实例内部（上面的 failures），两个路由各建一个实例就是两套计数器：
 * 改密码那边打满 5 次，登录这边毫无察觉——而它挡的正是「无限触发 scrypt
 * 导致内存耗尽」，绕过去就没有意义了。
 *
 * 惰性初始化保留「只导入 app 不连接数据库」的测试能力：getDb() 会建连接池，
 * 在模块顶层调用会让校验类用例也必须有一个真数据库。
 */
let instance: ReturnType<typeof createAuthService> | undefined;

export function getAuthService(): ReturnType<typeof createAuthService> {
  instance ??= createAuthService(getDb());
  return instance;
}
```

然后 `apps/server/src/http/routes/auth.ts` 删掉它自己那份单例——把这段整体删除：

```ts
let authService: ReturnType<typeof createAuthService> | undefined;

function getAuthService() {
  // 登录失败计数存在 service 实例内，整个应用必须复用同一个实例；
  // 惰性初始化保留「只导入 app 不连接数据库」的测试能力。
  authService ??= createAuthService(getDb());
  return authService;
}
```

并把 import 改成从 service 拿：

```ts
import { AuthError, getAuthService } from "../../services/auth.ts";
```

`createAuthService` 与 `getDb` 在 `routes/auth.ts` 里应该就没有其他用处了——若 Biome 报未使用的 import，把它们从该文件的 import 里去掉。`register` / `login` 两个 handler 里的 `getAuthService()` 调用**不用改**。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/services/auth.test.ts apps/server/src/http/routes/auth.test.ts`
Expected: PASS —— 新增 7 个用例全绿，`auth.test.ts` 原有用例（含登录限流那几条）不受单例搬家影响。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/auth.ts apps/server/src/services/auth.test.ts apps/server/src/http/routes/auth.ts
git commit -m "feat(api): 加改密码服务，auth service 单例移到 services 层共用"
```

---

## Task 7: `/api/account/preferences` 读写

**Files:**
- Create: `apps/server/src/http/routes/account.ts`
- Create: `apps/server/src/http/routes/account.test.ts`
- Modify: `apps/server/src/http/app.ts`
- Modify: `apps/server/src/http/routes/isolation.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/http/routes/account.test.ts`：

```ts
import { createTestDb, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app.ts";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({ db: undefined as TestDb | undefined }));

// 路由里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

// 建库慢，整个文件复用一个实例，用例之间靠清表隔离
beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});

beforeEach(() => reset());

// beforeAll 超时时 close 还没赋值，可选调用避免 afterAll 抛错盖住真正的超时报错
afterAll(() => close?.());

/** 注册一个用户并返回它的 cookie（同 admin.test.ts 的 registerUser） */
async function registerUser(email: string): Promise<string> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2" }),
  });
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

function getPreferences(cookie: string) {
  return app.request("/api/account/preferences", { headers: { Cookie: cookie } });
}

function putPreferences(body: unknown, cookie: string) {
  return app.request("/api/account/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

describe("GET /api/account/preferences", () => {
  it("未登录返回 401", async () => {
    expect((await app.request("/api/account/preferences")).status).toBe(401);
  });

  // 响应形状恒定：前端不必区分「没这行」与「两项都跟随默认」
  it("没改过设置的用户拿到两个 null，而不是 preferences: null", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await getPreferences(cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  it("同一个响应里带回可用模型清单", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await getPreferences(cookie);

    const body = (await response.json()) as {
      models: { id: string; name: string; isDefault: boolean }[];
    };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.filter((model) => model.isDefault)).toHaveLength(1);
  });
});

describe("PUT /api/account/preferences", () => {
  it("未登录返回 401", async () => {
    const response = await app.request("/api/account/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: null, systemPrompt: null }),
    });

    expect(response.status).toBe(401);
  });

  it("写入后能读回来", async () => {
    const cookie = await registerUser("a@x.io");
    const models = (await (await getPreferences(cookie)).json()) as { models: { id: string }[] };
    const modelId = models.models[0]!.id;

    const put = await putPreferences({ defaultModel: modelId, systemPrompt: "你是助手" }, cookie);

    expect(put.status).toBe(200);
    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: modelId, systemPrompt: "你是助手" });
  });

  // 不归一的话「清空 system prompt」会存一个 ""，然后被当作有效值发给模型，
  // agent 拿到的是空 prompt 而不是 DEFAULT_SYSTEM_PROMPT
  it("空字符串归一成 null", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: null, systemPrompt: "你是助手" }, cookie);

    await putPreferences({ defaultModel: "", systemPrompt: "   " }, cookie);

    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  // 全量语义：字段缺失就是 null，不是「这项别动」
  it("字段缺失等同于 null，会清掉已有的值", async () => {
    const cookie = await registerUser("a@x.io");
    await putPreferences({ defaultModel: null, systemPrompt: "你是助手" }, cookie);

    await putPreferences({}, cookie);

    const body = (await (await getPreferences(cookie)).json()) as { preferences: unknown };
    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });

  it("未注册的模型返回 400", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ defaultModel: "gpt-does-not-exist" }, cookie);

    expect(response.status).toBe(400);
  });

  it.each([
    { name: "body 是 null", body: null },
    { name: "defaultModel 是数字", body: { defaultModel: 1 } },
    { name: "systemPrompt 是数组", body: { systemPrompt: [] } },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const cookie = await registerUser("a@x.io");

    expect((await putPreferences(body, cookie)).status).toBe(400);
  });

  it("超长 systemPrompt 返回 400", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences({ systemPrompt: "很".repeat(4001) }, cookie);

    expect(response.status).toBe(400);
  });

  // NUL 过不了 Postgres 的 text 列，漏过去是 500（routes/sessions.ts 的 requireTitle 踩过）
  it("systemPrompt 里的 NUL 被清掉而不是 500", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await putPreferences(
      { systemPrompt: `你${String.fromCharCode(0)}是助手` },
      cookie,
    );

    expect(response.status).toBe(200);
    const body = (await (await getPreferences(cookie)).json()) as {
      preferences: { systemPrompt: string };
    };
    expect(body.preferences.systemPrompt).toBe("你是助手");
  });

  it("偏好按用户隔离", async () => {
    const alice = await registerUser("alice@x.io");
    const bob = await registerUser("bob@x.io");
    await putPreferences({ systemPrompt: "alice 的 prompt" }, alice);

    const body = (await (await getPreferences(bob)).json()) as { preferences: unknown };

    expect(body.preferences).toEqual({ defaultModel: null, systemPrompt: null });
  });
});
```

同时在 `apps/server/src/http/routes/isolation.test.ts` 的 `describe("路由保护范围", ...)` 里，紧跟「对话端点没有 cookie 返回 401」之后追加：

```ts
  it("账号偏好没有 cookie 返回 401", async () => {
    const response = await app.request("/api/account/preferences");

    expect(response.status).toBe(401);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/http/routes/account.test.ts`
Expected: FAIL —— 所有请求返回 404（`/api/account/*` 还没挂载），断言 401/200 的用例全红。

- [ ] **Step 3: 写路由**

创建 `apps/server/src/http/routes/account.ts`：

```ts
import { listModels } from "@petrel/agent";
import { createPreferencesRepository, getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";

/**
 * system prompt 的长度上限。
 *
 * 之所以要有上限：schema 里 system_prompt 是无长度限制的 text，一次请求就能塞进
 * 几十万字，之后每一轮对话都要整份发给模型。同 routes/sessions.ts 的 TITLE_LENGTH_LIMIT。
 */
const SYSTEM_PROMPT_LENGTH_LIMIT = 4000;

/**
 * 用 fromCharCode 而不是把 NUL 写成字面量：源码里放一个不可见的控制字符，
 * 编辑器和 diff 都看不出来（同 routes/sessions.ts）
 */
const NUL = String.fromCharCode(0);

/**
 * 全量写入语义下的字段解析：缺失、null、清完为空一律归一成 null（= 跟随系统默认）。
 *
 * 不归一空串的后果很具体：「清空 system prompt」会存一个 ""，然后被当作有效值
 * 传给 createAgent，agent 拿到的是一个空 prompt 而不是 DEFAULT_SYSTEM_PROMPT。
 *
 * NUL 要单独清掉：trim() 不管它，但 Postgres 的 text 存不了 NUL，漏过去是 500。
 */
function parseNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} 必须是字符串或 null` });
  }
  const cleaned = value.replaceAll(NUL, "").trim();
  return cleaned === "" ? null : cleaned;
}

export const account = new Hono<AppEnv>()
  /**
   * 模型清单语义上不属于「偏好」，合在这个响应里是因为消费者完全重合：
   * 设置面板要用它渲染下拉，ChatView 要用它显示当前模型名。少一个端点少一个往返。
   */
  .get("/preferences", async (c) => {
    const repo = createPreferencesRepository(getDb());
    const preferences = await repo.findByUserId(c.get("currentUser").id);
    return c.json({ preferences, models: listModels() });
  })

  .put("/preferences", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const fields = body as { defaultModel?: unknown; systemPrompt?: unknown } | null;

    const defaultModel = parseNullableString(fields?.defaultModel, "defaultModel");
    // 存一个未注册的 id 就是埋雷：设置面板显示「跟随默认」，但每条消息都在传它，
    // 而 /api/chat 对未注册的 model 返回 400——对话直接失败且看不出原因
    if (defaultModel !== null && !listModels().some((model) => model.id === defaultModel)) {
      throw new HTTPException(400, { message: `模型未注册：${defaultModel}` });
    }

    const systemPrompt = parseNullableString(fields?.systemPrompt, "systemPrompt");
    if (systemPrompt !== null && systemPrompt.length > SYSTEM_PROMPT_LENGTH_LIMIT) {
      throw new HTTPException(400, {
        message: `systemPrompt 不能超过 ${SYSTEM_PROMPT_LENGTH_LIMIT} 字`,
      });
    }

    const repo = createPreferencesRepository(getDb());
    const preferences = await repo.save(c.get("currentUser").id, { defaultModel, systemPrompt });
    return c.json({ preferences });
  });
```

- [ ] **Step 4: 挂载路由**

`apps/server/src/http/app.ts` 加 import：

```ts
import { account } from "./routes/account.ts";
```

并在 `requireAuth` **之下**、`requireAdmin` 之前挂载：

```ts
app.route("/api/chat", chat);
app.route("/api/sessions", sessions);
app.route("/api/account", account);
app.use("/api/admin/*", requireAdmin);
app.route("/api/admin", admin);
```

位置不能挪到 `app.use("/api/*", requireAuth)` 之上。`/api/account/password`（下一个任务）是个改凭据的端点，放在公开前缀里靠 handler 手写校验，哪天漏了就等于认证绕过。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/http/routes/account.test.ts apps/server/src/http/routes/isolation.test.ts`
Expected: PASS，`account.test.ts` 全绿，`isolation.test.ts` 新增那条也绿。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/http/routes/account.ts apps/server/src/http/routes/account.test.ts apps/server/src/http/app.ts apps/server/src/http/routes/isolation.test.ts
git commit -m "feat(api): 加 /api/account/preferences 读写"
```

---

## Task 8: `POST /api/account/password`

**Files:**
- Modify: `apps/server/src/http/routes/account.ts`
- Modify: `apps/server/src/http/routes/account.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `apps/server/src/http/routes/account.test.ts` 末尾追加。先补两个辅助函数（放在 `putPreferences` 之后）：

```ts
function changePassword(body: unknown, cookie: string) {
  return app.request("/api/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function login(email: string, password: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}
```

然后追加 describe 块：

```ts
describe("POST /api/account/password", () => {
  const OLD = "hunter2hunter2";
  const NEW = "correcthorsebattery";

  it("未登录返回 401", async () => {
    const response = await app.request("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: OLD, newPassword: NEW }),
    });

    expect(response.status).toBe(401);
  });

  it("改成功后新密码能登录、旧密码不能", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: NEW }, cookie);

    expect(response.status).toBe(200);
    expect((await login("a@x.io", NEW)).status).toBe(200);
    expect((await login("a@x.io", OLD)).status).toBe(401);
  });

  // 当前会话不该因为改了密码而掉线
  it("改成功后重新签发 cookie", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: NEW }, cookie);

    expect(response.headers.get("Set-Cookie")).toContain("petrel_token=");
  });

  // 前端靠这个状态码 + treatUnauthorizedAsRequestError 避免把用户踢下线
  it("旧密码不正确返回 401 且文案具体", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await changePassword({ currentPassword: "wrong-pw", newPassword: NEW }, cookie);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { message: "当前密码不正确" } });
  });

  it("新密码太短返回 400", async () => {
    const cookie = await registerUser("a@x.io");

    const response = await changePassword({ currentPassword: OLD, newPassword: "short" }, cookie);

    expect(response.status).toBe(400);
  });

  it("旧密码连错 5 次后返回 429", async () => {
    const cookie = await registerUser("a@x.io");
    for (let i = 0; i < 5; i += 1) {
      expect((await changePassword({ currentPassword: "wrong-pw", newPassword: NEW }, cookie)).status).toBe(401);
    }

    const response = await changePassword({ currentPassword: "wrong-pw", newPassword: NEW }, cookie);

    expect(response.status).toBe(429);
  });

  it.each([
    { name: "body 是 null", body: null },
    { name: "缺 newPassword", body: { currentPassword: OLD } },
    { name: "currentPassword 是数字", body: { currentPassword: 1, newPassword: NEW } },
  ])("$name 返回 400 而不是 500", async ({ body }) => {
    const cookie = await registerUser("a@x.io");

    expect((await changePassword(body, cookie)).status).toBe(400);
  });
});
```

> 注意：限流计数器是 service 实例内的 `Map`，`reset()` 只清数据库、不清它。上面「连错 5 次」那条用的邮箱与其他用例相同（`a@x.io`），而用例执行有先后——如果跑完这条之后别的用例也用 `a@x.io` 登录并因 429 意外失败，把这一条的邮箱换成独占的 `ratelimit-pw@x.io`，别去动 service 的实现。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/http/routes/account.test.ts -t "POST /api/account/password"`
Expected: FAIL —— 除「未登录返回 401」那条（`requireAuth` 已生效）之外全部 404。

- [ ] **Step 3: 写实现**

`apps/server/src/http/routes/account.ts` 加 import：

```ts
import { AuthError, getAuthService } from "../../services/auth.ts";
import { issueToken } from "../middleware/auth.ts";
```

并加一个错误翻译函数（放在 `parseNullableString` 之后）：

```ts
/** AuthError 带着状态码，翻译成 HTTPException 交给 error 中间件统一出格式（同 routes/auth.ts） */
function toHttpException(error: unknown): never {
  if (error instanceof AuthError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}
```

然后在 `.put("/preferences", ...)` 之后链上第三个 handler：

```ts
  .post("/password", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const fields = body as { currentPassword?: unknown; newPassword?: unknown } | null;

    if (typeof fields?.currentPassword !== "string" || typeof fields?.newPassword !== "string") {
      throw new HTTPException(400, { message: "currentPassword 与 newPassword 必须是字符串" });
    }

    const user = c.get("currentUser");
    await getAuthService()
      .changePassword(user, fields.currentPassword, fields.newPassword)
      .catch(toHttpException);

    // 重新签发：改完密码当前会话不该掉线。
    // 这不会失效其他设备上的旧 token——JWT 无状态，见 CLAUDE.md「尚未实现」
    await issueToken(c, user);

    return c.json({ ok: true });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/http/routes/account.test.ts`
Expected: PASS，偏好与改密码两组用例全绿。

- [ ] **Step 5: typecheck**

Run: `pnpm run typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/http/routes/account.ts apps/server/src/http/routes/account.test.ts
git commit -m "feat(api): 加 POST /api/account/password"
```

---

## Task 9: `/api/chat` 接受 `model`

**Files:**
- Modify: `apps/server/src/http/routes/chat.ts`
- Modify: `apps/server/src/http/routes/chat.test.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server/src/http/routes/chat.test.ts` 的 `vi.hoisted` 里加一个字段，用来观察传给 `createAgent` 的选项：

```ts
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  dbBroken: false,
  sessionRepoBroken: false,
  agentOptions: undefined as CreateAgentOptions | undefined,
  /** 记录路由实际传给 createAgent 的选项，用来断言 model 有没有透传 */
  seenAgentOptions: undefined as CreateAgentOptions | undefined,
}));
```

并在 `vi.mock("@petrel/agent", ...)` 的工厂里记一笔：

```ts
    createAgent: (options: CreateAgentOptions = {}) => {
      state.seenAgentOptions = options;
      return actual.createAgent({ ...options, ...state.agentOptions });
    },
```

在该文件的 `beforeEach` 里复位它（加到已有的 `beforeEach` 末尾）：

```ts
  state.seenAgentOptions = undefined;
```

然后在文件末尾追加：

```ts
describe("模型选择", () => {
  it("合法的 model 透传给 createAgent", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "deepseek-ai/DeepSeek-V3",
      }),
    });
    // SSE 响应读干净才意味着 handler 已经跑完
    await response.text();

    expect(response.status).toBe(200);
    expect(state.seenAgentOptions?.modelId).toBe("deepseek-ai/DeepSeek-V3");
  });

  // 静默回落最坏：用户在设置里选的模型被换掉，账单和输出都变了却没有任何信号
  it("未注册的 model 返回 400，且压根不进 agent", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        message: "你好",
        sessionId: SESSION_ID,
        model: "gpt-does-not-exist",
      }),
    });

    expect(response.status).toBe(400);
    expect(state.seenAgentOptions).toBeUndefined();
  });

  it("不传 model 时也不传 modelId，由 createAgent 用系统默认", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("好")])]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "你好", sessionId: SESSION_ID }),
    });
    await response.text();

    expect(state.seenAgentOptions?.modelId).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/http/routes/chat.test.ts -t "模型选择"`
Expected: FAIL —— 第一条 `state.seenAgentOptions?.modelId` 是 `undefined`（路由还不解析 `model`），第二条返回 200 而不是 400。

- [ ] **Step 3: 写实现**

`apps/server/src/http/routes/chat.ts` 的 import 加上 `listModels`：

```ts
import { type AgentMessage, createAgent, listModels } from "@petrel/agent";
```

`parseChatRequest` 里，在解析 `systemPrompt` 之后追加，并把返回值加上 `model`：

```ts
  // systemPrompt 可选，不是字符串就当没传，别让非法值混进 initialState 发给模型
  const rawSystemPrompt = fields?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === "string" ? rawSystemPrompt : undefined;

  // model 同样可选。但传了一个不认识的 id 时直接 400，不静默回落到默认模型——
  // 用户在设置里选的模型被悄悄换掉，账单和输出都变了却没有任何信号
  const rawModel = fields?.model;
  const model = typeof rawModel === "string" && rawModel !== "" ? rawModel : undefined;
  if (model !== undefined && !listModels().some((item) => item.id === model)) {
    throw new HTTPException(400, { message: `模型未注册：${model}` });
  }

  return { message, sessionId, systemPrompt, model };
```

同时把该函数顶部的类型断言补上 `model`：

```ts
  const fields = body as {
    message?: unknown;
    sessionId?: unknown;
    systemPrompt?: unknown;
    model?: unknown;
  } | null;
```

handler 里解构并透传：

```ts
  const { message, sessionId, systemPrompt, model } = parseChatRequest(body);
```

```ts
    const agent = createAgent({
      systemPrompt,
      // 前端从 stores/preferences 读出来的默认模型。校验已在 parseChatRequest 做过，
      // 到这里一定在注册表里
      modelId: model,
      // 复用同一个 id 传给 pi，供 provider 做缓存感知
      sessionId,
      // 历史回灌：本轮之前的消息原样进 transcript，模型才看得到上下文
      messages: prepared?.history,
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/server/src/http/routes/chat.test.ts`
Expected: PASS，新增 3 个用例 + 该文件原有用例全绿。

- [ ] **Step 5: 后端全量验证**

Run: `pnpm run typecheck && pnpm run lint && pnpm run test`
Expected: 三项都通过。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/http/routes/chat.ts apps/server/src/http/routes/chat.test.ts
git commit -m "feat(api): /api/chat 接受 model 参数并校验白名单"
```

---

## Task 10: `apis/account_api.js`

**Files:**
- Create: `apps/web/src/apis/account_api.js`
- Create: `apps/web/src/apis/account_api.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/apis/account_api.test.js`：

```js
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserStore } from '@/stores/user'
import { setUnauthorizedHandler } from './http.js'
import { changePassword, fetchPreferences, savePreferences } from './account_api.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  setUnauthorizedHandler(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchPreferences', () => {
  it('GET /api/account/preferences', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ preferences: {}, models: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPreferences()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/preferences')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })
})

describe('savePreferences', () => {
  it('PUT 全量两个字段，null 照原样发出去', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ preferences: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await savePreferences({ defaultModel: null, systemPrompt: '你是助手' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/preferences')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ defaultModel: null, systemPrompt: '你是助手' })
  })
})

describe('changePassword', () => {
  it('POST /api/account/password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await changePassword('old-password', 'new-password')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/account/password')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: 'old-password',
      newPassword: 'new-password'
    })
  })

  /**
   * 这条守的是一个具体的坑：旧密码后端返 401，若不带
   * treatUnauthorizedAsRequestError，http.js 的全局 401 分支会 logout() 并跳登录页
   * ——用户输错一次旧密码就被自己踢下线。
   */
  it('旧密码错误的 401 不会登出、不跳转、文案原样保留', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u-1', email: 'a@x.io', role: 'user' }
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: '当前密码不正确' } }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(changePassword('wrong-password', 'new-password')).rejects.toThrow('当前密码不正确')

    expect(userStore.isLoggedIn).toBe(true)
    expect(onUnauthorized).not.toHaveBeenCalled()
    // 只发了业务请求本身，没有顺带打一次 /api/auth/logout
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/apis/account_api.test.js`
Expected: FAIL —— 解析不到 `./account_api.js`。

- [ ] **Step 3: 写实现**

创建 `apps/web/src/apis/account_api.js`：

```js
/**
 * 当前账号相关的接口：偏好读写与改密码。
 *
 * 走 apis/http.js 而不是 v0.4 遗留的 base.js：token 在 httpOnly cookie 里，
 * 同源请求浏览器会自动带上。
 */
import { get, post, put } from '@/apis/http'

/** 响应是 { preferences: { defaultModel, systemPrompt }, models: [...] } */
export function fetchPreferences() {
  return get('/api/account/preferences')
}

/**
 * 全量写入：两个字段都要传，null 表示「跟随系统默认」。
 * 显式列出字段而不是直传对象，免得把 store 里的其他状态（models / loaded）也发上去。
 */
export function savePreferences({ defaultModel, systemPrompt }) {
  return put('/api/account/preferences', { defaultModel, systemPrompt })
}

/**
 * treatUnauthorizedAsRequestError：旧密码不正确时后端返 401，那是这次请求的业务结果，
 * 不是「登录失效」。不加这个标记会被 http.js 的全局 401 分支截胡——
 * 用户输错一次旧密码就被 logout() 并踢到登录页。同 auth_api.js 的登录/注册。
 */
export function changePassword(currentPassword, newPassword) {
  return post(
    '/api/account/password',
    { currentPassword, newPassword },
    { treatUnauthorizedAsRequestError: true }
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/src/apis/account_api.test.js`
Expected: PASS，5 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/apis/account_api.js apps/web/src/apis/account_api.test.js
git commit -m "feat(web): 加 account 接口封装"
```

---

## Task 11: `stores/preferences.js`

**Files:**
- Create: `apps/web/src/stores/preferences.js`
- Create: `apps/web/src/stores/preferences.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/stores/preferences.test.js`：

```js
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchPreferences, savePreferences } from '@/apis/account_api'
import { usePreferencesStore } from './preferences.js'

vi.mock('@/apis/account_api', () => ({
  fetchPreferences: vi.fn(),
  savePreferences: vi.fn()
}))

const FLASH = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  providerName: 'DeepSeek',
  isDefault: true
}
const V3 = {
  id: 'deepseek-ai/DeepSeek-V3',
  name: 'DeepSeek-V3 (SiliconFlow)',
  provider: 'siliconflow',
  providerName: 'SiliconFlow',
  isDefault: false
}
const MODELS = [FLASH, V3]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('ensureLoaded', () => {
  it('把偏好与模型清单写进 store', async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: '你是助手' },
      models: MODELS
    })
    const store = usePreferencesStore()

    await store.ensureLoaded()

    expect(store.defaultModel).toBe(V3.id)
    expect(store.systemPrompt).toBe('你是助手')
    expect(store.models).toEqual(MODELS)
    expect(store.loaded).toBe(true)
    expect(store.loadFailed).toBe(false)
  })

  // ChatView 与 SettingsModal 都会在挂载时调它，同时开就会打两次请求
  it('并发调用只发一次请求', async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS })
    const store = usePreferencesStore()

    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()])

    expect(fetchPreferences).toHaveBeenCalledTimes(1)
  })

  it('已加载过就不再请求', async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS })
    const store = usePreferencesStore()
    await store.ensureLoaded()

    await store.ensureLoaded()

    expect(fetchPreferences).toHaveBeenCalledTimes(1)
  })

  /**
   * 这条与下一条一起守住 spec §5.3(a)：加载失败必须与「偏好为空」区分开。
   * 混在一起的后果不是看着别扭——面板显示一张空表单，用户以为设置被清空了，
   * 点一次保存就真的把库里的值覆盖成 null。
   */
  it('加载失败时置 loadFailed 而不是 loaded，且不 reject', async () => {
    fetchPreferences.mockRejectedValue(new Error('网络错误'))
    const store = usePreferencesStore()

    await expect(store.ensureLoaded()).resolves.toBeUndefined()

    expect(store.loadFailed).toBe(true)
    expect(store.loaded).toBe(false)
  })

  it('加载失败后再调会重试', async () => {
    fetchPreferences
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce({ preferences: { defaultModel: V3.id }, models: MODELS })
    const store = usePreferencesStore()
    await store.ensureLoaded()

    await store.ensureLoaded()

    expect(fetchPreferences).toHaveBeenCalledTimes(2)
    expect(store.loadFailed).toBe(false)
    expect(store.defaultModel).toBe(V3.id)
  })

  /**
   * spec §5.3(c)：存着的 id 已经下架时不能原样留着。
   * 留着就是地雷——面板显示「跟随系统默认」，但每条消息都在传这个失效 id，
   * 而后端对未注册的 model 返回 400，对话直接失败且看不出原因。
   */
  it('存着的模型已不在清单里时当作跟随系统默认', async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: 'retired-model', systemPrompt: null },
      models: MODELS
    })
    const store = usePreferencesStore()

    await store.ensureLoaded()

    expect(store.defaultModel).toBe(null)
  })
})

describe('modelName', () => {
  it('选了模型就显示它的名字', async () => {
    fetchPreferences.mockResolvedValue({ preferences: { defaultModel: V3.id }, models: MODELS })
    const store = usePreferencesStore()
    await store.ensureLoaded()

    expect(store.modelName).toBe(V3.name)
  })

  // 没选时显示的必须是后端实际会用的那个，否则界面在说谎
  it('没选模型时显示 isDefault 那一项的名字', async () => {
    fetchPreferences.mockResolvedValue({ preferences: { defaultModel: null }, models: MODELS })
    const store = usePreferencesStore()
    await store.ensureLoaded()

    expect(store.modelName).toBe(FLASH.name)
  })

  it('清单还没拉到时是空字符串，不报错', () => {
    const store = usePreferencesStore()

    expect(store.modelName).toBe('')
  })
})

describe('save', () => {
  it('调接口并用响应里的值更新 store', async () => {
    fetchPreferences.mockResolvedValue({ preferences: {}, models: MODELS })
    savePreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: '新 prompt' }
    })
    const store = usePreferencesStore()
    await store.ensureLoaded()

    await store.save({ defaultModel: V3.id, systemPrompt: '新 prompt' })

    expect(savePreferences).toHaveBeenCalledWith({
      defaultModel: V3.id,
      systemPrompt: '新 prompt'
    })
    expect(store.defaultModel).toBe(V3.id)
    expect(store.systemPrompt).toBe('新 prompt')
  })

  // 失败要能抛到面板去显示，不能吞掉——吞掉的话用户以为保存成功了
  it('接口失败时抛出错误且不改动 store', async () => {
    fetchPreferences.mockResolvedValue({
      preferences: { defaultModel: V3.id, systemPrompt: '旧 prompt' },
      models: MODELS
    })
    savePreferences.mockRejectedValue(new Error('保存失败'))
    const store = usePreferencesStore()
    await store.ensureLoaded()

    await expect(store.save({ defaultModel: null, systemPrompt: null })).rejects.toThrow('保存失败')

    expect(store.defaultModel).toBe(V3.id)
    expect(store.systemPrompt).toBe('旧 prompt')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/web/src/stores/preferences.test.js`
Expected: FAIL —— 解析不到 `./preferences.js`。

- [ ] **Step 3: 写实现**

创建 `apps/web/src/stores/preferences.js`：

```js
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchPreferences, savePreferences } from '@/apis/account_api'

/**
 * 用户偏好与可用模型清单。
 *
 * 偏好只在这里持有一份，ChatView 发消息时读它、设置面板改它。
 * 主题不在这个 store 里——它不落库，留在 stores/theme.js + localStorage，
 * 因为主题必须在首帧之前生效，等一个网络往返会先闪一下白底。
 */
export const usePreferencesStore = defineStore('preferences', () => {
  /** null = 跟随系统默认（后端的 DEFAULT_MODEL_ID） */
  const defaultModel = ref(null)
  /** null = 跟随系统默认（后端的 DEFAULT_SYSTEM_PROMPT） */
  const systemPrompt = ref(null)
  const models = ref([])
  const loaded = ref(false)
  /**
   * 加载失败必须与「偏好为空」区分开。混在一起的话设置面板会显示一张空表单，
   * 用户以为设置被清空了、点一次保存，就真的把库里的值覆盖成 null 了。
   */
  const loadFailed = ref(false)

  /** 在飞的加载 promise，让并发的 ensureLoaded() 只发一次请求 */
  let inflight = null

  /** 界面上显示的模型名。没选时取后端实际会用的那个，否则界面在说谎 */
  const modelName = computed(() => {
    const selected = models.value.find((model) => model.id === defaultModel.value)
    if (selected) return selected.name
    return models.value.find((model) => model.isDefault)?.name ?? ''
  })

  function applyPreferences(preferences) {
    const saved = preferences?.defaultModel ?? null
    // 存着的 id 已经不在清单里就当作「跟随系统默认」。留着它是个地雷：
    // 面板显示未选择，但每条消息都在传这个失效 id，而后端对未注册的 model
    // 返回 400——对话直接失败，且用户在设置里看不出原因
    defaultModel.value = models.value.some((model) => model.id === saved) ? saved : null
    systemPrompt.value = preferences?.systemPrompt ?? null
  }

  async function load() {
    try {
      const data = await fetchPreferences()
      models.value = data.models ?? []
      applyPreferences(data.preferences)
      loaded.value = true
      loadFailed.value = false
    } catch {
      // 不往上抛：偏好拉不到不该阻断对话。ChatView 读到 null 就不传
      // model / systemPrompt，后端回落到系统默认值。
      // 只留下 loadFailed 让设置面板显示错误态
      loadFailed.value = true
    }
  }

  /**
   * 幂等加载。ChatView 与 SettingsModal 各自挂载时都会调，同时开就会打两次请求，
   * 所以用 inflight 去重。加载失败后 loaded 仍是 false，下次调用会重试。
   */
  function ensureLoaded() {
    if (loaded.value) return Promise.resolve()
    inflight ??= load().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** 全量保存。失败原样抛给调用方——吞掉的话用户会以为保存成功了 */
  async function save({ defaultModel: model, systemPrompt: prompt }) {
    const data = await savePreferences({ defaultModel: model, systemPrompt: prompt })
    applyPreferences(data.preferences)
    loaded.value = true
    loadFailed.value = false
  }

  return {
    defaultModel,
    systemPrompt,
    models,
    loaded,
    loadFailed,
    modelName,
    ensureLoaded,
    save
  }
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run apps/web/src/stores/preferences.test.js`
Expected: PASS，12 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/stores/preferences.js apps/web/src/stores/preferences.test.js
git commit -m "feat(web): 加偏好 store"
```

---

## Task 12: 设置模态框外壳

**Files:**
- Create: `apps/web/src/components/settings/SettingsModal.vue`

组件层没有测试基建（根 `vitest.config.ts` 没挂 `@vitejs/plugin-vue`，任何 `import` 了 `.vue` 的测试都跑不起来），所以 Task 12–16 的验证手段是 `pnpm run build` 加一次人工确认。不要为此在这一轮去挂插件——那是独立的基建任务。

- [ ] **Step 1: 写外壳**

创建 `apps/web/src/components/settings/SettingsModal.vue`：

```vue
<template>
  <a-modal
    v-model:open="visible"
    title="设置"
    :width="720"
    :footer="null"
    :body-style="{ padding: 0 }"
    :destroy-on-close="true"
  >
    <div class="settings">
      <nav class="tabs">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          type="button"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="panel">
        <GeneralPanel v-if="activeTab === 'general'" />
        <AccountPanel v-else />
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import AccountPanel from './AccountPanel.vue'
import GeneralPanel from './GeneralPanel.vue'
import { usePreferencesStore } from '@/stores/preferences'

const props = defineProps({
  open: { type: Boolean, default: false }
})

const emit = defineEmits(['update:open'])

const TABS = [
  { key: 'general', label: '通用' },
  { key: 'account', label: '账号' }
]

const preferences = usePreferencesStore()
const activeTab = ref('general')

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

// 打开时才拉：未登录的人压根开不到这里，而应用启动阶段拉一次会多一个必然 401 的请求。
// ensureLoaded 幂等，ChatView 已经拉过就不会重复发
watch(
  () => props.open,
  (open) => {
    if (open) void preferences.ensureLoaded()
  }
)
</script>

<style lang="less" scoped>
.settings {
  display: flex;
  min-height: 380px;
  max-height: 70vh;
}

.tabs {
  display: flex;
  flex: 0 0 132px;
  flex-direction: column;
  gap: 4px;
  padding: 16px 8px;
  border-right: 1px solid var(--border-subtle);
}

.tab {
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    background: var(--surface-hover);
  }

  &.active {
    background: var(--surface-hover);
    color: var(--text-strong);
  }
}

.panel {
  flex: 1 1 auto;
  // 没有 min-width: 0 的话 flex 子项不会收缩到内容宽度以下，长 prompt 会顶出横向滚动
  min-width: 0;
  padding: 16px 20px;
  overflow-y: auto;
}

// 窄屏转成上下布局：132px 的左栏在 480px 宽度下会把内容区挤到没法用
@media (max-width: 560px) {
  .settings {
    flex-direction: column;
    max-height: 80vh;
  }

  .tabs {
    flex: 0 0 auto;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
  }
}
</style>
```

这一步会因为 `GeneralPanel` / `AccountPanel` 还不存在而构建失败，下两个任务补上。**不要**为此先写空占位组件，直接连着做 Task 13、14 再构建。

- [ ] **Step 2: 暂不提交**

外壳单独存在时构建不过，与 Task 13、14 一起提交。

---

## Task 13: `GeneralPanel`

**Files:**
- Create: `apps/web/src/components/settings/GeneralPanel.vue`

- [ ] **Step 1: 写组件**

创建 `apps/web/src/components/settings/GeneralPanel.vue`：

```vue
<template>
  <!--
    加载失败时显示错误态而不是空表单。空表单会让用户以为设置被清空了，
    点一次保存就真的把库里的值覆盖成 null——所以保存按钮也一起禁掉
  -->
  <div v-if="preferences.loadFailed" class="failed">
    <p>设置读取失败。</p>
    <a-button size="small" @click="retry">重试</a-button>
  </div>

  <a-spin v-else-if="!preferences.loaded" />

  <div v-else class="general">
    <div class="field">
      <label class="label" for="settings-default-model">默认对话模型</label>
      <a-select
        id="settings-default-model"
        v-model:value="draftModel"
        class="control"
        placeholder="跟随系统默认"
      >
        <a-select-option :value="null">跟随系统默认（{{ systemDefaultName }}）</a-select-option>
        <a-select-option v-for="model in preferences.models" :key="model.id" :value="model.id">
          {{ model.name }}
        </a-select-option>
      </a-select>
    </div>

    <div class="field">
      <label class="label" for="settings-system-prompt">默认 system prompt</label>
      <a-textarea
        id="settings-system-prompt"
        v-model:value="draftPrompt"
        class="control"
        :rows="6"
        :maxlength="SYSTEM_PROMPT_LIMIT"
        show-count
        placeholder="留空则使用系统默认提示词"
      />
    </div>

    <div class="field row">
      <label class="label" for="settings-dark">深色主题</label>
      <!--
        主题不落库也没有「保存」按钮：它压根不走后端，切换的那一刻就已经是最终状态。
        落库的两项才需要显式提交
      -->
      <a-switch id="settings-dark" :checked="theme.isDark" @change="theme.setTheme($event)" />
    </div>

    <div class="actions">
      <a-button type="primary" :loading="saving" :disabled="!dirty" @click="onSave">保存</a-button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useThemeStore } from '@/stores/theme'

/** 与后端 routes/account.ts 的 SYSTEM_PROMPT_LENGTH_LIMIT 对齐 */
const SYSTEM_PROMPT_LIMIT = 4000

const preferences = usePreferencesStore()
const theme = useThemeStore()

/**
 * 表单绑草稿副本而不是直接绑 store：直接绑的话，用户改了一半关掉弹窗，
 * store 里已经是脏值，ChatView 下一条消息就会用上一个从未保存的设置。
 */
const draftModel = ref(null)
const draftPrompt = ref('')
const saving = ref(false)

const systemDefaultName = computed(
  () => preferences.models.find((model) => model.isDefault)?.name ?? '未知'
)

/** store 里空 prompt 是 null，表单里是 ''，比较前统一 */
const dirty = computed(
  () =>
    draftModel.value !== preferences.defaultModel ||
    draftPrompt.value.trim() !== (preferences.systemPrompt ?? '')
)

function syncDraft() {
  draftModel.value = preferences.defaultModel
  draftPrompt.value = preferences.systemPrompt ?? ''
}

// immediate：store 可能在本组件挂载之前就已经加载完（ChatView 先拉过），
// 那时不会再有变化事件，只靠 watch 会让表单一直是空的
watch(() => [preferences.loaded, preferences.defaultModel, preferences.systemPrompt], syncDraft, {
  immediate: true
})

function retry() {
  void preferences.ensureLoaded()
}

async function onSave() {
  saving.value = true
  try {
    // 空串归一成 null 交给后端也会做一次，这里做是为了让 dirty 的比较基准一致
    await preferences.save({
      defaultModel: draftModel.value,
      systemPrompt: draftPrompt.value.trim() || null
    })
    message.success('设置已保存')
  } catch (error) {
    // 必须出声：静默失败的话用户以为保存成功了，下次打开发现还是旧值
    message.error(error.message || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<style lang="less" scoped>
.failed {
  color: var(--text-muted);
  font-size: 14px;

  p {
    margin: 0 0 12px;
  }
}

.general {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;

  &.row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.label {
  color: var(--text-strong);
  font-size: 14px;
}

.control {
  width: 100%;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
```

- [ ] **Step 2: 暂不提交**

与 Task 12、14 一起提交。

---

## Task 14: `AccountPanel`

**Files:**
- Create: `apps/web/src/components/settings/AccountPanel.vue`

- [ ] **Step 1: 写组件**

创建 `apps/web/src/components/settings/AccountPanel.vue`：

```vue
<template>
  <div class="account">
    <div class="field">
      <span class="label">邮箱</span>
      <span class="value">{{ userStore.user?.email ?? '—' }}</span>
    </div>

    <a-divider />

    <h4 class="title">修改密码</h4>
    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical" @finish="onSubmit">
      <a-form-item label="当前密码" name="currentPassword">
        <a-input-password v-model:value="form.currentPassword" autocomplete="current-password" />
      </a-form-item>

      <a-form-item label="新密码" name="newPassword">
        <a-input-password v-model:value="form.newPassword" autocomplete="new-password" />
      </a-form-item>

      <a-form-item label="确认新密码" name="confirmPassword">
        <a-input-password v-model:value="form.confirmPassword" autocomplete="new-password" />
      </a-form-item>

      <a-button type="primary" html-type="submit" :loading="submitting">修改密码</a-button>
    </a-form>

    <!--
      写清这条局限：改完密码其他设备上的旧 token 在 7 天内仍然有效。
      JWT 无状态，彻底解决要 tokenVersion，见 CLAUDE.md「尚未实现」。
      不写的话用户会以为「改密码 = 把别人踢下线」
    -->
    <p class="note">修改密码后，其他设备上已登录的会话最长 7 天后才会失效。</p>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { changePassword } from '@/apis/account_api'
import { useUserStore } from '@/stores/user'

/** 与后端 services/auth.ts 的 PASSWORD_MIN_LENGTH 对齐 */
const PASSWORD_MIN_LENGTH = 8

const userStore = useUserStore()
const formRef = ref(null)
const submitting = ref(false)

const form = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const rules = {
  currentPassword: [{ required: true, message: '请输入当前密码' }],
  newPassword: [
    { required: true, message: '请输入新密码' },
    { min: PASSWORD_MIN_LENGTH, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码' },
    {
      validator: (_rule, value) =>
        value === form.newPassword ? Promise.resolve() : Promise.reject('两次输入的密码不一致')
    }
  ]
}

async function onSubmit() {
  submitting.value = true
  try {
    await changePassword(form.currentPassword, form.newPassword)
    message.success('密码已修改')
    formRef.value?.resetFields()
  } catch (error) {
    // 后端的文案更有用（「当前密码不正确」/「尝试次数过多」），原样显示。
    // 这里不会把人踢下线：account_api 的 changePassword 带了
    // treatUnauthorizedAsRequestError，401 不走 http.js 的全局登出分支
    message.error(error.message || '修改失败，请重试')
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="less" scoped>
.account {
  font-size: 14px;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.label {
  color: var(--text-strong);
}

.value {
  color: var(--text-muted);
}

.title {
  margin: 0 0 12px;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}

.note {
  margin: 16px 0 0;
  color: var(--text-faint);
  font-size: 12px;
}
</style>
```

- [ ] **Step 2: 构建确认三个组件能过**

Run: `pnpm run build`
Expected: 后端 `tsc` 与前端 `vite build` 都成功。构建这时还不会把新组件打进产物（没人 import `settings/SettingsModal.vue`），所以这一步主要确认没有语法错误与不存在的具名导入。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/settings
git commit -m "feat(web): 加设置模态框与通用/账号两个分区"
```

---

## Task 15: 接进 AppShell 与左栏

**Files:**
- Modify: `apps/web/src/layouts/AppShell.vue`
- Modify: `apps/web/src/components/shell/SessionSidebar.vue`

- [ ] **Step 1: 左栏加入口**

`apps/web/src/components/shell/SessionSidebar.vue` 三处改动。

其一，`.user` 块里、登录态那个 `template` 内追加按钮：

```vue
        <template v-if="userStore.isLoggedIn">
          <span class="avatar fallback">{{ initial }}</span>
          <span class="name">{{ userStore.displayName || '已登录' }}</span>
          <button class="icon-btn settings" type="button" title="设置" @click="emit('open-settings')">
            <Settings :size="16" />
          </button>
        </template>
```

未登录时不显示：偏好接口在 `requireAuth` 之下，未登录点开只会得到一片错误。

其二，import 与 emit 声明：

```ts
import {
  BarChart3,
  CircleCheck,
  LibraryBig,
  LogIn,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
  Users
} from 'lucide-vue-next'
```

```ts
const emit = defineEmits(['new-chat', 'select', 'open-settings'])
```

其三，样式。`.name` 现在要能被齿轮挤，`.settings` 靠右：

```less
.name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings {
  flex: 0 0 auto;
  margin-left: auto;
}
```

`.icon-btn` 的基础样式是全局的（`AppShell` 也在用），这里只补定位。`.session-item .icon-btn { opacity: 0 }` 那条是限定在 `.session-item` 内的，不会把齿轮藏掉。

- [ ] **Step 2: AppShell 挂模态框**

`apps/web/src/layouts/AppShell.vue` 三处改动。

其一，给 `SessionSidebar` 加监听：

```vue
      <SessionSidebar
        @new-chat="onNewChat"
        @select="onSelectSession"
        @open-settings="showSettings = true"
      />
```

其二，在 `.app-shell` 根元素内、`</div>` 之前挂模态框（放在最后，与右栏的 `template` 并列）：

```vue
    <SettingsModal v-model:open="showSettings" />
```

其三，script 里加 import 与状态：

```ts
import SettingsModal from '@/components/settings/SettingsModal.vue'
```

```ts
// 用 emit 而不是 provide/inject 传打开动作：SessionSidebar 已经有 @new-chat / @select
// 两个 emit，加这个与既有惯例一致，而且调用关系在模板里看得见
const showSettings = ref(false)
```

`ref` 已经在 `import { computed, ref } from 'vue'` 里，不用改。

- [ ] **Step 3: 构建**

Run: `pnpm run build`
Expected: 成功。

- [ ] **Step 4: 人工确认**

```bash
docker compose up -d
docker logs petrel-web-dev --tail 30
```

打开 `http://localhost:5173/agent`，登录后：
- 左栏底部用户名右侧有齿轮图标
- 点击弹出「设置」模态框，左侧有「通用」「账号」两个 tab，两边都有内容（**不是**空白）
- 「账号」里显示自己的邮箱
- 窄屏（浏览器拉到 500px 以下）时 tab 变成横排

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/layouts/AppShell.vue apps/web/src/components/shell/SessionSidebar.vue
git commit -m "feat(web): 左栏加设置入口，AppShell 挂载设置模态框"
```

---

## Task 16: 对话链路用上偏好

**Files:**
- Modify: `apps/web/src/apis/chat_api.js`
- Modify: `apps/web/src/composables/useAgentStream.js`
- Modify: `apps/web/src/views/ChatView.vue`

- [ ] **Step 1: `chat_api.js` 请求体加 `model`**

改 JSDoc 与 body 两处：

```js
/**
 * 发起一次对话并逐帧回调。
 *
 * model 与 systemPrompt 来自 stores/preferences，缺省时后端回落到系统默认值。
 * JSON.stringify 会丢掉值为 undefined 的键，所以不传等于没这个字段。
 *
 * @param {{ message: string, sessionId: string, systemPrompt?: string, model?: string, signal?: AbortSignal }} params
 * @param {(frame: { event: string, data: any }) => void} onFrame
 */
export async function streamChat({ message, sessionId, systemPrompt, model, signal }, onFrame) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, systemPrompt, model }),
    signal
  })
```

- [ ] **Step 2: `useAgentStream.js` 转发 `model`**

`send()` 里传给 `streamChat` 的对象加一行：

```js
      await streamChat(
        {
          message,
          sessionId: options.sessionId,
          systemPrompt: options.systemPrompt,
          model: options.model,
          signal: controller.value.signal
        },
```

- [ ] **Step 3: 跑现有前端测试确认没回归**

Run: `pnpm vitest run apps/web/src/apis/chat_api.test.js`
Expected: PASS —— `model` 为 `undefined` 时 `JSON.stringify` 会丢掉这个键，请求体与原来完全一致，所以断言请求体的用例不受影响。

- [ ] **Step 4: `ChatView.vue` 用上偏好**

其一，import 与 store：

```ts
import { usePreferencesStore } from '@/stores/preferences'
```

```ts
const preferences = usePreferencesStore()
```

其二，删掉写死的常量。把这两行整体删除：

```ts
/** packages/ai 目前只注册了这一个模型，所以这里是静态文字而不是下拉 */
const MODEL_NAME = 'DeepSeek-V3'
```

改成读 store（放在 `preferences` 之后）：

```ts
// 模型名以偏好为准：没选时 store 会取后端标了 isDefault 的那个，
// 不再是写死的字符串（写死的那份已经和 packages/ai 的默认模型对不上了）
const modelLabel = computed(() => preferences.modelName || '默认模型')
```

模板里对应改掉：

```vue
              <span class="model">{{ modelLabel }}</span>
```

顺手把样式里那句已经过期的注释改掉：

```less
// 显示当前生效的模型名，值来自 stores/preferences
.model {
```

其三，`onMounted` 里拉一次偏好：

```ts
onMounted(() => {
  // 幂等，SettingsModal 打开时也会调一次。拉不到不阻断对话：
  // model / systemPrompt 保持 null，后端回落到系统默认值
  void preferences.ensureLoaded()
  if (!sessionStore.currentId) sessionStore.startNew()
  else void loadSession(sessionStore.currentId)
})
```

其四，`submit()` 带上偏好：

```ts
  sendSeq += 1
  await send(text, {
    sessionId,
    // ?? undefined：store 里「跟随系统默认」是 null，而请求体里不该出现
    // model: null——后端的类型校验只认字符串或不传
    model: preferences.defaultModel ?? undefined,
    systemPrompt: preferences.systemPrompt ?? undefined
  })
```

`computed` 已经在 ChatView 的 vue import 里，不用改。

- [ ] **Step 5: 构建**

Run: `pnpm run build`
Expected: 成功。

- [ ] **Step 6: 端到端人工确认**

```bash
docker compose up -d
```

在 `http://localhost:5173/agent`：
1. 输入框右侧显示的模型名是 `DeepSeek V4 Flash`（不再是 `DeepSeek-V3`）。
2. 打开设置 → 通用 → 把默认模型改成 `DeepSeek-V3 (SiliconFlow)`，填一句好认的 system prompt（例如「每句话结尾都加一个🐦」），保存 → 提示「设置已保存」。
3. 输入框右侧的模型名变成 `DeepSeek-V3 (SiliconFlow)`。
4. 刷新页面 → 模型名与设置里的值都还在。
5. 发一条消息 → 回答带上那个 emoji，说明 system prompt 生效了。
6. 设置里把 system prompt 清空并保存 → 再发一条，emoji 消失。
7. 「账号」→ 用**错误**的当前密码提交 → 显示「当前密码不正确」，**仍处于登录态**（左栏用户名还在，没被跳到 `/login`）。
8. 用正确的当前密码改成新密码 → 提示「密码已修改」，当前会话不掉线；登出后用旧密码登不进、新密码能进。

> 第 2 步选 SiliconFlow 模型时若对话报错，检查 `.env` 里有没有 `SILICONFLOW_API_KEY`，并记得改完 `.env` 要 `docker compose up -d` 而不是 `restart`（环境变量不热重载）。测 system prompt 用默认模型也一样。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/apis/chat_api.js apps/web/src/composables/useAgentStream.js apps/web/src/views/ChatView.vue
git commit -m "feat(web): 对话使用偏好里的模型与 system prompt"
```

---

## Task 17: 删除旧的设置弹窗与孤儿布局

**Files:**
- Delete: `apps/web/src/components/SettingsModal.vue`
- Delete: `apps/web/src/components/BasicSettingsSection.vue`
- Delete: `apps/web/src/layouts/AppLayout.vue`

- [ ] **Step 1: 删除前确认没有引用者**

```bash
grep -rn "SettingsModal\|BasicSettingsSection\|AppLayout" apps/web/src \
  --include=*.vue --include=*.js \
  | grep -v "components/settings/"
```

Expected: 只应看到这三个文件互相引用（`AppLayout` → `SettingsModal` → `BasicSettingsSection`），以及 `components/UserInfoComponent.vue` 里的 `inject('settingsModal', {})`（那是字符串 key，不是 import，删完它会拿到默认值 `{}`，`:243` 有 `if (openSettingsModal)` 兜着，不会报错）。

**如果出现别的引用者，停下来先报告**，不要硬删。

- [ ] **Step 2: 删除**

```bash
git rm apps/web/src/components/SettingsModal.vue apps/web/src/components/BasicSettingsSection.vue apps/web/src/layouts/AppLayout.vue
```

只删这三个。`ModelProvidersComponent`（在 frontend-plan 的保留清单里，等将来的系统级模型配置 tab）、`DebugComponent`、`TaskCenterDrawer`、`stores/config.js` 都**不动**——它们会变成孤立或仍被 6 个 v0.4 文件引用，统一留给「删除死代码」那一轮。

- [ ] **Step 3: 构建确认没删断**

Run: `pnpm run build`
Expected: 成功。前端没有 typecheck，`vite build` 是唯一能拦住「导入不存在的模块」的关卡，所以这一步不能跳。

- [ ] **Step 4: 全量测试**

Run: `pnpm run test`
Expected: 全绿。

- [ ] **Step 5: 人工确认首页没炸**

打开 `http://localhost:5173/`（`HomeView`，里面挂着 `UserInfoComponent`）。预期：页面正常渲染，控制台没有新增报错；`UserInfoComponent` 里那个设置入口点了没反应——它本来就已经是坏的（`username` / `avatar` 恒 `undefined`）。

- [ ] **Step 6: 提交**

```bash
git commit -m "refactor(web): 删掉 v0.4 的设置弹窗与孤儿 AppLayout"
```

---

## Task 18: 文档更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/backend-plan.md`
- Modify: `docs/frontend-plan.md`

- [ ] **Step 1: `CLAUDE.md`**

其一，「架构」一节 `apps/server` 那段的路由清单加上 `account`：

```
  当前有 `system`（health）、`auth`（注册/登录/登出/me）、`chat`（SSE）、
  `sessions`（会话 CRUD）、`account`（用户偏好与改密码）与 `admin`（用户管理）。
```

其二，「认证」一节的「尚未实现」那段补一条：

```
登录失败限流（同一邮箱 5 次失败锁 15 分钟）是单实例内存的，进程重启即失效、多副本部署下无效。
改密码**不失效其他设备上的旧 token**：JWT 无状态、7 天有效，只重新签发当前会话的 cookie。
彻底解决要给 `users` 加 `tokenVersion` 并让 `requireAuth` 比对。改密码的旧密码校验与登录
共用同一个失败计数器，所以改密码连错 5 次也会连带锁住登录 15 分钟——有意的取舍。
```

其三，「架构」一节 `packages/database` 那段补一句表清单：

```
  `user_preferences` 一人一行（`user_id` 作主键），两列可空，`null` 表示跟随系统默认。
```

- [ ] **Step 2: `docs/backend-plan.md`**

在「公开部署前必须先做」那一节（含「配额与 token 计量」那条）补一条待办：

```
- **token 版本号**：改密码不会失效其他设备上的旧 token。给 `users` 加 `tokenVersion`，
  签发时写进 payload、`requireAuth` 比对，改密码时自增。同一个机制也能实现「登出所有设备」。
```

并在描述已有能力的位置补一段：

```
### 用户偏好与账号（2026-08-04 交付）

`user_preferences` 表一人一行（`user_id` 主键），`default_model` 与 `system_prompt`
两列可空，`null` 表示跟随系统默认。`/api/account` 挂在 `requireAuth` 之下：
`GET /preferences`（偏好 + 可用模型清单，合成一个响应因为消费者重合）·
`PUT /preferences`（全量语义，字段缺失与空串都归一成 `null`）· `POST /password`。

偏好由**前端读出后随 `/api/chat` 请求体上传**，后端只校验 `model` 在
`listModels()` 白名单里，不在则 400（不静默回落）。这样 chat 每轮不多一次查询，
也不用给已有的 `systemPrompt` 参数额外定优先级规则。

改密码没放进 `/api/auth`：那是公开前缀，改凭据的端点靠 handler 手写一次
`resolveUser` 校验，哪天漏了就等于认证绕过。
```

- [ ] **Step 3: `docs/frontend-plan.md`**

其一，「组件处置清单」表的「待删除」行删掉 `AppLayout（已无路由引用）`，并加一句说明：

```
`SettingsModal`（v0.4 版）· `BasicSettingsSection` · `AppLayout` 已于 2026-08-04 删除，
设置面板在 `components/settings/*` 重写。
```

其二，§2 那张「HEU-7 暴露的遗留组件损坏」表里，**删掉 `components/SettingsModal.vue` 那一整行**，并在表下的说明段把提到 `SettingsModal` 的话改成：

```
修不修取决于这些组件的去留（`SettingsModal` 已重写并删除旧版，内嵌的
`ModelProvidersComponent` 留着等将来的系统级模型配置 tab；`DebugComponent` 与
`AppLayout` 已随本轮一起删/待删），因此本轮不修剩下的两个。
```

其三，「待办 → 依赖后端」表里 `Agent 选择与配置表单 | HEU-12` 那行下加一行已交付：

```
| ~~个人偏好（默认模型 / system prompt）~~ | 设置面板与用户偏好 —— **已交付**（`/api/account/preferences`） |
```

其四，「近期（不依赖后端）」里「补组件层测试基建」那条补一句后果：

```
  本轮新增的 `components/settings/*` 三个组件因此零测试覆盖：tab 切换、表单校验、
  保存按钮的禁用态、加载失败时的错误态全靠人眼。
```

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/backend-plan.md docs/frontend-plan.md
git commit -m "docs: 记录设置面板与用户偏好，补 token 版本号待办"
```

---

## Task 19: 全量验证

**Files:** 无（只跑命令）

- [ ] **Step 1: 四道关卡**

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

Expected: 四项全部通过，无报错输出。任何一项红就停下来修，不要跳过。

- [ ] **Step 2: 逐条走验收标准**

在 `docker compose up -d` 起来的环境里，对着 spec §9 逐条确认：

1. 登录用户点左栏齿轮 → 弹出设置，「通用」「账号」两 tab 都有内容。
2. 选模型、填 system prompt、保存 → 刷新后设置仍在；新消息使用该模型与该 prompt。
3. 输入框旁的模型名与实际使用的模型一致（不是写死的 `DeepSeek-V3`）。
4. 切主题即时生效，刷新后保持。
5. 错误的旧密码 → 有提示且**仍处于登录态**；正确的旧密码 → 当前会话不掉线，旧密码无法再登录。
6. 四道关卡全绿（Step 1 已确认）。

- [ ] **Step 3: 确认工作区干净**

```bash
git status
```

Expected: `nothing to commit, working tree clean`。若有漏提交的文件，补一次提交。

# M1：记忆存储地基（设计）

日期：2026-08-09 · 状态：待实施 · 上级设计：[记忆系统总设计](./2026-08-09-user-memory-design.md)

把 `user_memories` 表、pgvector 扩展与 repository 立起来。**本切片不碰 embedding provider**——
测试喂手造向量就能把 pgvector 这一层完整验证掉，provider 选型不阻塞地基。

与 M0 无依赖关系，两者可并行。

## 1. 头号风险：加 vector migration 会炸掉 18 个既有测试文件

`packages/database/src/testing.ts:42` 的 `createTestDb()` 跑的是**全量 migration**，
而它被 **18 个测试文件**依赖（`apps/server` 12 个 + `packages` 6 个，见总设计 §1 事实 8）。

一旦 `packages/database/drizzle/` 里出现 `CREATE EXTENSION vector`，
PGlite 找不到该扩展 → `migrate()` 抛错 → **这 18 个文件全部崩溃**，而不只是新增的记忆测试。
`IF NOT EXISTS` 救不了：扩展在 PGlite 里根本不存在。

而且「PGlite 自带 pgvector」这条已经过期：

| pglite 版本 | `./vector` export |
| --- | --- |
| 0.2.x – 0.4.0 | 有 |
| 0.4.11 起 | **没有** |
| 0.5.4（仓库当前） | 没有，全包 `find -iname "*vector*"` 零命中 |

扩展被拆成了独立包 **`@electric-sql/pglite-pgvector@0.0.5`**，
其 `peerDependencies` 精确锁 `@electric-sql/pglite@0.5.4`——正是仓库装的版本。

**因此 M1 的实施顺序是硬性的**：先装扩展并**单独验证 18 个文件仍全绿**，
之后才允许任何 vector DDL 落地。计划里 Task 1 与 Task 2 之间不能合并提交。

## 2. Migration 策略

`drizzle-kit generate` 只从 schema 推 DDL，**不会**生成 `CREATE EXTENSION`。
手写 `.sql` 再改 `meta/_journal.json` 容易出错，所以走 drizzle 官方的自定义 migration：

```bash
pnpm --filter @petrel/database exec drizzle-kit generate --custom --name=enable_vector
```

它生成一个已正确登记进 journal 的空 `.sql`，填入 `CREATE EXTENSION IF NOT EXISTS vector;` 即可。
之后再改 schema 跑常规的 `db:generate` 生成建表 migration——**顺序必须是扩展在前、建表在后**，
否则 `vector(1024)` 这个类型在建表时还不存在。

CLAUDE.md 规定不要直接跑 `drizzle-kit migrate`，本切片也不需要：
应用启动时 `runMigrations()` 会跑，测试里 `createTestDb()` 会跑。

## 3. 表结构

```ts
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceSessionId: uuid("source_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_memories_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("user_memories_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);
```

取舍见总设计 §5。补充两点本切片特有的：

- **HNSW 索引在当前数据量下大概率用不上**。每用户上限 200 条，带 `WHERE user_id = ?`
  过滤时规划器多半选顺序扫描。仍然建它，是因为知识库（HEU-21）会复用同一套
  且届时数据量完全不同——现在建的成本近乎零，将来补要重新走 migration。
- **`vector_cosine_ops` 是安全默认**：无论 bge-m3 的输出是否已 L2 归一化，
  余弦距离都给出正确排序；内积只在已归一化时与它等价。

## 4. Repository 接口

```ts
// packages/database/src/repositories/memories.ts
export interface Memory {
  id: string;
  content: string;
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemorySearchHit extends Memory {
  /** 余弦相似度，1 = 完全一致，0 = 正交。由 1 - cosineDistance 算得 */
  similarity: number;
}

export function createMemoryRepository(db: Database): {
  insert(userId: string, values: { content: string; embedding: number[]; sourceSessionId: string | null }): Promise<Memory>;
  countByUserId(userId: string): Promise<number>;
  listByUserId(userId: string): Promise<Memory[]>;
  deleteById(userId: string, id: string): Promise<boolean>;
  searchByEmbedding(userId: string, embedding: number[], limit: number): Promise<MemorySearchHit[]>;
};
```

**所有方法首参都是 `userId`，没有任何不带 `userId` 的查询入口**——
让「忘记收窄」在类型层就写不出来，这是本轮用户隔离的主要手段。

`embedding` 不出现在任何返回类型里：它对调用方没有用（1024 个浮点数），
返回它只会把它塞进 HTTP 响应和日志。

`deleteById` 返回 `boolean` 而不是抛错：删不存在的记忆与删别人的记忆在
路由层是同一个响应（404），repo 只负责如实报告「有没有删到」。

## 5. 验收标准

1. 装完 `@electric-sql/pglite-pgvector` 后，**18 个既有测试文件全绿**（这一步单独验证、单独提交）。
2. `createTestDb()` 里能成功执行 `CREATE EXTENSION vector` 与建表 migration。
3. KNN 排序正确：查询向量与三条记忆的相似度分别为 1 / 0.6 / 0 时，返回顺序与之一致。
4. **跨用户查不到**：用户 B 的记忆不出现在用户 A 的 `searchByEmbedding` 与 `listByUserId` 结果里。
5. `deleteById` 删别人的记忆返回 `false` 且那条记忆仍在。
6. 删用户会级联删掉他的记忆；删会话**不会**删记忆（`source_session_id` 无外键）。
7. 全量测试通过：`pnpm vitest run --exclude '**/.claude/**'`。

## 6. 明确不做

| 不做 | 归属 |
| --- | --- |
| embedding 客户端、任何真实向量 | M2 |
| REST 路由与前端 | M2 |
| pi 工具 | M3 |
| 条数上限的执行（`MEMORY_MAX_PER_USER`） | M2 的 `write.ts` 编排层；repo 只提供 `countByUserId` |
| `updateById` / 自动去重 | 总设计已列为非目标 |
| 真实 Postgres 上的 HNSW 召回行为验证 | 留给 M2 的集成测试（`describe.skipIf(!DATABASE_URL)`），M1 只保证 SQL 正确 |

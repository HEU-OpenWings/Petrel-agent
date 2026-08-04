import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { sessionEntries } from "../schema.ts";
import type { Database } from "./sessions.ts";

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
        .where(and(eq(sessionEntries.sessionId, sessionId), gt(sessionEntries.entrySeq, afterSeq)))
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

import {
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
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
 * usage 是否带齐参与统计所需的数值字段。
 *
 * 与 pi 参考实现（`memory-storage.js` / `jsonl-storage.js` 的 `getSessionStats`）同构的校验：
 * 缺任何一个字段就整条跳过，而不是当 0 处理——避免把「没有 usage」和「usage 全 0」混为一谈。
 */
function hasCountableUsage(usage: unknown): usage is Usage {
  const u = usage as Partial<Usage> | undefined;
  return (
    !!u &&
    typeof u.input === "number" &&
    typeof u.output === "number" &&
    typeof u.cacheRead === "number" &&
    typeof u.cacheWrite === "number" &&
    typeof u.cost?.total === "number"
  );
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

  /**
   * 当前叶子 = 最后写入的一条条目：如果那条是 `leaf` 类型，叶子是它的 targetId；
   * 否则叶子就是它自己的 id。这与 pi 自带的 jsonl/内存实现同构——两者的
   * appendEntry 都在写入后重算 currentLeafId，而不是只认显式的 `leaf` 条目
   * （pi 的 Session.appendMessage 等方法从不调用 setLeafId，叶子前移完全依赖
   * appendEntry 的副作用）。
   */
  async getLeafId(): Promise<string | null> {
    const latest = await this.entries.latestEntry(this.sessionId);
    if (!latest) return null;
    if (latest.type === "leaf") {
      return (latest.payload as { targetId: string | null }).targetId;
    }
    return latest.id;
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
    const latest = labels.filter((row) => (row.payload as { targetId?: string }).targetId === id).at(-1);
    return latest ? (latest.payload as { label?: string }).label : undefined;
  }

  async getSessionName(): Promise<string | undefined> {
    const infos = await this.entries.byType(this.sessionId, "session_info");
    return (infos.at(-1)?.payload as { name?: string } | undefined)?.name;
  }

  /**
   * 与 pi 参考实现的 `getSessionStats` 同构：只有 assistant 消息、compaction、
   * branch_summary 这三类条目带 usage；`totalTokens` 是 input+output+cacheRead+cacheWrite
   * 四个分量相加算出来的，不是读 usage 自带的 `totalTokens` 字段
   * （已核对 `memory-storage.js`/`jsonl-storage.js` 的 `getSessionStats`，两者算法一致）。
   */
  async getSessionStats(): Promise<SessionStats> {
    const [messages, compactions, branchSummaries] = await Promise.all([
      this.entries.byType(this.sessionId, "message"),
      this.entries.byType(this.sessionId, "compaction"),
      this.entries.byType(this.sessionId, "branch_summary"),
    ]);
    const stats: SessionStats = {
      messageCount: messages.length,
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    };
    const usages: unknown[] = [
      ...messages.map((row) => {
        const message = (row.payload as { message?: { role?: string; usage?: unknown } }).message;
        return message?.role === "assistant" ? message.usage : undefined;
      }),
      ...compactions.map((row) => (row.payload as { usage?: unknown }).usage),
      ...branchSummaries.map((row) => (row.payload as { usage?: unknown }).usage),
    ];
    for (const usage of usages) {
      if (!hasCountableUsage(usage)) continue;
      stats.cachedTokens += usage.cacheRead;
      stats.uncachedTokens += usage.input + usage.cacheWrite;
      stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      stats.costTotal += usage.cost.total;
    }
    return stats;
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    const rows = await this.entries.pathToRootOrCompaction(this.sessionId, leafId);
    return rows.map(fromStored);
  }

  async getEntries(options?: { afterEntrySeq?: number; limit?: number }): Promise<SessionTreeEntry[]> {
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

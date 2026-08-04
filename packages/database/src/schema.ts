import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** 用户表。email 是登录标识，展示名由前端取邮箱前缀，不落库 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // 用 text 而不是 pg enum：enum 加值要 migration，应用层收窄更灵活
  role: text("role").notNull().default("user"),
  disabled: boolean("disabled").notNull().default(false),
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

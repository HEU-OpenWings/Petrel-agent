import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * 用户表。
 *
 * username 列是认证落地前的遗留，展示名现在由前端取邮箱前缀，
 * 这一列在 Task 16 连同默认用户一起删除。
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
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

/** 认证落地前，所有会话的归属用户 */
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_USERNAME = "default";

/** 默认用户的占位邮箱与密码哈希。哈希格式不合法，scrypt 校验必然失败——这个账号登不进来 */
export const DEFAULT_USER_EMAIL = "default@localhost";
export const UNUSABLE_PASSWORD_HASH = "!";

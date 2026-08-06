import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
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
  // 邮箱验证与密码重置：只存 token 的 sha256 哈希，明文只出现在邮件链接里；
  // 验证 token 24h、重置 token 30min，各自单槽（再次申请覆盖旧的）
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  emailVerifyTokenHash: text("email_verify_token_hash"),
  emailVerifyTokenExpiresAt: timestamp("email_verify_token_expires_at", { withTimezone: true }),
  passwordResetTokenHash: text("password_reset_token_hash"),
  passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at", { withTimezone: true }),
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

/**
 * token 用量事实表（HEU-40）。append-only，一条 usage-bearing 的会话树条目对应一行。
 *
 * 幂等键是 `entry_id`（pi 的 createEntryId()，uuidv7）——pi 的会话树条目 id 天然唯一，
 * 同一条 entry 无论被结算多少次（重试、并发、重复执行），ON CONFLICT (entry_id) DO NOTHING
 * 都保证只计一次。这是「事务双写」方案取代「getSessionStats 快照差」的根本原因：快照差
 * 在并发/followUp 下有竞态，且进程在 post-run 投影前退出会留下永久缺口。
 *
 * **`session_id` 故意不做指向 session_entries 的级联外键**：删会话不应让用量事实消失，
 * 否则用户删掉超额的会话即可恢复额度，直接绕过配额。session_id 在这里只是「来源维度」，
 * 供审计/按会话统计用。只有 `user_id` 级联——删用户才清空其用量。
 *
 * 与 HEU-28（Dashboard 聚合）共用同一张表：时序统计直接读这里的 recorded_at，
 * 避免将来回头改数据模型。
 */
export const tokenUsage = pgTable(
  "token_usage",
  {
    // pi uuidv7，与 session_entries.id 一致；幂等键
    entryId: uuid("entry_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 来源会话，只读不做级联外键（见上方说明）
    sessionId: uuid("session_id").notNull(),
    // usage-bearing 条目类型：message / compaction / branch_summary
    sourceType: text("source_type").notNull(),
    // 从 AssistantMessage 透传，可空（compaction/branch_summary 可能不带）
    model: text("model"),
    provider: text("provider"),
    api: text("api"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
    // 四分量之和，DB 级 CHECK 钉死（见下方约束），不读 pi 的 usage.totalTokens——
    // 某些 provider 可能不填它，读它会静默归零（issue 警告的坑）
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    // numeric 而非 double：Dashboard 聚合 SUM 时避免浮点漂移
    costTotal: numeric("cost_total", { precision: 20, scale: 12 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 配额热查询：WHERE user_id=? AND recorded_at >= now()-interval
    index("token_usage_user_recorded_idx").on(table.userId, table.recordedAt),
    // HEU-28 全局时序统计
    index("token_usage_recorded_idx").on(table.recordedAt),
    // 审计 / 按会话统计
    index("token_usage_session_recorded_idx").on(table.sessionId, table.recordedAt),
    // DB 级钉死 total = 四分量之和，防御 pi 升级后字段名漂移导致的全零污染
    check(
      "token_usage_total_check",
      sql`${table.totalTokens} = ${table.inputTokens} + ${table.outputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens}`,
    ),
  ],
);

/**
 * 用户级配额覆盖。无行 = 跟随系统默认（env QUOTA_TOKEN_LIMIT）；有行 = 覆盖。
 *
 * **不维护 period_start / used_tokens 状态**：滚动窗口的已用量每次由 SUM(token_usage)
 * 实时算，不缓存成可变计数——缓存计数在窗口翻转、重试、修复时都会漂移。这里只存「上限」
 * 这个几乎不变的配置。
 *
 * token_limit 允许 0：表示禁止该用户调用模型（但仍计量已有的）。null 表示跟随默认。
 */
export const userQuotaLimits = pgTable("user_quota_limits", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenLimit: bigint("token_limit", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

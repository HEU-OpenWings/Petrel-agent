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

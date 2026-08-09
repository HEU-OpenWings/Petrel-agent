import { and, eq, sql } from "drizzle-orm";
import { userPreferences } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface UserPreferences {
  /** null = 跟随 packages/agent 的 DEFAULT_MODEL_ID */
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
     *
     * 这里没有 setWhere，冲突目标是主键 userId 本身，所以 INSERT/UPDATE 分支必然
     * 有一个成立，落库的内容恒等于 values——不用 returning() 回查，失败直接抛异常。
     */
    async save(userId: string, values: UserPreferences): Promise<UserPreferences> {
      await db
        .insert(userPreferences)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { ...values, updatedAt: NOW },
        });

      return values;
    },

    /**
     * 仅当默认模型仍是调用方刚读取到的 expectedModel 时清回系统默认。
     *
     * 删除 provider 凭据时，另一个标签页可能同时保存了新的默认模型。若先读后无条件 save，
     * 删除请求会把那个新值覆盖为 null；把旧值放进 WHERE 后，竞态时更新 0 行并返回 false，
     * 调用方即可知道「状态已变化，不能替用户清空」。systemPrompt 始终不受影响。
     */
    async clearDefaultModelIfMatches(userId: string, expectedModel: string): Promise<boolean> {
      const updated = await db
        .update(userPreferences)
        .set({ defaultModel: null, updatedAt: NOW })
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.defaultModel, expectedModel)))
        .returning();
      return updated.length > 0;
    },
  };
}

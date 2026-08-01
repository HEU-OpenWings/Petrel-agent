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

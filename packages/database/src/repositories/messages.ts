import { asc, eq, sql } from "drizzle-orm";
import { messages, sessions } from "../schema.ts";
import type { Database } from "./sessions.ts";

export interface StoredMessage {
  seq: number;
  role: string;
  message: unknown;
  interrupted: boolean;
}

export function createMessageRepository(db: Database) {
  return {
    /**
     * 追加一条消息，seq 由数据库分配——调用方不传，也算不对。
     *
     * 同一个会话会被并发写：多标签页是一种，更常见的是「中断后立即重发」，
     * 上一轮 agent_end 的落库发生在 HTTP 响应关闭之后，下一个请求此刻读到的
     * 最大序号已经过期。撞上 messages_session_seq_unique 之后这条消息就没了，
     * 而调用方持有的计数器不会前进，本轮后面每条都撞同一个号——丢的是整轮。
     *
     * 那条 FOR UPDATE 不能省，也不能和 INSERT 合成一条语句：READ COMMITTED 下
     * 每条语句各取一次快照，先锁住会话行、再让下一条语句重新取快照算 MAX(seq)，
     * 才看得到并发事务刚提交的消息。写成单条 INSERT ... SELECT COALESCE(MAX(seq),0)+1
     * 时两个事务仍会算出同一个 seq。锁的是会话行，所以只有同一会话的写入被串行化。
     *
     * 会话不存在时锁不到任何行，随后的 INSERT 照旧撞外键约束报错，行为不变。
     *
     * 不变式（不死锁的结构性理由，改数据层时请守住）：**所有写路径都先锁会话行，
     * 且只拿这一把锁**。append 是 FOR UPDATE(sessions) → INSERT(messages)，
     * INSERT 的外键检查要的 KEY SHARE 已被同事务更强的锁覆盖；
     * touch / rename / upsert 都是单语句只碰 sessions；remove 先锁 sessions 再级联删 messages。
     * 于是全局锁序一致。不要引入「先碰 messages 再碰 sessions」的事务，那会造出环。
     */
    async append(input: {
      sessionId: string;
      role: string;
      message: unknown;
      interrupted?: boolean;
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select id from ${sessions} where id = ${input.sessionId} for update`);
        await tx.insert(messages).values({
          sessionId: input.sessionId,
          seq: sql`(select coalesce(max(${messages.seq}), 0) + 1 from ${messages} where ${messages.sessionId} = ${input.sessionId})`,
          role: input.role,
          message: input.message,
          interrupted: input.interrupted ?? false,
        });
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
  };
}

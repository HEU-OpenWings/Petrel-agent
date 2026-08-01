import type { Agent } from "@petrel/agent-core";
import {
  createMessageRepository,
  createSessionRepository,
  type Database,
  DEFAULT_USER_ID,
} from "@petrel/database";
import { logger } from "@petrel/logger";

const TITLE_MAX_LENGTH = 30;
const FALLBACK_TITLE = "新对话";

export function createSessionService(db: Database) {
  const sessionRepo = createSessionRepository(db);
  const messageRepo = createMessageRepository(db);

  /**
   * 标题取首条用户消息的前 30 字。
   * 不调模型生成：那要多一次 API 调用和成本，而当前只注册了一个模型。
   * 用户可以随时重命名。
   */
  function buildTitle(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return FALLBACK_TITLE;
    if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
  }

  return {
    buildTitle,

    async ensureSession(sessionId: string, firstMessage: string): Promise<void> {
      await sessionRepo.upsert({
        id: sessionId,
        userId: DEFAULT_USER_ID,
        title: buildTitle(firstMessage),
      });
    },

    async loadHistory(sessionId: string) {
      const stored = await messageRepo.listBySession(sessionId);
      return {
        messages: stored.map((row) => row.message),
        interruptedSeqs: stored.filter((row) => row.interrupted).map((row) => row.seq),
        nextSeq: (stored.at(-1)?.seq ?? 0) + 1,
      };
    },

    async appendMessage(
      sessionId: string,
      seq: number,
      message: unknown,
      interrupted = false,
    ): Promise<void> {
      // role 冗余存一列，让「找首条 user 消息」这类查询不必写 JSONB 表达式
      const role = (message as { role?: string }).role ?? "unknown";
      await messageRepo.append({ sessionId, seq, role, message, interrupted });
    },

    async list() {
      return sessionRepo.listByUser(DEFAULT_USER_ID);
    },

    async rename(sessionId: string, title: string): Promise<boolean> {
      return sessionRepo.rename(sessionId, title);
    },

    async remove(sessionId: string): Promise<boolean> {
      return sessionRepo.remove(sessionId);
    },

    async touch(sessionId: string): Promise<void> {
      await sessionRepo.touch(sessionId);
    },
  };
}

type SessionService = ReturnType<typeof createSessionService>;

/**
 * 订阅 agent 事件并落库。
 *
 * 按 message_end 增量写而不在 agent_end 一次性写：agent_end 带的是整个 transcript，
 * 包含恢复时回灌的历史，一次性写会重复；增量写还有个好处是中断时已完成的消息
 * 本来就已落库，不需要特殊处理。
 *
 * 中断的半截消息（streamingMessage）的处理：
 * - 实测 pi 0.83 里 agent_end 触发 listener 前 state.streamingMessage 已被清为 undefined，
 *   所以不在 agent_end 里读它，而是由订阅闭包维护 partial，在 message_start /
 *   message_update 时持续更新（单块响应可能只有 message_start 没有 update，两者都要记）；
 * - 中断时 message_end 发出的是一条空内容、stopReason: "aborted" 的助手消息，
 *   直接落库会写进一条空消息，所以 message_end 里跳过 aborted 的消息，
 *   把它留给 agent_end 用 partial 落库。
 * - 正常完成的一轮，message_end 已把全部消息落库，agent_end 时只有 interrupted 才写 partial。
 *
 * @param startSeq 本次运行的第一个序号，由调用方从已有历史算出
 * @returns 取消订阅函数
 */
export function attachPersistence(
  service: SessionService,
  agent: Agent,
  sessionId: string,
  startSeq: number,
): () => void {
  let seq = startSeq;
  let partial: unknown;

  return agent.subscribe(async (event) => {
    // listener 的 promise 会被 agent await 并计入 run 的 settlement，
    // 异常泄漏出去会影响 agent 本身运行，所以这里必须全部吞掉
    try {
      if (event.type === "message_start" || event.type === "message_update") {
        // 流式过程中的半截消息：中断时它不在 state.messages 里，只能从这里取
        partial = event.message;
        return;
      }

      if (event.type === "message_end") {
        // 中断时 message_end 发出的是空内容的 aborted 消息，跳过它，
        // 半截内容由 agent_end 用 partial 落库
        const ended = event.message as { stopReason?: string } | undefined;
        if (ended?.stopReason === "aborted") return;
        await service.appendMessage(sessionId, seq, event.message);
        seq += 1;
        return;
      }

      if (event.type === "agent_end") {
        // agent_end 触发前 state 已更新完毕，且 listener 里访问 state 是安全的
        // （processEvents 先更新 state 再调 listener）
        const last = agent.state.messages.at(-1) as { stopReason?: string } | undefined;
        const interrupted = agent.state.errorMessage !== undefined || last?.stopReason === "aborted";
        // 只有本轮确实中断了才补写半截消息；正常完成时 message_end 已写全，不能重复
        if (interrupted && partial !== undefined) {
          await service.appendMessage(sessionId, seq, partial, true);
          seq += 1;
        }
        await service.touch(sessionId);
      }
    } catch (error) {
      // 对话本身不该因为存不进数据库而崩掉
      logger.error({ err: error, sessionId }, "failed to persist agent message");
    }
  });
}

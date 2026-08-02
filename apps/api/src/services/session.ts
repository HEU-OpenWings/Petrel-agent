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
      };
    },

    /** seq 不在这一层出现：由数据库在插入时分配，见 messageRepo.append 的说明 */
    async appendMessage(sessionId: string, message: unknown, interrupted = false): Promise<void> {
      // role 冗余存一列，让「找首条 user 消息」这类查询不必写 JSONB 表达式
      const role = (message as { role?: string }).role ?? "unknown";
      await messageRepo.append({ sessionId, role, message, interrupted });
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
 * drizzle 把驱动抛的错误包一层，原始错误在 cause 上；node-postgres 与 PGlite
 * 的 cause 都是 pg 风格的对象，唯一约束冲突是 SQLSTATE 23505。
 */
function isUniqueViolation(error: unknown): boolean {
  return (error as { cause?: { code?: string } } | null)?.cause?.code === "23505";
}

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
 * - 中断时 message_end 还会补发一条 stopReason: "aborted" 的助手消息，内容是中断
 *   瞬间已出的那部分（与 partial 相同，不一定为空）。它和 agent_end 要写的 partial
 *   是同一条消息的两个副本，所以 message_end 里跳过 aborted 的消息，
 *   统一留给 agent_end 用 partial 落库，避免写进两条重复的助手消息。
 * - 正常完成的一轮，message_end 已把全部消息落库，agent_end 时只有 interrupted 才写 partial。
 *
 * 这里不持有序号：seq 由数据库在每次插入时分配。曾经的 startSeq 参数要求调用方
 * 在请求开始时从历史算出下一个序号，那个值在并发写同一会话时（多标签页、
 * 中断后立即重发）到写入时已经过期，见 messageRepo.append 的说明。
 *
 * @returns 取消订阅函数
 */
export function attachPersistence(service: SessionService, agent: Agent, sessionId: string): () => void {
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
        // 中断时这条 aborted 消息与 agent_end 要写的 partial 是同一条，跳过它，
        // 半截内容统一由 agent_end 用 partial 落库
        const ended = event.message as { stopReason?: string } | undefined;
        if (ended?.stopReason === "aborted") return;
        await service.appendMessage(sessionId, event.message);
        return;
      }

      if (event.type === "agent_end") {
        // agent_end 触发前 state 已更新完毕，且 listener 里访问 state 是安全的
        // （processEvents 先更新 state 再调 listener）
        const last = agent.state.messages.at(-1) as { stopReason?: string } | undefined;
        const interrupted = agent.state.errorMessage !== undefined || last?.stopReason === "aborted";
        // 只有本轮确实中断了才补写半截消息；正常完成时 message_end 已写全，不能重复
        if (interrupted && partial !== undefined) {
          await service.appendMessage(sessionId, partial, true);
        }
        await service.touch(sessionId);
      }
    } catch (error) {
      // 对话本身不该因为存不进数据库而崩掉
      if (isUniqueViolation(error)) {
        // 序号撞车意味着这条消息永久丢了，但服务看上去完全健康——
        // 跟「数据库整体挂掉」是两种处置，日志必须分得开，否则线上没人会发现
        logger.error({ err: error, sessionId }, "message seq collision, message dropped");
      } else {
        logger.error({ err: error, sessionId }, "failed to persist agent message");
      }
    }
  });
}

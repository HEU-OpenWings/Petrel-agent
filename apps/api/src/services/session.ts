import type { Agent } from "@petrel/agent-core";
import { createMessageRepository, createSessionRepository, type Database } from "@petrel/database";
import { logger } from "@petrel/logger";
import { isUniqueViolation } from "./db-errors.ts";

const TITLE_MAX_LENGTH = 30;
const FALLBACK_TITLE = "新对话";

/**
 * 会话 service。
 *
 * userId 由工厂参数传入而不是每个方法都带一个：调用点在 route 层，
 * 那里刚从 context 拿到当前用户，一次绑定比每个调用点各传一次更难写错。
 */
export function createSessionService(db: Database, userId: string) {
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

    /** @returns false 表示这个 id 已被别人占用，调用方应当拒绝本次请求 */
    async ensureSession(sessionId: string, firstMessage: string): Promise<boolean> {
      return sessionRepo.upsert({
        id: sessionId,
        userId,
        title: buildTitle(firstMessage),
      });
    },

    async loadHistory(sessionId: string) {
      // 先确认归属：listBySession 只按 sessionId 查，这条路上没有 userId。
      // 不属于自己时按会话不存在处理，与「新会话后端还没有这一行」的行为一致
      if (!(await sessionRepo.findById(sessionId, userId))) {
        return { messages: [], interruptedSeqs: [] };
      }
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
      return sessionRepo.listByUser(userId);
    },

    async rename(sessionId: string, title: string): Promise<boolean> {
      return sessionRepo.rename(sessionId, userId, title);
    },

    async remove(sessionId: string): Promise<boolean> {
      return sessionRepo.remove(sessionId, userId);
    },

    async touch(sessionId: string): Promise<void> {
      await sessionRepo.touch(sessionId, userId);
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
 * - 中断时 message_end 还会补发一条 stopReason: "aborted" 的助手消息，内容是中断
 *   瞬间已出的那部分（与 partial 相同，不一定为空）。它和 agent_end 要写的 partial
 *   是同一条消息的两个副本，所以 message_end 里跳过 aborted 的消息，
 *   统一留给 agent_end 用 partial 落库，避免写进两条重复的助手消息。
 * - 反过来，只要一条消息走到了 message_end 并落库，partial 里那份就是它的旧副本，
 *   要立刻清掉。于是 agent_end 时「partial 还在」就等价于「本轮被打断」，
 *   不需要再去查 state 的 stopReason 或 errorMessage。
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
        // 先作废 partial 再写：这条消息已经走到 message_end，partial 里那份就是它的
        // 旧副本，留着会被 agent_end 当成「没写完的半截」再补一条内容完全相同的。
        // 模型报错时踩的就是这里——pi 不抛异常，而是发一条 stopReason "error" 的
        // 助手消息走 message_end（见 CLAUDE.md 硬约束 3）。
        // 清空放在 await 之前，是为了让这次写入失败时 agent_end 不再拿同一条去重试一遍
        partial = undefined;
        await service.appendMessage(sessionId, event.message);
        return;
      }

      if (event.type === "agent_end") {
        // 走到这里 partial 还在，只能是「这条消息发过 message_start / message_update
        // 却没等到 message_end」，也就是本轮确实被打断了——正常完成与模型报错
        // 都会经过上面那个分支把它清掉。不必再去查 state 的 stopReason / errorMessage
        if (partial !== undefined) {
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

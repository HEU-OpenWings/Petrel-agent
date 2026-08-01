import {
  createMessageRepository,
  createSessionRepository,
  type Database,
  DEFAULT_USER_ID,
} from "@petrel/database";

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

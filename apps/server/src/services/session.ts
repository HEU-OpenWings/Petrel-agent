import { createEntryRepository, createSessionRepository, type Database } from "@petrel/database";

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
  const entryRepo = createEntryRepository(db);

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

    /**
     * 前端历史展示用的完整 transcript。
     *
     * **不能用 session.buildContext()**：它会应用 compaction 变换，
     * 于是压缩发生之后用户刷新页面会看到历史凭空消失。
     * buildContext 是喂模型用的（那里正需要被压缩后的版本），两者不能混。
     */
    async loadHistory(sessionId: string) {
      // 先确认归属：条目按 sessionId 查，这条路上没有 userId。
      // 不属于自己时按会话不存在处理，与「新会话后端还没有这一行」的行为一致
      if (!(await sessionRepo.findById(sessionId, userId))) {
        return { messages: [] };
      }
      const rows = await entryRepo.listAll(sessionId);
      return {
        messages: rows
          .filter((row) => row.type === "message")
          .map((row) => (row.payload as { message: unknown }).message),
      };
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
  };
}

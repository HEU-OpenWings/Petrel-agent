import { env } from "@petrel/config";
import { createMemoryRepository, type Database, type Memory } from "@petrel/database";
import { embed } from "./embedding/client.ts";
import { MemoryQuotaError } from "./errors.ts";

/**
 * 单条记忆的长度上限。
 *
 * content 在库里是无长度限制的 text，而写入方是模型——一次工具调用就能塞进
 * 很长的内容，之后每次检索命中都要整份发回上下文。同 routes/account.ts 的
 * SYSTEM_PROMPT_LENGTH_LIMIT。
 */
export const MEMORY_CONTENT_LENGTH_LIMIT = 500;

export interface WriteMemoryParams {
  userId: string;
  /** 来源会话，只作维度记录；null 表示非会话来源 */
  sessionId: string | null;
  content: string;
}

/**
 * 写一条用户级长期记忆。
 *
 * 顺序是**先查数再 embed**：条数超限时不该先花一次 embedding 的钱。
 */
export async function writeMemory(
  db: Database,
  params: WriteMemoryParams,
  options: { signal?: AbortSignal } = {},
): Promise<Memory> {
  const content = params.content.trim();
  if (content === "") {
    throw new Error("记忆内容不能为空");
  }
  if (content.length > MEMORY_CONTENT_LENGTH_LIMIT) {
    throw new Error(`记忆内容不能超过 ${MEMORY_CONTENT_LENGTH_LIMIT} 字`);
  }

  const repo = createMemoryRepository(db);
  const count = await repo.countByUserId(params.userId);
  if (count >= env.memory.maxPerUser) {
    throw new MemoryQuotaError(
      `记忆条数已达上限 ${env.memory.maxPerUser}，请先删除一些不再需要的记忆`,
    );
  }

  const [embedding] = await embed([content], options);
  // embed() 保证返回条数与入参一致，这里只是让类型收窄
  if (!embedding) throw new Error("embedding 返回为空");

  return repo.insert(params.userId, { content, embedding, sourceSessionId: params.sessionId });
}

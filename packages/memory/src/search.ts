import { env } from "@petrel/config";
import { createMemoryRepository, type Database, type MemorySearchHit } from "@petrel/database";
import { embed } from "./embedding/client.ts";

export interface SearchMemoriesParams {
  userId: string;
  query: string;
  /** 不传用 MEMORY_SEARCH_LIMIT */
  limit?: number;
}

/**
 * 语义检索当前用户的记忆。
 *
 * userId 只能来自调用方的可信上下文（工具的 context / 路由的 currentUser），
 * **不接受模型传参**——模型的参数来自对话内容，等价于让用户自己指定读谁的数据。
 */
export async function searchMemories(
  db: Database,
  params: SearchMemoriesParams,
  options: { signal?: AbortSignal } = {},
): Promise<MemorySearchHit[]> {
  const query = params.query.trim();
  if (query === "") return [];

  const [embedding] = await embed([query], options);
  if (!embedding) throw new Error("embedding 返回为空");

  return createMemoryRepository(db).searchByEmbedding(
    params.userId,
    embedding,
    params.limit ?? env.memory.searchLimit,
  );
}

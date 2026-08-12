/**
 * 用户级长期记忆的 embedding 与检索编排。
 *
 * 边界：
 * - **本包不出现任何 pi 类型**。memory_write / memory_search 的工具定义在
 *   packages/agent/src/tools/，只调用这里导出的纯函数。
 * - **所有 SQL 留在 @petrel/database 的 repository 里**，本包只做编排。
 * - src/embedding/ 与记忆域零耦合，知识库（HEU-21）落地时可整目录平移。
 */
export { embed, isEmbeddingConfigured } from "./embedding/client.ts";
export { EmbeddingError, MemoryQuotaError } from "./errors.ts";
export { type SearchMemoriesParams, searchMemories } from "./search.ts";
export { MEMORY_CONTENT_LENGTH_LIMIT, type WriteMemoryParams, writeMemory } from "./write.ts";

/**
 * embedding 相关的全部失败。
 *
 * 这一层不返回错误码：翻译成「工具的 isError 结果」是 packages/agent 里工具壳的事，
 * 翻译成 HTTP 状态码是路由的事。编排层不该知道调用者是谁。
 */
export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

/** 记忆条数超过 MEMORY_MAX_PER_USER。成本闸门，不是产品限制 */
export class MemoryQuotaError extends Error {
  override readonly name = "MemoryQuotaError";
}

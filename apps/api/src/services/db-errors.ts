/**
 * drizzle 把驱动抛的错误包一层，原始错误在 cause 上；node-postgres 与 PGlite
 * 的 cause 都是 pg 风格的对象，唯一约束冲突是 SQLSTATE 23505。
 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { cause?: { code?: string } } | null)?.cause?.code === "23505";
}

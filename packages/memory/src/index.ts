/**
 * 用户级长期记忆的 embedding 与检索编排。
 *
 * 边界（决定了实现该往哪放）：
 * - **本包不出现任何 pi 类型**。`memory_write` / `memory_search` 的工具定义留在
 *   `packages/agent/src/tools/`，只调用这里导出的纯函数——pi 的接线只允许位于
 *   `packages/agent`。
 * - **所有 SQL 留在 `@petrel/database` 的 repository 里**，本包只做
 *   「embed 文本 → 调 repo」的编排，不直接对表发查询。
 * - `src/embedding/` 与记忆域零耦合（只认「文本进、向量出」），
 *   知识库（HEU-21）落地时可整目录平移，不必重构调用方。
 *
 * 当前是空骨架：实现随 M1（存储地基）与 M2（embedding 与编排）落地。
 */
export {};

/**
 * 重新导出 drizzle 的 sql 模板标签。
 *
 * repository 内部（token-usage.ts 的窗口函数）已经用它写 raw SQL，但没暴露给上层。
 * 测试需要手动构造「窗口外的旧用量事实」这类 recorded_at 不走 defaultNow() 的场景，
 * 而 insertFact 不接受 recorded_at——这类测试只能直接执行 INSERT。
 * 上层包（apps/server）不直接依赖 drizzle-orm，从这里拿 sql 才能在严格 node_modules 下解析到。
 * 仅作此用途导出，不鼓励业务代码绕过 repository 写 SQL。
 */
export { sql } from "drizzle-orm";
export * from "./client.ts";
export * from "./migrate.ts";
export * from "./repositories/entries.ts";
export * from "./repositories/preferences.ts";
export * from "./repositories/provider-credentials.ts";
export * from "./repositories/quota-limits.ts";
export * from "./repositories/sessions.ts";
export * from "./repositories/token-usage.ts";
export * from "./repositories/users.ts";
export * from "./schema.ts";

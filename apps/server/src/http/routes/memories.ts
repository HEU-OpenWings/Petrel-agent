import { createMemoryRepository, getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";

/**
 * 用户对自己记忆的只读与删除。
 *
 * 没有 POST / PUT：v1 的写入路径只有模型（memory_write 工具），
 * 用户手动新增记忆是另一个产品决定，现在加等于替将来做主——
 * 需要加一条记忆时可以直接跟 agent 说。
 */
export const memories = new Hono<AppEnv>()
  .get("/", async (c) => {
    const repo = createMemoryRepository(getDb());
    return c.json({ memories: await repo.listByUserId(c.get("currentUser").id) });
  })

  /** 不存在与不属于自己一律 404：403 会泄漏「这个 id 存在」 */
  .delete("/:id", async (c) => {
    const repo = createMemoryRepository(getDb());
    const deleted = await repo.deleteById(c.get("currentUser").id, c.req.param("id"));
    if (!deleted) {
      throw new HTTPException(404, { message: "记忆不存在" });
    }
    return c.json({ ok: true });
  });

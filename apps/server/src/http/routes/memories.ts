import { createMemoryRepository, getDb } from "@petrel/database";
import { isEmbeddingConfigured } from "@petrel/memory";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 用户对自己记忆的只读与删除。
 *
 * 没有 POST / PUT：v1 的写入路径只有模型（memory_write 工具），
 * 用户手动新增记忆是另一个产品决定，现在加等于替将来做主——
 * 需要加一条记忆时可以直接跟 agent 说。
 */
export const memories = new Hono<AppEnv>()
  /**
   * configured 是给面板区分「没配 embedding」与「配了但还没记下东西」用的：
   * 两种情况列表都是空的，而这个区别只有服务端知道（设计 §5）。
   */
  .get("/", async (c) => {
    const repo = createMemoryRepository(getDb());
    return c.json({
      memories: await repo.listByUserId(c.get("currentUser").id),
      configured: isEmbeddingConfigured(),
    });
  })

  /** 不存在与不属于自己一律 404：403 会泄漏「这个 id 存在」 */
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    // 先挡掉明显非法的，否则 Postgres 会在 `WHERE id = $2` 上报类型错 → 500。
    // 格式非法是 400 而不是 404：它与「这条记忆是否存在」无关，泄漏不了任何东西。
    // 同 sessions.ts 的 requireUuid
    if (!UUID_PATTERN.test(id)) {
      throw new HTTPException(400, { message: "记忆 id 必须是 UUID" });
    }

    const repo = createMemoryRepository(getDb());
    const deleted = await repo.deleteById(c.get("currentUser").id, id);
    if (!deleted) {
      throw new HTTPException(404, { message: "记忆不存在" });
    }
    return c.json({ ok: true });
  });

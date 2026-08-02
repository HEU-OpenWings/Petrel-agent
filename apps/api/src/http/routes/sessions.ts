import { getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSessionService } from "../../services/session.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id 由前端生成，进数据库前先挡掉明显非法的，避免让 Postgres 报类型错 */
function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HTTPException(400, { message: "会话 id 必须是 UUID" });
  }
  return value;
}

// 每个 handler 里现取 service，不在模块顶层建：getDb() 会建连接池，
// 顶层调用会让「只导入 app 就连数据库」，校验类用例也就没法脱离数据库跑
export const sessions = new Hono()
  .get("/", async (c) => {
    const service = createSessionService(getDb());
    return c.json({ sessions: await service.list() });
  })

  .get("/:id/messages", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb());
    const history = await service.loadHistory(id);
    return c.json({ messages: history.messages, interruptedSeqs: history.interruptedSeqs });
  })

  .patch("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const body = await c.req.json<{ title?: string }>().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });

    const title = body.title?.trim();
    if (!title) {
      throw new HTTPException(400, { message: "title 不能为空" });
    }

    const service = createSessionService(getDb());
    if (!(await service.rename(id, title))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    return c.json({ ok: true });
  })

  .delete("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb());
    if (!(await service.remove(id))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    return c.json({ ok: true });
  });

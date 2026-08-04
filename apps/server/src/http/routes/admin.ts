import { createSessionRepository, createUserRepository, getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";
import { getRegistry } from "./chat.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HTTPException(400, { message: "用户 id 必须是 UUID" });
  }
  return value;
}

/** body 是运行时来的 unknown，先判类型再用，避免客户端错误被兜成 500 */
function requireDisabled(body: unknown): boolean {
  const raw = (body as { disabled?: unknown } | null)?.disabled;
  if (typeof raw !== "boolean") {
    throw new HTTPException(400, { message: "disabled 必须是布尔值" });
  }
  return raw;
}

export const admin = new Hono<AppEnv>()
  .get("/users", async (c) => {
    const repo = createUserRepository(getDb());
    return c.json({ users: await repo.listAll() });
  })

  .patch("/users/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const disabled = requireDisabled(body);

    // 唯一的 admin 把自己禁掉就再也进不来了，只能改库恢复
    if (id === c.get("currentUser").id) {
      throw new HTTPException(400, { message: "不能禁用自己" });
    }

    const repo = createUserRepository(getDb());
    if (!(await repo.setDisabled(id, disabled))) {
      throw new HTTPException(404, { message: "用户不存在" });
    }

    // 被禁用者的下一个请求会被 requireAuth 拦住，但正在跑的那一轮不会自己停。
    // 立即生效是认证那一轮定下的原则，所以这里主动停掉他所有活实例
    if (disabled) {
      const owned = await createSessionRepository(getDb()).listByUser(id);
      await Promise.all(owned.map((session) => getRegistry().evict(session.id)));
    }

    return c.json({ ok: true });
  });

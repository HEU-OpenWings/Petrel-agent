import { getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createSessionService } from "../../services/session.ts";
import type { AppEnv } from "../../types.ts";
import { getRegistry } from "./chat.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 重命名的标题长度上限。自动生成的标题是 30 字（services/session.ts），
 * 200 给手动重命名留了充足余量，正常用户碰不到。
 *
 * 之所以要有上限：schema 里 title 是无长度限制的 text，一次请求就能塞进几十万字，
 * 之后每次 GET /api/sessions 都要把它整份吐给左栏，且没有任何 UI 路径能改回来。
 */
const TITLE_LENGTH_LIMIT = 200;

/**
 * 用 fromCharCode 而不是把 NUL 写成字面量：源码里放一个不可见的控制字符，
 * 编辑器和 diff 都看不出来，还会让 grep 把整个文件当二进制
 */
const NUL = String.fromCharCode(0);

/** id 由前端生成，进数据库前先挡掉明显非法的，避免让 Postgres 报类型错 */
function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HTTPException(400, { message: "会话 id 必须是 UUID" });
  }
  return value;
}

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 title，
 * 直接 body.title?.trim() 会抛成 500——客户端错误报成服务端错误，
 * 还会在 error 中间件里留一条带 stack 的 unhandled error 日志。
 *
 * NUL 要单独清掉：trim() 不管它，但 Postgres 的 text 存不了 NUL，
 * 漏过去照样是 500；清完为空就等同于空标题。
 */
function requireTitle(body: unknown): string {
  const raw = (body as { title?: unknown } | null)?.title;
  const title = typeof raw === "string" ? raw.replaceAll(NUL, "").trim() : "";
  if (!title) {
    // 文案要同时覆盖「类型不对」和「清完是空」两种情况：
    // 发了 { title: 123 } 却被告知「不能为空」，客户端会往错的方向排查
    throw new HTTPException(400, { message: "title 必须是非空字符串" });
  }
  if (title.length > TITLE_LENGTH_LIMIT) {
    throw new HTTPException(400, { message: `title 不能超过 ${TITLE_LENGTH_LIMIT} 字` });
  }
  return title;
}

// 每个 handler 里现取 service，不在模块顶层建：getDb() 会建连接池，
// 顶层调用会让「只导入 app 就连数据库」，校验类用例也就没法脱离数据库跑
export const sessions = new Hono<AppEnv>()
  .get("/", async (c) => {
    const service = createSessionService(getDb(), c.get("currentUser").id);
    return c.json({ sessions: await service.list() });
  })

  // 会话不存在时返回 200 + 空数组，与 PATCH/DELETE 的 404 有意不一致：
  // 新会话的 id 是前端 startNew() 本地生成的（stores/session.js），
  // 用户切进去时后端还没有这一行，这里返回 404 会让新建的会话直接打不开
  .get("/:id/messages", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb(), c.get("currentUser").id);
    const history = await service.loadHistory(id);
    return c.json({ messages: history.messages });
  })

  .patch("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const title = requireTitle(body);

    const service = createSessionService(getDb(), c.get("currentUser").id);
    if (!(await service.rename(id, title))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    return c.json({ ok: true });
  })

  .delete("/:id", async (c) => {
    const id = requireUuid(c.req.param("id"));
    const service = createSessionService(getDb(), c.get("currentUser").id);
    if (!(await service.remove(id))) {
      throw new HTTPException(404, { message: "会话不存在" });
    }
    // 否则内存里还有个活 harness 往已删除的会话写，报错发生在没有请求上下文的地方，日志极难查
    await getRegistry().evict(id);
    return c.json({ ok: true });
  });

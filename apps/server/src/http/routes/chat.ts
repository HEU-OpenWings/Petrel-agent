import { getDb } from "@petrel/database";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { createHarnessRegistry, HarnessRegistryError } from "../../services/harness-registry.ts";
import type { AppEnv } from "../../types.ts";
import { createSseQueue } from "../sse-queue.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * registry 是进程级单例：常驻实例的全部意义就是跨请求复用，
 * 每个请求建一个等于没有缓存。
 *
 * 懒初始化而不是模块顶层建：getDb() 会建连接池，顶层调用会让「只导入 app 就连数据库」，
 * 校验类用例也就没法脱离数据库跑（同 routes/sessions.ts 的注释）。
 */
let registry: ReturnType<typeof createHarnessRegistry> | undefined;

/** 导出给 sessions / admin 路由用：删会话、禁用用户时要清掉活实例 */
export function getRegistry() {
  registry ??= createHarnessRegistry({ db: getDb() });
  return registry;
}

/** 仅供测试：单例会跨测试文件把上一个 PGlite 实例带过来 */
export function __resetRegistry(): void {
  registry = undefined;
}

/**
 * registry 只表达「哪一种失败」，不认识 HTTP（同 services/auth.ts 的 AuthError 那套）。
 * forbidden 是越权 → 403；capacity 是运维信号，不是客户端的错 → 503。
 */
function toHttpException(error: unknown): never {
  if (error instanceof HarnessRegistryError) {
    const status = error.kind === "forbidden" ? 403 : 503;
    throw new HTTPException(status, { message: error.message });
  }
  throw error;
}

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 message，
 * 直接 body.message?.trim() 会抛成 500——客户端错误报成服务端错误。
 *
 * 校验顺序是 message 先于 sessionId：空消息是最常见的误用。
 */
function parseChatRequest(body: unknown) {
  const fields = body as { message?: unknown; sessionId?: unknown; systemPrompt?: unknown } | null;

  const message = typeof fields?.message === "string" ? fields.message.trim() : "";
  if (!message) {
    throw new HTTPException(400, { message: "message 必须是非空字符串" });
  }

  const sessionId = fields?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }

  const rawSystemPrompt = fields?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === "string" ? rawSystemPrompt : undefined;

  return { message, sessionId, systemPrompt };
}

function requireSessionId(body: unknown): string {
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }
  return sessionId;
}

export const chat = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const { message, sessionId, systemPrompt } = parseChatRequest(body);

    // acquire 里的 upsert 同时完成归属校验与建会话；不属于自己时抛 403（容量满时 503）。
    // 放在 streamSSE 之外：一旦开了流就只能在流里报错了
    const handle = await getRegistry()
      .acquire(sessionId, c.get("currentUser").id, message, systemPrompt)
      .catch(toHttpException);

    return streamSSE(c, async (stream) => {
      const queue = createSseQueue();
      let torn = false;
      let unsubscribe: () => void = () => undefined;

      // 幂等：溢出、client abort、正常收尾三条路径都会走到这里，只处理一次
      function teardown() {
        if (torn) return;
        torn = true;
        unsubscribe();
        handle.release();
        queue.close();
      }

      // pi 的事件原样透传，前端按事件类型归约为消息状态。
      // 订阅是会话级的，所以同一会话的另一个连接的输出也会流过来——
      // 它们本来就是这个会话的消息，前端按消息 id 归约，多标签页因此自动同步。
      //
      // 这个回调必须保持同步（不能 async/await 任何 I/O），见 createSseQueue 顶部注释
      unsubscribe = handle.harness.subscribe((event) => {
        const accepted = queue.push({ event: "agent", data: JSON.stringify(event) });
        if (!accepted) {
          logger.error({ sessionId }, "chat SSE 队列溢出，客户端疑似不读流，断开这一个连接");
          teardown();
          // 强制结束这一路 HTTP 响应：writer 一旦被 abort，pump() 里卡住的
          // writeSSE 会立刻结束等待（write() 内部吞掉错误），不必等它自然写完
          stream.abort();
        }
      });

      // 连接断开只退订，不 abort：harness 常驻，回答继续跑完并落库。
      // 用户主动停止走 POST /api/chat/abort
      stream.onAbort(teardown);

      const pumpDone = queue.pump((frame) => stream.writeSSE(frame));

      try {
        await handle.send(message);
      } catch (error) {
        logger.error({ err: error, sessionId }, "agent run failed");
        queue.push({
          event: "error",
          data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        });
      } finally {
        teardown();
      }

      // 队列里可能还有没写出的事件（包括 agent_end）：收尾前先等 pump() 写完，
      // 否则一个读得不慢、只是没读到最后的正常客户端也会丢掉结尾几帧
      await pumpDone;
    });
  })

  /**
   * 显式停止。连接断开不再等于停止（见 spec §5），所以这是唯一的中断入口。
   * 会话已经跑完时幂等成功——abort 一个结束了的会话不是错误。
   */
  .post("/abort", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const sessionId = requireSessionId(body);

    await getRegistry().abort(sessionId, c.get("currentUser").id).catch(toHttpException);
    return c.json({ ok: true });
  });

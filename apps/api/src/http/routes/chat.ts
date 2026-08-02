import { type AgentMessage, createAgent } from "@petrel/agent-core";
import { getDb } from "@petrel/database";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { attachPersistence, createSessionService } from "../../services/session.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 message，
 * 直接 body.message?.trim() 会抛成 500——客户端错误报成服务端错误，
 * 还会在 error 中间件里留一条带 stack 的 unhandled error 日志（同 routes/sessions.ts 的 requireTitle）。
 *
 * 校验顺序是 message 先于 sessionId：空消息是最常见的误用，
 * 先报它也让「message 不能为空」这个既有契约不受新增的 sessionId 校验影响。
 */
function parseChatRequest(body: unknown) {
  const fields = body as { message?: unknown; sessionId?: unknown; systemPrompt?: unknown } | null;

  const message = typeof fields?.message === "string" ? fields.message.trim() : "";
  if (!message) {
    throw new HTTPException(400, { message: "message 不能为空" });
  }

  // id 由前端生成，进数据库前先挡掉明显非法的，避免让 Postgres 报类型错
  const sessionId = fields?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }

  // systemPrompt 可选，不是字符串就当没传，别让非法值混进 initialState 发给模型
  const rawSystemPrompt = fields?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === "string" ? rawSystemPrompt : undefined;

  return { message, sessionId, systemPrompt };
}

/**
 * 加载历史并确保会话存在。
 *
 * 这里不手动存用户消息：pi 的事件序列里用户消息同样会触发 message_end，
 * attachPersistence 订阅一处就收下了，手动再存一遍会重复。
 *
 * 数据库不可用时整段降级：对话照常进行，只是这一轮不会被保存，
 * 多轮上下文退化成单轮。能用但记不住，好过直接不能用。
 */
async function prepareSession(sessionId: string, message: string) {
  try {
    const service = createSessionService(getDb());
    await service.ensureSession(sessionId, message);

    const history = await service.loadHistory(sessionId);
    // 落库的就是 pi 的 AgentMessage，读回来是 jsonb 的 unknown，原样回灌不做转换
    return { service, history: history.messages as AgentMessage[], nextSeq: history.nextSeq };
  } catch (error) {
    logger.error({ err: error, sessionId }, "session unavailable, continuing without persistence");
    return undefined;
  }
}

export const chat = new Hono().post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "请求体必须是 JSON" });
  });
  const { message, sessionId, systemPrompt } = parseChatRequest(body);

  const prepared = await prepareSession(sessionId, message);

  return streamSSE(c, async (stream) => {
    const agent = createAgent({
      systemPrompt,
      // 复用同一个 id 传给 pi，供 provider 做缓存感知
      sessionId,
      // 历史回灌：本轮之前的消息原样进 transcript，模型才看得到上下文
      messages: prepared?.history,
    });

    // pi 的 AgentEvent 原样透传，前端按事件类型归约为消息状态
    agent.subscribe(async (event) => {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
    });

    if (prepared) {
      attachPersistence(prepared.service, agent, sessionId, prepared.nextSeq);
    }

    stream.onAbort(() => agent.abort());

    try {
      await agent.prompt(message);
    } catch (error) {
      logger.error({ err: error }, "agent run failed");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});

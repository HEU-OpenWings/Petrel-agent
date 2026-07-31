import { createAgent } from "@petrel/agent-core";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

interface ChatRequest {
  message?: string;
  systemPrompt?: string;
}

export const chat = new Hono().post("/", async (c) => {
  const body = await c.req.json<ChatRequest>().catch(() => {
    throw new HTTPException(400, { message: "请求体必须是 JSON" });
  });
  const message = body.message?.trim();
  if (!message) {
    throw new HTTPException(400, { message: "message 不能为空" });
  }

  return streamSSE(c, async (stream) => {
    const agent = createAgent({ systemPrompt: body.systemPrompt });

    // pi 的 AgentEvent 原样透传，前端按事件类型归约为消息状态
    agent.subscribe(async (event) => {
      await stream.writeSSE({ event: "agent", data: JSON.stringify(event) });
    });

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

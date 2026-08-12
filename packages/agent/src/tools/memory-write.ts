import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { getDb } from "@petrel/database";
import { writeMemory } from "@petrel/memory";
import type { ToolContext } from "../harness.ts";

const MemoryWriteParams = Type.Object({
  content: Type.String({ description: "要记住的信息，一句话说清楚，不要写成对话片段" }),
});

/**
 * 写一条关于当前用户的长期记忆。
 *
 * sourceSessionId 从 context 取而不是让模型传：它是审计维度，
 * 让模型填等于让它可以伪造来源。
 */
export const memoryWrite: AgentHarnessTool<ToolContext> = {
  name: "memory_write",
  label: "记住",
  description:
    "记住一条关于用户的长期信息，之后的对话里都能检索到。" +
    "适合记：稳定的偏好与习惯、身份与职业信息、长期在做的项目、明确说过的约定。" +
    "不要记：一次性的问题、只在本次对话里有意义的上下文、密码或密钥这类凭据、" +
    "以及你自己推测而用户没有确认过的信息。",
  parameters: MemoryWriteParams,
  execute: async (_toolCallId, params: Static<typeof MemoryWriteParams>, signal, _onUpdate, context) => {
    const memory = await writeMemory(
      getDb(),
      { userId: context.userId, sessionId: context.sessionId, content: params.content },
      { signal },
    );
    const payload = { saved: memory.content };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  },
};

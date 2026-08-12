import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { getDb } from "@petrel/database";
import { searchMemories } from "@petrel/memory";
import type { ToolContext } from "../harness.ts";

const MemorySearchParams = Type.Object({
  query: Type.String({ description: "想要回忆的内容，用自然语言描述" }),
});

/**
 * 检索当前用户的长期记忆。
 *
 * userId 只来自 context，参数里没有任何身份字段——模型的参数来自对话内容，
 * 接受模型传身份等价于让用户自己指定读谁的数据。
 *
 * 失败靠 throw：AgentToolResult 上没有 isError 字段，pi 在 agent-loop 的
 * try/catch 里捕获异常并生成 isError 的 tool result，对话不会中断
 * （见 docs/superpowers/specs/2026-08-09-memory-m3-tools-design.md §1）。
 * 所以异常信息里不能有凭据或用户记忆原文——它会原样进模型上下文。
 */
export const memorySearch: AgentHarnessTool<ToolContext> = {
  name: "memory_search",
  label: "检索记忆",
  description:
    "检索关于当前用户的长期记忆：偏好、习惯、身份信息、正在做的事。" +
    "在回答任何与用户本人相关的问题之前先调用它，不要只凭当前对话里的信息作答。",
  parameters: MemorySearchParams,
  execute: async (_toolCallId, params: Static<typeof MemorySearchParams>, signal, _onUpdate, context) => {
    const hits = await searchMemories(getDb(), { userId: context.userId, query: params.query }, { signal });
    const payload = {
      query: params.query,
      memories: hits.map((hit) => ({ content: hit.content, similarity: hit.similarity })),
    };
    // 结构化结果必须序列化进 content 的文本块：apps/web 的 extractToolResultText()
    // 只取 content 里 type === "text" 的块，details 目前没有消费方。
    // details 仍然填，它是给日志与将来的工作区面板用的
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  },
};

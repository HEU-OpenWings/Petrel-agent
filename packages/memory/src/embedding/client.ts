import { env } from "@petrel/config";
import { MEMORY_EMBEDDING_DIM } from "@petrel/database";
import { EmbeddingError } from "../errors.ts";

/** 未配置 key 时为 false。M3 据此决定记忆工具进不进注册表 */
export function isEmbeddingConfigured(): boolean {
  return env.embedding.apiKey !== "";
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * 批量取 embedding，返回顺序与入参一一对应。
 *
 * 与记忆域零耦合：只认「文本进、向量出」，不认 Memory 类型。
 * 知识库（HEU-21）落地时这个目录可以整体平移。
 */
export async function embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
  if (!isEmbeddingConfigured()) {
    throw new EmbeddingError("未配置 EMBEDDING_API_KEY，记忆功能不可用");
  }
  if (texts.length === 0) return [];

  // 自己的超时与调用方的取消合并：用户点停止时要能真的停下来，同时自己也要有上限，
  // 否则一个不响应的 provider 会把请求挂到 Node 的默认超时
  const timeout = AbortSignal.timeout(env.embedding.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(`${env.embedding.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.embedding.apiKey}`,
      },
      body: JSON.stringify({ model: env.embedding.model, input: texts, encoding_format: "float" }),
      signal,
    });
  } catch (error) {
    // 不带上 texts：错误会进日志，记忆原文不该出现在那里
    throw new EmbeddingError(`embedding 请求失败：${(error as Error).message}`);
  }

  if (!response.ok) {
    // 不透传响应体：provider 的错误响应可能回显请求内容，那里面是用户的记忆原文
    throw new EmbeddingError(`embedding 服务返回 ${response.status}`);
  }

  const payload = (await response.json().catch(() => null)) as EmbeddingResponse | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new EmbeddingError(`embedding 返回条数不符：期望 ${texts.length}，实际 ${data?.length ?? 0}`);
  }

  // 按 index 排回原顺序：OpenAI 的响应实践上有序，但那是实现细节不是契约。
  // 乱序会让「记忆 A 的内容配上记忆 B 的向量」——不报错，只是检索永远不准
  const sorted = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  return sorted.map((item, position) => {
    const values = item.embedding;
    if (!Array.isArray(values) || values.length !== MEMORY_EMBEDDING_DIM) {
      throw new EmbeddingError(
        `embedding 维度不符：第 ${position} 条期望 ${MEMORY_EMBEDDING_DIM}，实际 ${values?.length ?? 0}；` +
          `模型 ${env.embedding.model} 可能与 user_memories.embedding 的列宽不匹配`,
      );
    }
    return values;
  });
}

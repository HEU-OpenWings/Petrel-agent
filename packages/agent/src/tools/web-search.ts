import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { env } from "@petrel/config";
import type { ToolContext } from "../harness.ts";

// ---------------------------------------------------------------------------
// Tavily API
// ---------------------------------------------------------------------------

const TAVILY_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
  published_date?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  response_time: number;
  results: TavilyResult[];
}

// ---------------------------------------------------------------------------
// 工具参数（TypeBox）
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
  query: Type.String({ description: "搜索查询词" }),
  max_results: Type.Optional(Type.Integer({ description: "返回结果条数，默认 5", minimum: 1, maximum: 20 })),
  search_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "搜索深度：basic 快速、advanced 深入，默认 basic",
    }),
  ),
});

// ---------------------------------------------------------------------------
// 工具工厂
// ---------------------------------------------------------------------------

/**
 * 创建 web_search 工具。
 *
 * @param apiKey Tavily API key。空串表示未配置——此时返回 undefined，调用方不应注册此工具。
 */
export function createWebSearchTool(apiKey: string): AgentHarnessTool<ToolContext> | undefined {
  if (!apiKey) return undefined;

  return {
    name: "web_search",
    label: "网页搜索",
    description:
      "搜索互联网获取实时信息。当需要最新的新闻、数据或事实时调用此工具。返回结果包含标题、URL、摘要和相关度评分。",
    parameters: WebSearchParams,
    execute: async (_toolCallId, params: Static<typeof WebSearchParams>, signal, _onUpdate, _context) => {
      const { query, max_results = DEFAULT_MAX_RESULTS, search_depth = "basic" } = params;

      // 超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      // 用户点停止时也能取消
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetch(TAVILY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results,
            search_depth,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          const errorData = {
            error: `搜索失败 (${response.status})`,
            query,
            results: [] as TavilyResult[],
          };
          return {
            content: [{ type: "text", text: JSON.stringify(errorData) }],
            details: { error: errorText, status: response.status, query },
          };
        }

        const data = (await response.json()) as TavilyResponse;

        // 输出形状匹配前端 WebSearchResult.vue 的 isWebSearchResult 判定
        const output = {
          query: data.query,
          response_time: data.response_time,
          results: (data.results ?? []).map((r) => ({
            url: r.url,
            title: r.title,
            score: r.score,
            published_date: r.published_date ?? "",
            content: r.content,
          })),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          details: {
            query: data.query,
            responseTime: data.response_time,
            resultCount: data.results?.length ?? 0,
          },
        };
      } catch (error) {
        // fetch 抛出的异常（网络错误、超时、AbortError）→ isError 结果让模型知道并自行决策
        const message = error instanceof Error ? error.message : String(error);
        const errorData = {
          error: `搜索请求失败：${message}`,
          query,
          results: [] as TavilyResult[],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(errorData) }],
          details: { error: message, query },
        };
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * 从 config 创建 web_search 工具。
 * API key 未配置时返回 undefined——调用方此时不应注册该工具。
 */
export function createWebSearchFromConfig(): AgentHarnessTool<ToolContext> | undefined {
  return createWebSearchTool(env.tavilyApiKey);
}

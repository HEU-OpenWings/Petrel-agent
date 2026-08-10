import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env } from "@petrel/config";
import type { ToolContext } from "../harness.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * MCP server 的静态配置。
 *
 * 当前只支持 HTTP transport（Streamable HTTP）。
 * 命名空间 name 会被用作工具名前缀：`{name}__{toolName}`。
 */
export interface McpServerConfig {
  name: string;
  url: string;
}

// ---------------------------------------------------------------------------
// 静态 server 列表
// ---------------------------------------------------------------------------

/**
 * 返回静态配置的 MCP server 列表。
 *
 * 当前是硬编码的空列表，后续可从 env 读取。
 * 设计为函数是为了将来从不同来源（env、config 文件、数据库）获取配置。
 */
export function getMcpServerConfigs(): McpServerConfig[] {
  if (!env.mcpServers) return [];
  try {
    const parsed = JSON.parse(env.mcpServers);
    if (!Array.isArray(parsed)) {
      throw new Error("MCP_SERVERS 必须是 JSON 数组");
    }
    return parsed as McpServerConfig[];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`MCP_SERVERS 不是合法的 JSON：${error.message}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox 转换
// ---------------------------------------------------------------------------

/**
 * 将 MCP 的 inputSchema（JSON Schema）转换为 TypeBox schema。
 *
 * 无法映射的类型回退到 `Type.Object({})`——各 provider 的函数调用 API 要求
 * parameters 必须是 `type: "object"`，`Type.Any()` 生成的非 object schema
 * 会被拒绝（400 Invalid schema）。
 *
 * 实际参数校验由 MCP server 端完成，此处只保证 provider 不拒收。
 */
function jsonSchemaToTypeBox(raw: unknown): ReturnType<typeof Type.Any> {
  const asAny = <T>(t: T): ReturnType<typeof Type.Any> => t as unknown as ReturnType<typeof Type.Any>;

  const schema = raw as Record<string, unknown> | null | undefined;
  if (!schema || typeof schema !== "object") return asAny(Type.Object({}));

  const type = schema.type;

  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    const shape: Record<string, ReturnType<typeof Type.Any>> = {};
    const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      const prop = jsonSchemaToTypeBox(propSchema);
      shape[key] = required.has(key) ? prop : asAny(Type.Optional(prop));
    }
    return asAny(Type.Object(shape));
  }

  if (type === "string") return asAny(Type.String());
  if (type === "number" || type === "integer") return asAny(Type.Number());
  if (type === "boolean") return asAny(Type.Boolean());
  if (type === "array") {
    const items = schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Any();
    return asAny(Type.Array(items));
  }

  // 有 enum → literal union
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((v) => Type.Literal(v as string | number | boolean));
    return asAny(Type.Union(literals));
  }

  // 回退：保证至少是 type: "object"，不让 provider 报 400
  return asAny(Type.Object({}));
}

// ---------------------------------------------------------------------------
// MCP server 连接
// ---------------------------------------------------------------------------

/**
 * 连接到 MCP server 并返回其工具列表。
 *
 * 连接失败时返回空数组——server 不可用只是它的工具不出现，其余工具与对话不受影响。
 */
export async function connectMcpServer(config: McpServerConfig): Promise<{
  tools: AgentHarnessTool<ToolContext>[];
  cleanup: () => Promise<void>;
}> {
  const client = new Client({ name: "petrel-agent", version: "0.5.0" }, { capabilities: {} });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(config.url));
    await client.connect(transport);
  } catch (_error) {
    // server 不可用时降级：它的工具不出现，对话照常
    return { tools: [], cleanup: async () => {} };
  }

  let tools: AgentHarnessTool<ToolContext>[] = [];
  try {
    const result = await client.listTools();
    tools = result.tools.map((mcpTool) => {
      const prefixedName = `${config.name}__${mcpTool.name}`;

      const tool: AgentHarnessTool<ToolContext> = {
        name: prefixedName,
        label: `${config.name}: ${mcpTool.name}`,
        description: mcpTool.description ?? `${config.name} 提供的 ${mcpTool.name} 工具`,
        parameters: jsonSchemaToTypeBox(mcpTool.inputSchema),
        execute: async (_toolCallId, params, signal, _onUpdate, _context) => {
          // MCP callTool 超时 30 秒
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30_000);
          const onAbort = () => controller.abort();
          signal?.addEventListener("abort", onAbort, { once: true });

          try {
            const callResult = await client.callTool(
              { name: mcpTool.name, arguments: params as Record<string, unknown> },
              undefined,
              { signal: controller.signal },
            );

            // MCP 返回的 content 直接映射到 AgentToolResult.content
            const content = (callResult.content as { type: string; text?: string }[]).map((c) => {
              if (c.type === "text" && typeof c.text === "string") {
                return { type: "text" as const, text: c.text };
              }
              // image / audio / resource 等类型序列化为 text 块
              return { type: "text" as const, text: JSON.stringify(c) };
            });

            return { content, details: { result: callResult } };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `MCP 工具调用失败：${message}` }) }],
              details: { error: message },
            };
          } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onAbort);
          }
        },
      };

      return tool;
    });
  } catch {
    // listTools 失败也算 server 不可用
    return { tools: [], cleanup: async () => {} };
  }

  return {
    tools,
    cleanup: async () => {
      try {
        await client.close();
      } catch {
        // 清理失败不抛
      }
    },
  };
}

/**
 * 连接所有静态配置的 MCP server，返回所有工具。
 *
 * 每个 server 独立降级：某个连不上不影响其他 server 的工具。
 */
export async function connectAllMcpServers(): Promise<{
  tools: AgentHarnessTool<ToolContext>[];
  cleanup: () => Promise<void>;
}> {
  const configs = getMcpServerConfigs();
  const allTools: AgentHarnessTool<ToolContext>[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  for (const config of configs) {
    const { tools, cleanup } = await connectMcpServer(config);
    allTools.push(...tools);
    cleanups.push(cleanup);
  }

  return {
    tools: allTools,
    cleanup: async () => {
      await Promise.all(cleanups.map((c) => c().catch(() => {})));
    },
  };
}

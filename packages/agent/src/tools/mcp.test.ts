import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { connectAllMcpServers, connectMcpServer, getMcpServerConfigs } from "./mcp.ts";

// ---------------------------------------------------------------------------
// 极简 MCP HTTP server（JSON-RPC over POST，不走 SSE）。
//
// MCP Streamable HTTP 协议的握手与工具调用只用到 POST endpoint；
// SSE 仅用于 server→client 的推送通知，本轮不需要。
// 直接实现 JSON-RPC 响应，测试 connectMcpServer 的 HTTP 路径全覆盖。
// ---------------------------------------------------------------------------

interface MinimalMcpServer {
  url: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** 工具名 → 处理函数。收到的 arguments 与工具执行结果都在这里 */
  handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
  >;
  close: () => Promise<void>;
}

/**
 * 启动一个极简 MCP server：
 * - POST / → JSON-RPC 2.0 请求（initialize、tools/list、tools/call）
 * - GET / → 204（SSE session 初始化，不做 server 推送）
 * - DELETE / → 200（session 清理）
 */
function createMinimalMcpServer(): Promise<MinimalMcpServer> {
  return new Promise((resolve) => {
    const tools: MinimalMcpServer["tools"] = [];
    const handlers: MinimalMcpServer["handlers"] = {};

    const srv = http.createServer(async (req, res) => {
      // CORS header — MCP client 也会发
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "GET") {
        // SSE session 初始化。返回 Mcp-Session-Id header + 空流。
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "test-session",
        });
        // 发一个空事件让 client 知道连接已建立，然后立即结束
        res.write("event: endpoint\ndata: /\n\n");
        res.end();
        return;
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body) {
          res.writeHead(400);
          res.end();
          return;
        }

        const request = JSON.parse(body) as {
          jsonrpc: string;
          id: number | string;
          method: string;
          params?: Record<string, unknown>;
        };

        if (request.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "test-mcp-server", version: "1.0.0" },
              },
            }),
          );
          return;
        }

        if (request.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }

        if (request.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { tools },
            }),
          );
          return;
        }

        if (request.method === "tools/call") {
          const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined;
          const toolName = params?.name;
          const handler = toolName ? handlers[toolName] : undefined;
          if (!toolName || !handler) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: `Unknown tool: ${toolName}` },
              }),
            );
            return;
          }

          try {
            const result = await handler(params.arguments ?? {});
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result,
              }),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
              }),
            );
          }
          return;
        }

        // 未知方法
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          }),
        );
        return;
      }

      res.writeHead(405);
      res.end();
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        tools,
        handlers,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            srv.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
          }),
      });
    });
  });
}

/** 读取 HTTP request body */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getMcpServerConfigs", () => {
  it("默认返回空列表", () => {
    expect(getMcpServerConfigs()).toEqual([]);
  });
});

describe("connectMcpServer（无效 URL 降级）", () => {
  it("无效 URL 也返回空 tools，不抛异常", async () => {
    const { tools, cleanup } = await connectMcpServer({
      name: "test-server",
      url: "http://localhost:19999",
    });

    expect(tools).toEqual([]);
    await cleanup();
  });

  it("不存在的 host 也降级为无工具", async () => {
    const { tools, cleanup } = await connectMcpServer({
      name: "bad",
      url: "http://does-not-exist.invalid",
    });

    expect(tools).toEqual([]);
    await cleanup();
  });
});

describe("connectAllMcpServers", () => {
  it("没有配置任何 server 时返回空 tools", async () => {
    const { tools, cleanup } = await connectAllMcpServers();
    expect(tools).toEqual([]);
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// 真实 MCP server 接入（验收标准第 6 条）
// ---------------------------------------------------------------------------

describe("MCP server 完整往返（HTTP）", () => {
  let mcp: MinimalMcpServer;

  afterEach(async () => {
    if (mcp) await mcp.close();
  });

  it("接入真实 MCP server 后，工具列表包含注册的工具", async () => {
    mcp = await createMinimalMcpServer();
    mcp.tools.push({
      name: "greet",
      description: "打招呼",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "名字" } },
        required: ["name"],
      },
    });
    mcp.tools.push({
      name: "ping",
      description: "Ping 测试",
      inputSchema: { type: "object", properties: {} },
    });

    const { tools, cleanup } = await connectMcpServer({ name: "srv", url: mcp.url });

    const names = tools.map((t) => t.name);
    // 命名空间前缀
    expect(names).toContain("srv__greet");
    expect(names).toContain("srv__ping");

    await cleanup();
  });

  it("MCP 工具可被模型成功调用（execute 往返）", async () => {
    mcp = await createMinimalMcpServer();
    mcp.tools.push({
      name: "add",
      description: "加法",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    });
    mcp.handlers.add = async ({ a, b }) => ({
      content: [{ type: "text", text: JSON.stringify({ result: (a as number) + (b as number) }) }],
    });

    const { tools, cleanup } = await connectMcpServer({ name: "math", url: mcp.url });
    const addTool = tools.find((t) => t.name === "math__add");
    if (!addTool) throw new Error("未找到 add 工具");

    const result = await addTool.execute("tc-add", { a: 3, b: 4 }, undefined, undefined, {
      userId: "u1",
      sessionId: "s1",
    });

    const text = result.content.find((b) => b.type === "text");
    if (!text) throw new Error("没有 text 块");
    const parsed = JSON.parse(text.text) as { result: number };
    expect(parsed.result).toBe(7);

    await cleanup();
  });

  it("MCP 工具调用失败时返回错误信息而不抛异常", async () => {
    mcp = await createMinimalMcpServer();
    mcp.tools.push({
      name: "risky",
      description: "总是失败",
      inputSchema: { type: "object", properties: {} },
    });
    mcp.handlers.risky = async () => {
      throw new Error("something went wrong");
    };

    const { tools, cleanup } = await connectMcpServer({ name: "test", url: mcp.url });
    const riskyTool = tools.find((t) => t.name === "test__risky");
    if (!riskyTool) throw new Error("未找到 risky 工具");

    const result = await riskyTool.execute("tc-risky", {}, undefined, undefined, {
      userId: "u1",
      sessionId: "s1",
    });

    // 不抛异常——MCP server 返回的 isError 结果被透传
    expect(result.content).toBeDefined();

    await cleanup();
  });

  it("空 inputSchema 的 MCP 工具可以正常调用", async () => {
    mcp = await createMinimalMcpServer();
    mcp.tools.push({
      name: "hello",
      description: "无参问候",
      inputSchema: { type: "object", properties: {} },
    });
    mcp.handlers.hello = async () => ({
      content: [{ type: "text", text: "Hello, World!" }],
    });

    const { tools, cleanup } = await connectMcpServer({ name: "srv", url: mcp.url });
    const helloTool = tools.find((t) => t.name === "srv__hello");
    if (!helloTool) throw new Error("未找到 hello 工具");

    const result = await helloTool.execute("tc-hello", {}, undefined, undefined, {
      userId: "u1",
      sessionId: "s1",
    });

    const text = result.content.find((b) => b.type === "text");
    if (!text) throw new Error("没有 text 块");
    expect(text.text).toBe("Hello, World!");

    await cleanup();
  });
});

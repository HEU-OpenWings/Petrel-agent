import { type AgentHarnessEvent, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { MEMORY_EMBEDDING_DIM, users } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000bb";

/** state 用 vi.hoisted：vi.mock 会被提升到 import 之上，工厂里不能引用普通顶层变量 */
const state = vi.hoisted(() => ({
  db: undefined as TestDb | undefined,
  apiKey: "test-key",
}));

// 工具里的 getDb() 建的是 node-postgres 连接池，连不到 PGlite，整个模块替身一次
vi.mock("@petrel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/database")>();
  return { ...actual, getDb: () => state.db as unknown as ReturnType<typeof actual.getDb> };
});

vi.mock("@petrel/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@petrel/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      embedding: {
        ...actual.env.embedding,
        get apiKey() {
          return state.apiKey;
        },
      },
    },
  };
});

let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  state.db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
});
afterAll(() => close?.());
beforeEach(async () => {
  state.apiKey = "test-key";
  await reset();
  // 跨用户隔离那条需要第二个用户；记忆表有外键，不能凭空写一个 userId
  await state.db?.insert(users).values({
    id: OTHER_USER_ID,
    email: "other@example.com",
    passwordHash: "!",
  });
});
afterEach(() => vi.unstubAllGlobals());

/** embedding 服务的替身：每次都返回同一个向量，于是任何 query 都能命中任何记忆 */
function stubEmbedding() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: new Array<number>(MEMORY_EMBEDDING_DIM).fill(0.1) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

async function harnessFor(userId: string) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({
    session,
    models,
    model: faux.getModel(),
    toolContext: () => ({ userId, sessionId: SESSION_ID }),
  });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, events };
}

/** 一次「调工具 → 拿结果 → 作答」的完整回合 */
function toolRound(toolName: string, args: Record<string, unknown>) {
  return [
    fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("好的")]),
  ];
}

function toolEnd(events: AgentHarnessEvent[]) {
  return events.filter((event) => event.type === "tool_execution_end");
}

describe("记忆工具跑在真实 agent loop 上", () => {
  it("模型写入的记忆能被自己检索到", async () => {
    stubEmbedding();
    const writer = await harnessFor(TEST_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "用户在做 Petrel 项目" }));
    await writer.harness.prompt("记住我在做 Petrel");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "我在做什么项目" }));
    await reader.harness.prompt("我在做什么项目");

    const end = toolEnd(reader.events).at(0) as { isError: boolean; result: unknown };
    expect(end.isError).toBe(false);
    expect(JSON.stringify(end.result)).toContain("用户在做 Petrel 项目");
  });

  // 这是记忆系统的安全核心
  it("检索不到别人的记忆", async () => {
    stubEmbedding();
    const writer = await harnessFor(OTHER_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "别人的秘密" }));
    await writer.harness.prompt("记住");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "秘密" }));
    await reader.harness.prompt("有什么秘密");

    const end = toolEnd(reader.events).at(0) as { isError: boolean; result: unknown };
    expect(end.isError).toBe(false);
    expect(JSON.stringify(end.result)).not.toContain("别人的秘密");
  });

  /**
   * pi 把 execute() 抛的异常捕获成 isError 的 tool result 并继续跑
   * （agent-loop.js:467-475）。这条同时钉住「工具失败不中断对话」。
   */
  it("embedding 失败时工具报错，但对话不中断", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const { faux, harness, events } = await harnessFor(TEST_USER_ID);
    faux.setResponses(toolRound("memory_search", { query: "任何东西" }));

    await harness.prompt("我是谁");

    const end = toolEnd(events).at(0) as { isError: boolean };
    expect(end.isError).toBe(true);
    // agent loop 照常收尾，模型拿到错误结果后仍然作答了
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  });

  it("检索结果的 JSON 在 content 的文本块里，不是只在 details", async () => {
    stubEmbedding();
    const writer = await harnessFor(TEST_USER_ID);
    writer.faux.setResponses(toolRound("memory_write", { content: "用户偏好简洁的回答" }));
    await writer.harness.prompt("记住");

    const reader = await harnessFor(TEST_USER_ID);
    reader.faux.setResponses(toolRound("memory_search", { query: "偏好" }));
    await reader.harness.prompt("我的偏好");

    // apps/web 的 extractToolResultText() 只读 content 里的 text 块，
    // 只放 details 的话前端会退回空白
    const end = toolEnd(reader.events).at(0) as { result: { content: { text?: string }[] } };
    expect(end.result.content.map((block) => block.text).join("")).toContain("用户偏好简洁的回答");
  });
});

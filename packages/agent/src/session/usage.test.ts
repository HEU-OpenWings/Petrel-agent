import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractFact } from "./usage.ts";

const ENTRY_ID = "00000000-0000-0000-0000-000000000aaa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 一个合法、各字段非零的 usage。固定非零是为了测出「算错但恰好是 0」的 bug。 */
const FULL_USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 20,
  cacheWrite: 10,
  // 故意与四分量之和（180）不一致——测的是「不读 totalTokens」
  totalTokens: 9999,
  cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 1, total: 33 },
};

function assistantEntry(overrides: Partial<Record<string, unknown>> = {}): SessionTreeEntry {
  return {
    type: "message",
    id: ENTRY_ID,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "回答" }],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: FULL_USAGE,
      stopReason: "stop",
      timestamp: 0,
      ...overrides,
    },
  } as unknown as SessionTreeEntry;
}

function compactionEntry(usage?: Usage): SessionTreeEntry {
  return {
    type: "compaction",
    id: ENTRY_ID,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "摘要",
    tokensBefore: 1000,
    fromHook: false,
    usage,
  } as unknown as SessionTreeEntry;
}

describe("extractFact", () => {
  it("assistant 消息提取为 message 事实，totalTokens 由四分量相加（不读 usage.totalTokens）", () => {
    const fact = extractFact(assistantEntry(), USER_ID, SESSION_ID);

    expect(fact).toBeDefined();
    expect(fact).toMatchObject({
      entryId: ENTRY_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
      sourceType: "message",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      api: "openai-responses",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      // 100+50+20+10 = 180，不是 FULL_USAGE.totalTokens 的 9999
      totalTokens: 180,
      costTotal: "33",
    });
  });

  it("compaction 条目提取为 compaction 事实，不带 model/provider/api", () => {
    const fact = extractFact(compactionEntry(FULL_USAGE), USER_ID, SESSION_ID);

    expect(fact).toMatchObject({
      sourceType: "compaction",
      model: undefined,
      provider: undefined,
      api: undefined,
      totalTokens: 180,
    });
  });

  it("user 消息不计 usage（返回 undefined）", () => {
    const entry = {
      type: "message",
      id: ENTRY_ID,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "问题" }], timestamp: 0 },
    } as unknown as SessionTreeEntry;

    expect(extractFact(entry, USER_ID, SESSION_ID)).toBeUndefined();
  });

  it("非 usage-bearing 类型（model_change/leaf/label 等）返回 undefined", () => {
    const types = ["model_change", "leaf", "label", "session_info", "thinking_level_change"];
    for (const type of types) {
      const entry = { type, id: ENTRY_ID, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
      expect(extractFact(entry as SessionTreeEntry, USER_ID, SESSION_ID), `type=${type}`).toBeUndefined();
    }
  });

  it("缺任一字段的 usage 视为不可计量（不伪造 0）", () => {
    // 缺 cost.total
    const noCostTotal = { ...FULL_USAGE, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
    // 缺 cacheWrite
    const noCacheWrite = { input: 1, output: 1, cacheRead: 1, cost: { total: 1 } };

    const asstWithBadUsage = assistantEntry({ usage: noCostTotal });
    expect(extractFact(asstWithBadUsage, USER_ID, SESSION_ID)).toBeUndefined();

    const compactionBad = compactionEntry(noCacheWrite as Usage);
    expect(extractFact(compactionBad, USER_ID, SESSION_ID)).toBeUndefined();

    // usage 为 undefined
    const compactionNoUsage = compactionEntry(undefined);
    expect(extractFact(compactionNoUsage, USER_ID, SESSION_ID)).toBeUndefined();
  });

  it("全零但字段齐全的 usage 仍然可计量（区分「没有 usage」与「usage 全 0」）", () => {
    const zeroUsage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const fact = extractFact(assistantEntry({ usage: zeroUsage }), USER_ID, SESSION_ID);
    expect(fact).toBeDefined();
    expect(fact?.totalTokens).toBe(0);
    expect(fact?.costTotal).toBe("0");
  });

  // issue 的核心坑回归：升级 pi 后若 totalTokens 字段漂移，提取逻辑不能静默归零。
  // 这条钉死「totalTokens 永远来自四分量相加」，与 DB CHECK 约束互为冗余防线。
  it("totalTokens 与 usage.totalTokens 不一致时，采用四分量之和", () => {
    const misleading: Usage = { ...FULL_USAGE, totalTokens: 0 };
    const fact = extractFact(assistantEntry({ usage: misleading }), USER_ID, SESSION_ID);
    // 即使 usage.totalTokens 标 0，提取出的 totalTokens 仍是 180
    expect(fact?.totalTokens).toBe(180);
  });
});

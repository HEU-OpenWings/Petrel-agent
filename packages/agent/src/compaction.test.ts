import { type AgentMessage, InMemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type CompactionPolicy, createCompactionState, maybeCompact } from "./compaction.ts";
import { createHarness } from "./harness.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/**
 * 窗口取 40000：阈值 = 40000 × 0.8 = 32000，而 pi 硬编码的 keepRecentTokens 是 20000。
 * 两者必须留出足够间距，否则压缩「成功」却几乎没切掉东西（回收比例还会撞上
 * ineffective 守卫的 10% 下限）。见 spec §10.1。
 */
const CONTEXT_WINDOW = 40_000;

const POLICY: CompactionPolicy = {
  enabled: true,
  thresholdRatio: 0.8,
  absoluteCap: 1_000_000,
};

/** 1 token ≈ 4 字符（pi 的 estimateTokens 就是 chars/4），所以 4000 字 = 1000 token */
const CHUNK = "一".repeat(4000);

async function fixture() {
  const faux = fauxProvider({
    tokensPerSecond: 10_000,
    models: [{ id: "faux-compaction", contextWindow: CONTEXT_WINDOW, maxTokens: 8192 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const harness = createHarness({ session, models, model: faux.getModel() });
  return { faux, harness, session, state: createCompactionState() };
}

/**
 * 直接往会话树里塞消息，不跑 agent loop。
 *
 * 压缩只读这颗树，所以没必要为了造长会话真的跑几十轮模型调用——
 * 那样一个用例要几秒。
 */
async function fill(session: Session, tokens: number): Promise<void> {
  for (let i = 0; i < tokens / 2000; i++) {
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: CHUNK }],
      timestamp: Date.now(),
    } as AgentMessage);
    // fauxAssistantMessage 的 usage 是全 0，calculateContextTokens 因此返回 0，
    // estimateContextTokens 会退回纯字符估算——测试里正需要这个确定性
    await session.appendMessage(fauxAssistantMessage([fauxText(CHUNK)]));
  }
}

/** 压缩会真的发一次摘要请求，得给 faux 备一条回答 */
function queueSummary(faux: ReturnType<typeof fauxProvider>, text = "## Goal\n测试摘要") {
  faux.setResponses([fauxAssistantMessage([fauxText(text)])]);
}

describe("maybeCompact 阈值判定", () => {
  it("远低于阈值时不压", async () => {
    const { harness, session, state } = await fixture();
    await fill(session, 4000);

    const outcome = await maybeCompact(harness, session, state, POLICY, {});

    expect(outcome).toMatchObject({ kind: "skipped", reason: "below-threshold", overThreshold: false });
  });

  it("超阈值时压缩，buildContextEntries 里出现 compaction 条目且条目数变少", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    queueSummary(faux);
    const before = (await session.buildContextEntries()).length;

    const outcome = await maybeCompact(harness, session, state, POLICY, {});

    expect(outcome.kind).toBe("compacted");
    const after = await session.buildContextEntries();
    expect(after.some((entry) => entry.type === "compaction")).toBe(true);
    expect(after.length).toBeLessThan(before);
  });

  it("absoluteCap 比 window × ratio 更小时，以 cap 为准", async () => {
    const { faux, harness, session, state } = await fixture();
    // window × ratio = 32000，cap = 8000 → 阈值取 8000，10000 token 的会话就该压
    await fill(session, 10_000);
    queueSummary(faux);

    const outcome = await maybeCompact(harness, session, state, { ...POLICY, absoluteCap: 8000 }, {});

    expect(outcome.kind).toBe("compacted");
  });

  it("enabled 为 false 时直接跳过，不看阈值", async () => {
    const { harness, session, state } = await fixture();
    await fill(session, 40_000);

    const outcome = await maybeCompact(harness, session, state, { ...POLICY, enabled: false }, {});

    expect(outcome).toMatchObject({ kind: "skipped", reason: "disabled" });
  });

  /**
   * 这一对是 spec §7.1 那个洞的回归测试。判定发生在 harness.prompt() 之前，
   * 待发消息还不在会话树里；不算进去，一整类可以在请求前避免的爆窗会被推到 (d)，
   * 用户被要求手动重发。Codex 自己也还没修这个洞（turn.rs:159-162 的 TODO）。
   */
  it("待发消息把总量顶过阈值时要压", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 30_000); // 低于阈值 32000
    queueSummary(faux);

    const outcome = await maybeCompact(harness, session, state, POLICY, {
      pendingMessage: "问".repeat(12_000), // 3000 token
    });

    expect(outcome.kind).toBe("compacted");
  });

  it("同一份上下文不传 pendingMessage 时不压", async () => {
    const { harness, session, state } = await fixture();
    await fill(session, 30_000);

    const outcome = await maybeCompact(harness, session, state, POLICY, {});

    expect(outcome).toMatchObject({ kind: "skipped", reason: "below-threshold" });
  });

  it("onPhase 只在真要压时回调一次", async () => {
    const { faux, harness, session, state } = await fixture();
    const phases: string[] = [];

    await fill(session, 4000);
    await maybeCompact(harness, session, state, POLICY, { onPhase: (p) => phases.push(p) });
    // 低于阈值的普通请求一次都不该回调，否则每个请求都会在前端闪一次「正在压缩」
    expect(phases).toEqual([]);

    await fill(session, 40_000);
    queueSummary(faux);
    await maybeCompact(harness, session, state, POLICY, { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["start"]);
  });
});

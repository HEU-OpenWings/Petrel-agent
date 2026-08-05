import { type AgentMessage, InMemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Usage,
} from "@earendil-works/pi-ai";
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
    });
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

describe("maybeCompact 的 nothing-to-compact", () => {
  /**
   * harness.compact() 在「路径为空」或「最后一条已是 compaction 条目」时
   * 抛 AgentHarnessError("compaction", "Nothing to compact")。这是正常结果不是故障：
   * 归到 failed 会让每轮都触发 60s 冷却，把真正需要压缩的会话也一起挡住。
   */
  it("连着压两次，第二次是 skipped/nothing-to-compact 而不是 failed", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n第一次摘要")]),
      fauxAssistantMessage([fauxText("## Goal\n第二次摘要")]),
    ]);

    expect((await maybeCompact(harness, session, state, POLICY, { force: true })).kind).toBe("compacted");
    const second = await maybeCompact(harness, session, state, POLICY, { force: true });

    expect(second).toMatchObject({ kind: "skipped", reason: "nothing-to-compact" });
  });

  /**
   * 验的是「nothing-to-compact 走的是不设冷却的那条分支」，而不是被误归到 failed。
   * Task 3 加这条测试时还没有任何冷却逻辑，那时它必然通过——是空转的，没验证任何
   * 实际行为。Task 4 加上冷却之后它才真正开始验证行为：如果实现把
   * nothing-to-compact 也设了冷却，第三次调用会被 skipped/cooldown 挡住而不是
   * compacted，这条断言才会真的失败。
   *
   * 第三次调用**不能带 `force: true`**：force 会跳过冷却检查那一步，带着它的话
   * 不管冷却有没有被错误设置，第三次都会直接压下去——那样这条测试又会退化成
   * 空转（已用变异验证确认：给 catch 分支加一行无条件 `cooldownUntil = ...` 后，
   * 带 force 的版本仍然通过，摘掉 force 才会真的失败，见 commit 说明）。
   */
  it("nothing-to-compact 不设置冷却", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
    ]);
    await maybeCompact(harness, session, state, POLICY, { force: true });
    await maybeCompact(harness, session, state, POLICY, { force: true });

    // 冷却被误设的话，这里会拿到 skipped/cooldown（不带 force，才会真的过一遍冷却检查）
    await fill(session, 40_000);
    const third = await maybeCompact(harness, session, state, POLICY, {});
    expect(third.kind).toBe("compacted");
  });
});

/** 造一条带真实 usage 的 assistant 消息（fauxAssistantMessage 的 usage 是全 0） */
function withUsage(text: string, totalTokens: number): AgentMessage {
  const usage: Usage = {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return { ...fauxAssistantMessage([fauxText(text)]), usage };
}

describe("maybeCompact 的抗抖动守卫", () => {
  /**
   * 最要紧的一道。压缩后 buildContext() 返回 [摘要, ...retainedTail]，
   * 而 retainedTail 里那些压缩前的 assistant 消息带着「反映压缩前完整上下文」的旧 usage。
   * estimateContextTokens 直接采信它，就会刚压完立刻又判超阈值——每轮都压。
   */
  it("stale-usage：压缩后紧接着再判定一次，不会连压两次", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    // 一条「上下文 90000 token」的旧 usage，压缩后它仍留在 retainedTail 里
    await session.appendMessage(withUsage("旧回答", 90_000));
    faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("## Goal\n不该被用到的第二次摘要")]),
    ]);

    expect((await maybeCompact(harness, session, state, POLICY, {})).kind).toBe("compacted");
    const second = await maybeCompact(harness, session, state, POLICY, {});

    expect(second).toMatchObject({ kind: "skipped", reason: "below-threshold" });
  });

  it("cooldown：摘要失败后 60s 内不再主动压，但 force 能穿透", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    faux.setResponses([
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
      fauxAssistantMessage([fauxText("## Goal\n补上的摘要")]),
    ]);

    const failed = await maybeCompact(harness, session, state, POLICY, {});
    expect(failed.kind).toBe("failed");
    expect(state.cooldownUntil).toBeGreaterThan(Date.now());

    const blocked = await maybeCompact(harness, session, state, POLICY, {});
    expect(blocked).toMatchObject({ kind: "skipped", reason: "cooldown", overThreshold: true });

    // (d) 兜底时上下文已经真的爆了，冷却毫无意义，必须能穿透
    const forced = await maybeCompact(harness, session, state, POLICY, { force: true });
    expect(forced.kind).toBe("compacted");
  });

  /**
   * ineffective 的前后值必须同口径。harness.compact() 返回的 tokensBefore 是
   * usage-based（含 provider 计入的固定开销），而压缩后拿不到新 usage 只能纯估算——
   * 两个数相减会系统性高估回收比例，守卫永不触发。所以单独算一对 pure 值。
   *
   * 补了一条 withUsage 消息（原计划的 fixture 只有 fill()，全是零 usage）：
   * fauxAssistantMessage 的 usage 全 0，harness.compact() 算出的 tokensBefore
   * 在没有任何真实 usage 时会退回纯字符估算——跟 pureBefore 用的是同一个公式，
   * 数值必然相等，这条断言在原 fixture 下无法验证任何东西。塞一条带真实 usage
   * 的消息进去，才能让 usage-based 的 tokensBefore 与纯估算的 pureBefore 真正分叉。
   */
  it("compacted 同时给出 usage-based 与纯估算两对数", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
    await session.appendMessage(withUsage("旧回答", 90_000));
    queueSummary(faux);

    const outcome = await maybeCompact(harness, session, state, POLICY, {});

    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;
    expect(outcome.pureBefore).toBeGreaterThan(outcome.pureAfter);
    // 两对数是不同口径，不该恰好相等——相等说明实现把它们接成了同一个来源
    expect(outcome.pureBefore).not.toBe(outcome.tokensBefore);
  });

  it("ineffective：连续两次回收不足 10% 后停止自动压缩", async () => {
    const { faux, harness, session, state } = await fixture();
    // 直接把状态推到「已经连续两次无效」，避免为了造两次低回收压缩而依赖
    // keepRecentTokens 的精确数值（那是 pi 的内部常量，不该被测试绑死）
    state.ineffectiveStreak = 2;
    await fill(session, 40_000);
    queueSummary(faux);

    const outcome = await maybeCompact(harness, session, state, POLICY, {});

    expect(outcome).toMatchObject({ kind: "skipped", reason: "ineffective", overThreshold: true });
    // 被挡住时一次模型调用都不该发生
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("一次有效压缩把 ineffectiveStreak 清零", async () => {
    const { faux, harness, session, state } = await fixture();
    state.ineffectiveStreak = 1;
    await fill(session, 40_000);
    queueSummary(faux);

    await maybeCompact(harness, session, state, POLICY, {});

    expect(state.ineffectiveStreak).toBe(0);
  });
});

# 上下文自动压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让常驻 harness 在每轮 `prompt()` 之前自动判断上下文是否超阈值，超了先压缩再跑；模型侧上下文变短而用户侧历史一条不少。

**Architecture:** 三层分工。`packages/agent/src/compaction.ts` 是纯策略层（阈值判定、抗抖动守卫、调 `harness.compact()`），pi 的压缩 API 全部关在这里。`apps/server/src/services/harness-registry.ts` 管时机与并发（压缩插在 `send()` 的 prompt 分支之前、`Entry` 上一条 `compaction` promise 做互斥）。`apps/server/src/http/routes/chat.ts` 只把回调翻成 SSE 帧。设计依据见 [spec](../specs/2026-08-05-auto-compaction-design.md)。

**Tech Stack:** TypeScript ESM · Node 24 · pnpm workspace · vitest · `@earendil-works/pi-agent-core@0.83`（pi）· Hono · Vue 3

---

## 阅读须知（动工前必看）

1. **不要凭文档记忆用 pi 的 API。** spec §2 列了 14 条核对过 dist 的实际行为，本计划里的代码依赖它们。特别是：`harness.compact()` 要求 `phase === "idle"`；`phase` 是私有字段没有 getter；`compact()` 不发 `agent_start`；压缩期间 `followUp()` 不抛错但消息会被静默吞掉。
2. **跑测试一律加 `--exclude '**/.claude/**'`**，否则 vitest 会把 `.claude/worktrees/` 里的旧副本一起跑掉，报一批与当前代码无关的失败（CLAUDE.md 坑 16）。
3. **Git Bash 里跑 pnpm 前先 `export PATH="/c/Program Files/nodejs:$PATH"`**，否则报 `'node' is not recognized`，每个新 shell 都要重做一次。
4. **仓库统一 LF**，不要引入 CRLF（会和 Biome 冲突）。
5. 提交信息用中文，与仓库现有风格一致。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `packages/config/src/index.ts` | 修改 | 加 `compaction` 三项配置与严格校验 |
| `packages/config/src/index.test.ts` | 修改 | 三项配置的合法/非法值单测 |
| `packages/agent/src/compaction.ts` | **新建** | 阈值判定 + 三道守卫 + 调 `harness.compact()` + `isContextOverflow`。pi 压缩 API 只在这里出现 |
| `packages/agent/src/compaction.test.ts` | **新建** | faux provider + 内存 session，不碰数据库 |
| `packages/agent/src/index.ts` | 修改 | 转导出 `maybeCompact` / `isContextOverflow` / 相关类型 |
| `apps/server/src/services/harness-registry.ts` | 修改 | `Entry` 加 `compaction` / `compactionState` / `abortRequested` / `retired`；`send()` 插入压缩；`abort()` 与 `evict()` 纳入互斥；(d) 兜底 |
| `apps/server/src/services/harness-registry.test.ts` | 修改 | 并发、回收、abort、evict、(d) 文案 |
| `apps/server/src/http/routes/chat.ts` | 修改 | `onNotice` → `event: compaction` 帧 |
| `apps/server/src/http/routes/chat.test.ts` | 修改 | SSE 帧形状 + transcript 一条不少 + 零噪音 |
| `apps/web/src/composables/useAgentStream.js` | 修改 | 认 `event: compaction`，归约 `compacting` 与压缩标记 |
| `apps/web/src/components/chat/CompactionDivider.vue` | **新建** | 分隔线式压缩提示 |
| `apps/web/src/views/ChatView.vue` | 修改 | 在消息列表里渲染压缩标记（**注意是这个文件，不是 `AgentChatComponent.vue`**——后者是 v0.4 遗留的待删旧对话代码，v0.5 的对话界面是 `ChatView.vue`） |
| `CLAUDE.md` | 修改 | 补两条踩过的坑 |

拆分依据：策略（token 数学）与时机（并发）是两件会分别演化的事——阈值调优不该碰并发代码，反之亦然。`compaction.ts` 单独一个文件而不是塞进 `harness.ts`，因为 `harness.ts` 是装配代码，压缩是运行期策略。

---

## Task 1: 配置项与严格校验

**Files:**
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/index.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/config/src/index.test.ts` 末尾：

```ts
describe("compaction", () => {
  it("默认值：开启、0.8、120000", async () => {
    const { env } = await loadEnv({
      COMPACTION_ENABLED: undefined,
      COMPACTION_THRESHOLD_RATIO: undefined,
      COMPACTION_ABSOLUTE_CAP: undefined,
    });
    expect(env.compaction).toEqual({ enabled: true, thresholdRatio: 0.8, absoluteCap: 120_000 });
  });

  it("显式合法值被采用", async () => {
    const { env } = await loadEnv({
      COMPACTION_ENABLED: "false",
      COMPACTION_THRESHOLD_RATIO: "0.5",
      COMPACTION_ABSOLUTE_CAP: "60000",
    });
    expect(env.compaction).toEqual({ enabled: false, thresholdRatio: 0.5, absoluteCap: 60_000 });
  });

  // 非法值一律启动即失败。悄悄回落到默认值的后果是「永不压缩」或「每轮都压」，
  // 而且没有任何报错指向配置
  it.each(["yes", "1", "TRUE", "0"])("COMPACTION_ENABLED 非布尔字符串抛错：%s", async (raw) => {
    await expect(loadEnv({ COMPACTION_ENABLED: raw })).rejects.toThrow("COMPACTION_ENABLED");
  });

  it.each(["0", "1", "1.5", "-0.2", "abc", "NaN"])(
    "COMPACTION_THRESHOLD_RATIO 越界或非数抛错：%s",
    async (raw) => {
      await expect(loadEnv({ COMPACTION_THRESHOLD_RATIO: raw })).rejects.toThrow(
        "COMPACTION_THRESHOLD_RATIO",
      );
    },
  );

  it.each(["0", "-1", "1.5", "abc"])("COMPACTION_ABSOLUTE_CAP 非正整数抛错：%s", async (raw) => {
    await expect(loadEnv({ COMPACTION_ABSOLUTE_CAP: raw })).rejects.toThrow(
      "COMPACTION_ABSOLUTE_CAP",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm vitest run packages/config/src/index.test.ts --exclude '**/.claude/**'
```

预期：`compaction` 那一组全部 FAIL，报 `env.compaction` 是 `undefined`。

- [ ] **Step 3: 实现**

在 `packages/config/src/index.ts` 的 `jwtSecret` 函数**之前**插入三个校验函数（放在其他校验函数旁边，与 `oneOf` / `port` 同组）：

```ts
/**
 * 严格布尔。只认 "true" / "false"：接受 "1" / "yes" 这类写法会让
 * `COMPACTION_ENABLED=0`（作者以为是关）被当成 truthy 字符串静默开启。
 */
function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") {
    throw new Error(`环境变量 ${name} 非法：${raw}，只接受 true | false`);
  }
  return raw === "true";
}

/** 开区间比例。0 会让每轮都尝试压缩，1 会让压缩永不触发，两端都必须挡住 */
function ratio(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为 0 与 1 之间（不含两端）的小数`);
  }
  return value;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为正整数`);
  }
  return value;
}
```

在 `export const env = {` 里、`adminEmails` 那一行之后追加：

```ts
  /**
   * 上下文自动压缩。阈值 = min(模型 contextWindow × thresholdRatio, absoluteCap)。
   *
   * absoluteCap 存在的理由不是防爆窗，而是控成本与延迟：默认模型窗口 1_000_000，
   * 0.8 就是 80 万 token，一次请求又慢又贵。对 64k 的备选模型这个上限不起作用
   * （51.2k < 120000），所以两个数各管一头。见 docs/superpowers/specs/2026-08-05-auto-compaction-design.md §7
   */
  compaction: {
    enabled: bool("COMPACTION_ENABLED", process.env.COMPACTION_ENABLED, true),
    thresholdRatio: ratio("COMPACTION_THRESHOLD_RATIO", process.env.COMPACTION_THRESHOLD_RATIO, 0.8),
    absoluteCap: positiveInt(
      "COMPACTION_ABSOLUTE_CAP",
      process.env.COMPACTION_ABSOLUTE_CAP,
      120_000,
    ),
  },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/config/src/index.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 同步 .env.template**

在 `.env.template` 末尾追加（保持与现有键的注释风格一致）：

```
# 上下文自动压缩。阈值 = min(模型 contextWindow × RATIO, CAP)
# 非法值会让进程启动失败，不会静默回落
COMPACTION_ENABLED=true
COMPACTION_THRESHOLD_RATIO=0.8
COMPACTION_ABSOLUTE_CAP=120000
```

- [ ] **Step 6: 提交**

```bash
git add packages/config/src/index.ts packages/config/src/index.test.ts .env.template
git commit -m "feat(config): 上下文压缩的三项配置与严格校验

非法值一律启动即失败：悄悄回落的后果是「永不压缩」或「每轮都压」，
而且没有任何报错指向配置。"
```

---

## Task 2: 阈值判定（含 pendingMessage）

**Files:**
- Create: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/compaction.test.ts`

这一步只做「判定 + 调 compact」的主干，守卫在 Task 3/4 加。

- [ ] **Step 1: 写失败的测试**

新建 `packages/agent/src/compaction.test.ts`：

```ts
import { type AgentMessage, InMemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts --exclude '**/.claude/**'
```

预期：整个文件 FAIL，报 `Failed to resolve import "./compaction.ts"`。

- [ ] **Step 3: 实现**

新建 `packages/agent/src/compaction.ts`：

```ts
import {
  type AgentHarness,
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  type Session,
} from "@earendil-works/pi-agent-core";

/**
 * 阈值策略。
 *
 * 刻意不复用 pi 的 shouldCompact()：它是 `tokens > window - settings.reserveTokens`，
 * 要用就得伪造一个 { enabled, reserveTokens: 0, keepRecentTokens: 0 } 的假 settings，
 * 比自己写一行比较更难读。
 */
export interface CompactionPolicy {
  enabled: boolean;
  /** 占模型 contextWindow 的比例，0 < ratio < 1 */
  thresholdRatio: number;
  /** 绝对上限，控成本与延迟 */
  absoluteCap: number;
  /** 追加给 pi 摘要提示词的 customInstructions（拼成 `Additional focus: ...`） */
  summaryInstructions?: string;
}

export type CompactionSkipReason =
  | "disabled"
  | "below-threshold"
  | "nothing-to-compact"
  | "cooldown"
  | "ineffective";

export type CompactionOutcome =
  | { kind: "skipped"; reason: CompactionSkipReason; overThreshold: boolean }
  | {
      kind: "compacted";
      /** usage-based 估算，给埋点与前端展示 */
      tokensBefore: number;
      tokensAfter: number;
      /** 纯字符估算，只给 ineffective 守卫用，见 Task 4 的注释 */
      pureBefore: number;
      pureAfter: number;
    }
  | { kind: "failed"; error: Error };

/**
 * 抗抖动状态。由调用方持有（registry 的 Entry），生命周期必须与 harness 实例严格一致：
 * 放在本模块的全局 Map 里会泄漏到已被淘汰的会话。
 */
export interface CompactionState {
  /** 冷却截止时间戳（毫秒）；0 表示不在冷却中 */
  cooldownUntil: number;
  /** 连续「回收不足 10%」的次数 */
  ineffectiveStreak: number;
}

export function createCompactionState(): CompactionState {
  return { cooldownUntil: 0, ineffectiveStreak: 0 };
}

export interface MaybeCompactOptions {
  /**
   * 本轮即将 prompt 的用户消息。
   *
   * 必须算进阈值：判定发生在 harness.prompt() 之前，这条消息还没进会话树，
   * buildContext() 里看不到它。漏算会把一整类可以在请求前避免的爆窗推到 (d)。
   */
  pendingMessage?: string;
  /** (d) overflow 兜底：无视阈值与 cooldown */
  force?: boolean;
  /**
   * 同步生命周期回调。只在阈值判定通过、即将调 harness.compact() 时发 "start"——
   * 提前发的话每个低于阈值的普通请求都会在前端闪一次「正在压缩」。
   */
  onPhase?: (phase: "start") => void;
}

/** 纯字符估算，绕开 provider usage。压缩前后要用同一种口径比较，见 Task 4 */
function pureEstimate(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** 待发消息折成一条 user 消息来估算，口径与历史消息一致 */
function pendingTokens(pendingMessage: string | undefined): number {
  if (!pendingMessage) return 0;
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text: pendingMessage }],
    timestamp: Date.now(),
  } as AgentMessage);
}

export function effectiveWindow(contextWindow: number, policy: CompactionPolicy): number {
  return Math.min(contextWindow * policy.thresholdRatio, policy.absoluteCap);
}

/**
 * 超阈值就压缩，否则原样返回。**要求 harness 处于 idle**——pi 的 compact() 会检查
 * phase，并发保护由调用方负责（见 harness-registry 的 Entry.compaction）。
 */
export async function maybeCompact(
  harness: AgentHarness,
  session: Session,
  state: CompactionState,
  policy: CompactionPolicy,
  options: MaybeCompactOptions,
): Promise<CompactionOutcome> {
  if (!policy.enabled && !options.force) {
    return { kind: "skipped", reason: "disabled", overThreshold: false };
  }

  const context = await session.buildContext();
  const messages = context.messages;
  const tokens = estimateContextTokens(messages).tokens + pendingTokens(options.pendingMessage);
  const limit = effectiveWindow(harness.getModel().contextWindow, policy);
  const overThreshold = tokens > limit;

  if (!overThreshold && !options.force) {
    return { kind: "skipped", reason: "below-threshold", overThreshold: false };
  }

  options.onPhase?.("start");
  const pureBefore = pureEstimate(messages);
  const result = await harness.compact(policy.summaryInstructions);
  const after = await session.buildContext();
  return {
    kind: "compacted",
    tokensBefore: result.tokensBefore,
    tokensAfter: estimateContextTokens(after.messages).tokens,
    pureBefore,
    pureAfter: pureEstimate(after.messages),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts --exclude '**/.claude/**'
```

预期：`maybeCompact 阈值判定` 全部 PASS。

若「超阈值时压缩」那条失败并报 `Nothing to compact`，说明 `fill()` 造的会话不够长——检查 `CHUNK` 是不是 4000 字、循环次数对不对。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/compaction.ts packages/agent/src/compaction.test.ts
git commit -m "feat(agent): 上下文压缩的阈值判定

阈值 = min(contextWindow × ratio, absoluteCap)，并把本轮待发消息算进去——
判定在 prompt() 之前，那条消息还不在会话树里，漏算会把一整类可避免的
爆窗推到被动兜底。"
```

---

## Task 3: `nothing-to-compact` 归类

**Files:**
- Modify: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/compaction.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/agent/src/compaction.test.ts`：

```ts
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

    expect((await maybeCompact(harness, session, state, POLICY, { force: true })).kind).toBe(
      "compacted",
    );
    const second = await maybeCompact(harness, session, state, POLICY, { force: true });

    expect(second).toMatchObject({ kind: "skipped", reason: "nothing-to-compact" });
  });

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

    // 冷却被误设的话，这里会拿到 skipped/cooldown
    await fill(session, 40_000);
    const third = await maybeCompact(harness, session, state, POLICY, { force: true });
    expect(third.kind).toBe("compacted");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts -t "nothing-to-compact" --exclude '**/.claude/**'
```

预期：FAIL——`harness.compact()` 抛出的错误现在没人接，用例以 `Nothing to compact` 异常告终。

- [ ] **Step 3: 实现**

在 `packages/agent/src/compaction.ts` 顶部的 import 里加入 `AgentHarnessError`：

```ts
import {
  type AgentHarness,
  AgentHarnessError,
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  type Session,
} from "@earendil-works/pi-agent-core";
```

在 `pureEstimate` 之前加一个判定函数：

```ts
/**
 * 「没东西可压」的识别。
 *
 * 只能靠 message 文本匹配：pi 抛的是 AgentHarnessError("compaction", "Nothing to compact")，
 * 而 code "compaction" 同时覆盖真正的摘要失败，光看 code 分不开两者
 * （`agent-harness.js:654`）。pi 升级时这条要重新核对。
 */
function isNothingToCompact(error: unknown): boolean {
  return error instanceof AgentHarnessError && error.message === "Nothing to compact";
}
```

把 `maybeCompact` 末尾那段 `harness.compact()` 调用包进 try/catch：

```ts
  options.onPhase?.("start");
  const pureBefore = pureEstimate(messages);
  try {
    const result = await harness.compact(policy.summaryInstructions);
    const after = await session.buildContext();
    return {
      kind: "compacted",
      tokensBefore: result.tokensBefore,
      tokensAfter: estimateContextTokens(after.messages).tokens,
      pureBefore,
      pureAfter: pureEstimate(after.messages),
    };
  } catch (error) {
    if (isNothingToCompact(error)) {
      return { kind: "skipped", reason: "nothing-to-compact", overThreshold };
    }
    throw error;
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/compaction.ts packages/agent/src/compaction.test.ts
git commit -m "feat(agent): 把 Nothing to compact 归到 skipped 而非 failed

否则短会话每轮都被记成失败并触发冷却，把真正需要压缩的会话一起挡住。"
```

---

## Task 4: 三道守卫（stale-usage / cooldown / ineffective）

**Files:**
- Modify: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/compaction.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/agent/src/compaction.test.ts`。注意文件顶部的 import 要补 `type Usage`：

```ts
import type { Usage } from "@earendil-works/pi-ai";
```

```ts
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
  return { ...fauxAssistantMessage([fauxText(text)]), usage } as AgentMessage;
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
   */
  it("compacted 同时给出 usage-based 与纯估算两对数", async () => {
    const { faux, harness, session, state } = await fixture();
    await fill(session, 40_000);
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts -t "抗抖动" --exclude '**/.claude/**'
```

预期：五条全部 FAIL（`state.cooldownUntil` 不变、`reason` 不是 `cooldown` / `ineffective`、第二次压缩被执行）。

- [ ] **Step 3: 实现**

在 `packages/agent/src/compaction.ts` 里加两个常量与两个辅助函数，并改写 `maybeCompact`。

顶部 import 补 `type SessionTreeEntry`：

```ts
import {
  type AgentHarness,
  AgentHarnessError,
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  type Session,
} from "@earendil-works/pi-agent-core";
```

常量与辅助函数（放在 `createCompactionState` 之后）：

```ts
/**
 * 摘要失败后的冷却时长。
 *
 * Hermes 用 600s，我们取 60s：harness 实例本身 5 分钟就被 idle TTL 回收、
 * 状态跟着消失，太长的冷却在这里没有意义，60s 足够躲过一波限流。
 */
const COOLDOWN_MS = 60_000;

/** 连续多少次「回收不足 REQUIRED_RECLAIM_RATIO」后停止自动压缩 */
const INEFFECTIVE_LIMIT = 2;

/** 一次压缩至少要回收掉这么大比例才算有效 */
const REQUIRED_RECLAIM_RATIO = 0.1;

/**
 * 判定用的 token 数。
 *
 * estimateContextTokens 取「最后一条 assistant 的真实 usage + 之后消息的字符估算」，
 * 但压缩后 retainedTail 里的旧 assistant 消息带的是压缩前的 usage，采信它就会
 * 刚压完又判超阈值。所以：提供 usage 的那条消息若早于最近一条 compaction 条目，
 * 整个 usage 分量作废，退回纯字符估算。
 *
 * 比 pi CLI 的「直接不压」更准——纯估算下 retainedTail 本身就超阈值的情况真实存在，
 * 那种时候应该压。
 */
async function estimateForDecision(session: Session, messages: AgentMessage[]): Promise<number> {
  const estimate = estimateContextTokens(messages);
  if (estimate.lastUsageIndex === null) return estimate.tokens;

  const compactions = await session.findEntries("compaction");
  const latest = compactions.at(-1);
  if (!latest) return estimate.tokens;

  const usageMessage = messages[estimate.lastUsageIndex];
  const usageTimestamp = (usageMessage as { timestamp?: number }).timestamp ?? 0;
  if (usageTimestamp > Date.parse(latest.timestamp)) return estimate.tokens;

  return pureEstimate(messages);
}
```

改写 `maybeCompact` 的判定段与执行段：

```ts
export async function maybeCompact(
  harness: AgentHarness,
  session: Session,
  state: CompactionState,
  policy: CompactionPolicy,
  options: MaybeCompactOptions,
): Promise<CompactionOutcome> {
  if (!policy.enabled && !options.force) {
    return { kind: "skipped", reason: "disabled", overThreshold: false };
  }

  const context = await session.buildContext();
  const messages = context.messages;
  const tokens =
    (await estimateForDecision(session, messages)) + pendingTokens(options.pendingMessage);
  const limit = effectiveWindow(harness.getModel().contextWindow, policy);
  const overThreshold = tokens > limit;

  if (!overThreshold && !options.force) {
    return { kind: "skipped", reason: "below-threshold", overThreshold: false };
  }

  // 下面两道守卫只挡主动压缩。(d) 兜底（force）时上下文已经真的爆了，
  // 挡住它只会让用户彻底没救
  if (!options.force) {
    if (Date.now() < state.cooldownUntil) {
      return { kind: "skipped", reason: "cooldown", overThreshold };
    }
    if (state.ineffectiveStreak >= INEFFECTIVE_LIMIT) {
      return { kind: "skipped", reason: "ineffective", overThreshold };
    }
  }

  options.onPhase?.("start");
  const pureBefore = pureEstimate(messages);
  try {
    const result = await harness.compact(policy.summaryInstructions);
    const after = await session.buildContext();
    const pureAfter = pureEstimate(after.messages);
    // 同口径比较。混用 usage-based 的 tokensBefore 与纯估算的 pureAfter
    // 会系统性高估回收比例，这道守卫就永远不触发
    const reclaimed = pureBefore > 0 ? (pureBefore - pureAfter) / pureBefore : 0;
    state.ineffectiveStreak = reclaimed < REQUIRED_RECLAIM_RATIO ? state.ineffectiveStreak + 1 : 0;
    return {
      kind: "compacted",
      tokensBefore: result.tokensBefore,
      tokensAfter: estimateContextTokens(after.messages).tokens,
      pureBefore,
      pureAfter,
    };
  } catch (error) {
    if (isNothingToCompact(error)) {
      // 正常结果，不设冷却
      return { kind: "skipped", reason: "nothing-to-compact", overThreshold };
    }
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/compaction.ts packages/agent/src/compaction.test.ts
git commit -m "feat(agent): 三道抗抖动守卫

stale-usage 是最要紧的一道：压缩后 retainedTail 里的旧 assistant 消息
带着压缩前的 usage，采信它会导致每轮都压。
ineffective 的前后值用同一种纯字符估算口径——混用 usage-based 的
tokensBefore 会高估回收比例，守卫永不触发。"
```

---

## Task 5: `isContextOverflow`

**Files:**
- Modify: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/compaction.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/agent/src/compaction.test.ts`（并把 `isContextOverflow` 加进顶部 import）：

```ts
describe("isContextOverflow", () => {
  /**
   * 检测点是 prompt() 的返回值：pi 在模型调用失败时既不抛异常也不发 error 事件，
   * 而是把原因写进 assistant 消息的 errorMessage（stopReason: "error"）。
   * 见 CLAUDE.md「消费 pi AgentEvent 的硬约束」第 3 条。
   */
  it.each([
    "This model's maximum context length is 65536 tokens",
    "context_length_exceeded",
    "Too many tokens in request",
    "MAXIMUM CONTEXT exceeded",
  ])("errorMessage 命中关键词：%s", async (errorMessage) => {
    const { harness } = await fixture();
    const message = fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage });

    expect(isContextOverflow(harness, message)).toBe(true);
  });

  it("usage.input 超过 contextWindow 时命中，即使 errorMessage 没有关键词", async () => {
    const { harness } = await fixture();
    const message = {
      ...fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "500 oops" }),
      usage: {
        input: CONTEXT_WINDOW + 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: CONTEXT_WINDOW + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } satisfies Usage,
    };

    expect(isContextOverflow(harness, message)).toBe(true);
  });

  it("普通错误不命中", async () => {
    const { harness } = await fixture();
    const message = fauxAssistantMessage([fauxText("")], {
      stopReason: "error",
      errorMessage: "connection reset by peer",
    });

    expect(isContextOverflow(harness, message)).toBe(false);
  });

  it("成功的回答不命中", async () => {
    const { harness } = await fixture();

    expect(isContextOverflow(harness, fauxAssistantMessage([fauxText("正常回答")]))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts -t "isContextOverflow" --exclude '**/.claude/**'
```

预期：FAIL，报 `isContextOverflow is not a function`。

- [ ] **Step 3: 实现**

在 `packages/agent/src/compaction.ts` 末尾追加。import 补 `type AssistantMessage`（来自 `@earendil-works/pi-ai`）：

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
```

```ts
/**
 * 各家 provider 报「上下文超窗口」的说法不统一，只能关键词匹配。
 * 全部小写后比对，新 provider 出现新说法时往这里加。
 */
const OVERFLOW_PATTERNS = [
  "context length",
  "context_length_exceeded",
  "too many tokens",
  "maximum context",
] as const;

/**
 * 这条失败的 assistant 消息是不是撞了模型的上下文窗口？
 *
 * 吃 harness 而不是 contextWindow：窗口从 harness.getModel() 读，这样 apps/server
 * 不必碰 pi 的 Model 类型（依赖方向是 server → agent，pi 接线只在 agent 与 ai）。
 */
export function isContextOverflow(harness: AgentHarness, message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;

  const text = (message.errorMessage ?? "").toLowerCase();
  if (OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern))) return true;

  // 关键词兜不住的情况：有的 provider 只回一个通用错误，但 usage 已经把
  // 超窗口的事实摆出来了（pi-ai 的 utils/overflow.ts 也是这个思路）
  const input = message.usage?.input ?? 0;
  return input > harness.getModel().contextWindow;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run packages/agent/src/compaction.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/compaction.ts packages/agent/src/compaction.test.ts
git commit -m "feat(agent): isContextOverflow 识别撞窗口的失败回答

pi 模型调用失败不抛异常也不发 error 事件，原因写在 assistant 消息的
errorMessage 里，所以检测点是 prompt() 的返回值。"
```

---

## Task 6: 从 `@petrel/agent` 转导出

**Files:**
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: 实现**

`packages/agent/src/index.ts` 里，在 `export { ... } from "./harness.ts";` **之前**插入：

```ts
export {
  type CompactionOutcome,
  type CompactionPolicy,
  type CompactionSkipReason,
  type CompactionState,
  createCompactionState,
  effectiveWindow,
  isContextOverflow,
  type MaybeCompactOptions,
  maybeCompact,
} from "./compaction.ts";
```

- [ ] **Step 2: 验证类型能被上层解析**

```bash
pnpm run typecheck
```

预期：全部包 PASS。若 `apps/server` 报找不到 `maybeCompact`，检查 `vitest.config.ts` 与 `tsconfig.base.json` 的 `@petrel/agent` 别名——它们指向 `src/index.ts`，新增导出无需改别名，但 `tsc` 缓存可能需要重跑。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/index.ts
git commit -m "feat(agent): 转导出压缩策略给 apps/server

上层只依赖 @petrel/agent，不直接 import @earendil-works/*。"
```

---

## Task 7: registry 接入压缩（时机与互斥）

**Files:**
- Modify: `apps/server/src/services/harness-registry.ts`
- Test: `apps/server/src/services/harness-registry.test.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server/src/services/harness-registry.test.ts` 顶部 import 改成：

```ts
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createHarness, createMemorySession, resolveModel } from "@petrel/agent";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// HarnessNotice 定义在 registry 自己这里（它是 registry 与 route 之间的契约，
// 不是 agent 包的概念），所以从本地模块导入，不是从 @petrel/agent
import {
  createHarnessRegistry,
  type HarnessNotice,
  HarnessRegistryError,
} from "./harness-registry.ts";
```

在 `fauxFactory` 之后追加一个能造超阈值会话的工厂与用例：

```ts
/**
 * 造一个「窗口很小、且会话已经超阈值」的实例，用来触发压缩。
 *
 * 窗口取 40000（阈值 32000）而不是更小：pi 硬编码 keepRecentTokens = 20000，
 * 阈值离它太近的话压缩几乎切不掉东西。见 spec §10.1。
 */
function compactionFactory() {
  const faux = fauxProvider({
    tokensPerSecond: 10_000,
    models: [{ id: "faux-compaction", contextWindow: 40_000, maxTokens: 8192 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const chunk = "一".repeat(4000);
  return {
    faux,
    async create(sessionId: string) {
      const session = await createMemorySession(sessionId);
      for (let i = 0; i < 20; i++) {
        await session.appendMessage({
          role: "user",
          content: [{ type: "text", text: chunk }],
          timestamp: Date.now(),
        } as never);
        await session.appendMessage(fauxAssistantMessage([fauxText(chunk)]));
      }
      return { harness: createHarness({ session, models, model: faux.getModel() }), session };
    },
  };
}

describe("createHarnessRegistry 的自动压缩", () => {
  it("超阈值时先压缩再 prompt，并发出 start/end 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices.map((n) => n.phase)).toEqual(["start", "end"]);
    expect(notices[1]).toMatchObject({ phase: "end", outcome: { kind: "compacted" } });
    const entries = await handle.session.buildContextEntries();
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
  });

  it("低于阈值的普通请求不产生任何通知", async () => {
    const factory = fauxFactory();
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "你好");
    const notices: HarnessNotice[] = [];

    await handle.send("你好", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices).toEqual([]);
  });

  /**
   * 这条是本设计最贵的一条不变量。压缩期间 phase === "compaction"：
   * prompt() 会抛 busy，而 followUp() 不抛却会把消息 push 进一个没人消费的队列
   * （waitForIdle 立刻返回），表现为「消息永久消失且没有任何报错」。
   * 所以第二个请求必须被挡在临界区外等压缩结束。
   */
  it("压缩期间的第二个请求排队等待，消息不丢也不抛 busy", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");

    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题");
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    handle.release();

    const text = JSON.stringify(await handle.session.getEntries());
    expect(text).toContain("第一个问题");
    expect(text).toContain("第二个问题");
  });

  it("压缩期间不被 idle 回收", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    factory.faux.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const time = clock();
    const registry = createHarnessRegistry({
      db,
      createHarness: factory.create,
      now: time.now,
      idleTtlMs: 1000,
    });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    handle.release(); // refCount 归零，只剩 compaction 标记护着
    time.advance(10_000);
    // 压缩期间 running 是 false（compact() 不发 agent_start），
    // 只看 running 的话这个实例会被 sweep 掉，而压缩还在往它的树上写
    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    releaseSummary();
    await sending;
    second.release();

    expect(second.harness).toBe(handle.harness);
  });

  it("两个 send 几乎同时发起时，等待者也收到 start 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答一")]),
      fauxAssistantMessage([fauxText("回答二")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "第一个问题");
    const waiterNotices: HarnessNotice[] = [];

    // 第二个 send 同步紧跟第一个：此时第一个还没进到「设置 held.compaction」那一步，
    // 所以 send() 开头那次同步读拿不到标记，必须靠临界区里的补发
    const first = handle.send("第一个问题");
    const second = handle.send("第二个问题", {
      onNotice: (notice) => waiterNotices.push(notice),
    });
    await Promise.all([first, second]);
    handle.release();

    expect(waiterNotices.some((notice) => notice.phase === "start")).toBe(true);
  });

  it("压缩失败不阻断本轮，照常 prompt", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      // 摘要请求失败
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
      // 本轮的正常回答仍要发生
      fauxAssistantMessage([fauxText("尽管压缩失败了，这句回答还是要有")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    expect(notices.at(-1)).toMatchObject({ phase: "end", outcome: { kind: "failed" } });
    // 阈值是 80%，压不成也还有余量；真超了会落到 (d)。绝不能因为压缩失败就丢用户消息
    expect(JSON.stringify(await handle.session.getEntries())).toContain(
      "尽管压缩失败了，这句回答还是要有",
    );
  });

  it("守卫挡住但确实超阈值时发 blocked 通知", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([fauxAssistantMessage([fauxText("回答")])]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    const notices: HarnessNotice[] = [];

    // 直接把实例的抗抖动状态推到「连续两次无效」。没有别的入口能拿到 Entry，
    // 但 send() 之后 handle 上的 harness 与 registry 里的是同一个实例，
    // 所以这里改的是同一份状态——registry 需要暴露一个只给测试用的取状态方法：
    // 见实现步骤里 __stateForTest 的说明
    registry.__stateForTest(SESSION_ID)!.ineffectiveStreak = 2;
    await handle.send("问题", { onNotice: (notice) => notices.push(notice) });
    handle.release();

    // 没有 start：onPhase 在 maybeCompact 里、三道守卫**之后**才回调，
    // 被挡住的那次压缩压根没开始，不该让前端闪一下「正在压缩」
    expect(notices).toEqual([{ phase: "blocked", reason: "ineffective" }]);
    expect(JSON.stringify(await handle.session.getEntries())).toContain("回答");
  });

  it("压缩期间 abort 后不再发起 prompt", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    factory.faux.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("不该出现的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    // pi 的 compact() 内部 signal 永远不会被 abort，所以压缩本身停不下来；
    // abort 能保证的只有「压完不再跑新一轮」
    await registry.abort(SESSION_ID, TEST_USER_ID);
    releaseSummary();
    await sending;
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).not.toContain("不该出现的回答");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts -t "自动压缩" --exclude '**/.claude/**'
```

预期：全部 FAIL——`send()` 还不接第二个参数，`HarnessNotice` 类型不存在。

- [ ] **Step 3: 实现**

在 `apps/server/src/services/harness-registry.ts` 顶部 import 里补上压缩相关：

```ts
import type { AgentHarness, CompactionOutcome, CompactionState, Session } from "@petrel/agent";
import {
  createCompactionState,
  createMemorySession,
  createPgSession,
  createHarness as createRealHarness,
  DEFAULT_SYSTEM_PROMPT,
  isContextOverflow,
  maybeCompact,
  resolveModel,
} from "@petrel/agent";
import { env } from "@petrel/config";
```

在 `HarnessRegistryError` 之后加通知类型与摘要指令常量：

```ts
/**
 * 压缩过程的可见信号。pi 只在压缩**结束**时发 session_compact（带摘要正文），
 * 「开始 / 失败 / 被守卫挡住」这三个信号它不给，只能我们自己发。
 */
export type HarnessNotice =
  | { phase: "start" }
  | { phase: "end"; outcome: CompactionOutcome }
  | { phase: "blocked"; reason: string };

/**
 * 追加给 pi 摘要提示词的 customInstructions。
 *
 * pi 库层已带一份完整的 7 段英文提示词（## Goal / ## Progress / ## Next Steps …），
 * 质量足够，这里只补「用中文」这一条要求，不接管整条摘要链路。
 */
const SUMMARY_INSTRUCTIONS =
  "用中文输出摘要；文件路径、函数名、错误信息原样保留不译。";
```

`Entry` 接口追加四个字段（放在 `running` 之后）：

```ts
  /**
   * 正在进行的压缩。非 undefined 即「正在压缩」。
   *
   * 一个字段三用：进临界区要 await 它、sweep()/evictOldestIdle() 视为忙、
   * abort()/evict() 靠它判断。不用额外的布尔量。
   */
  compaction: Promise<CompactionOutcome> | undefined;
  /** 抗抖动状态。跟随实例生命周期——实例被淘汰时状态跟着消失 */
  compactionState: CompactionState;
  /** 压缩期间收到 abort：压完之后不再发起新一轮 */
  abortRequested: boolean;
  /** 已被 evict（会话删除 / 用户禁用）：压完之后一律不再 prompt */
  retired: boolean;
```

`build()` 里构造 `Entry` 的字面量追加：

```ts
      compaction: undefined,
      compactionState: createCompactionState(),
      abortRequested: false,
      retired: false,
```

`sweep()` 与 `evictOldestIdle()` 的空闲判定都要带上 `compaction`：

```ts
  function sweep(): void {
    for (const [sessionId, entry] of entries) {
      // 压缩期间 running 是 false（compact() 不发 agent_start），只看 running
      // 会把正在压缩的实例回收掉，而压缩还在往它的树上写
      if (
        entry.refCount === 0 &&
        !entry.running &&
        !entry.compaction &&
        now() - entry.lastUsedAt > idleTtlMs
      ) {
        entries.delete(sessionId);
      }
    }
  }
```

```ts
    for (const pair of entries) {
      const [, entry] = pair;
      if (entry.refCount > 0 || entry.running || entry.compaction) continue;
      if (!oldest || entry.lastUsedAt < oldest[1].lastUsedAt) oldest = pair;
    }
```

`HarnessHandle` 的 `send` 签名改成：

```ts
export interface SendOptions {
  /** 同步回调，调用方（SSE 路由）负责把它变成帧。绝不能在里面做网络 I/O */
  onNotice?: (notice: HarnessNotice) => void;
}

export interface HarnessHandle {
  harness: AgentHarness;
  session: Session;
  /** 空闲则（必要时先压缩再）prompt，运行中则排进 followUp 队列。 */
  send(message: string, options?: SendOptions): Promise<void>;
  release(): void;
}
```

`ephemeral()` 里的 `send` 同步改签名（降级实例不压缩：它是一次性内存会话，没有历史可压）：

```ts
      send: (message: string) => built.harness.prompt(message).then(() => undefined),
```

`acquire()` 返回的 `send` 改成下面这样。**改动集中在 else 分支**，followUp 分支原样保留：

```ts
        send(message: string, options: SendOptions = {}): Promise<void> {
          const notify = options.onNotice ?? (() => undefined);
          let outcome: Promise<void> | undefined;
          // 同步读：我如果是「等待者」，先给个解释，别让前端看起来卡死
          if (held.compaction) notify({ phase: "start" });

          const started = held.chain.then(async () => {
            // 压缩的互斥不靠 chain：chain 在发起 prompt 之后就放行了，
            // 而 (d) 兜底的补救压缩发生在 prompt 之后、running 已复位为 false，
            // 那时第二个请求会径直走到下面自己再压一次，两个 compact() 撞在一起
            // 后者必抛 busy
            if (held.compaction) {
              notify({ phase: "start" }); // 上面那次同步读可能早于第一个请求设值
              await held.compaction.catch(() => undefined);
            }
            if (held.retired) {
              throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
            }
            if (held.running) {
              outcome = held.harness
                .followUp(message)
                .then(() => held.harness.waitForIdle())
                .catch((error) => {
                  logger.warn({ err: error, sessionId }, "followUp rejected, falling back to prompt");
                  held.running = true;
                  return held.harness
                    .prompt(message)
                    .then(() => undefined)
                    .finally(() => {
                      held.running = false;
                      held.lastUsedAt = now();
                    });
                });
              return undefined;
            }

            // 超阈值就先压。整段在临界区内，所以压缩期间的第二个请求会在
            // 上面那个 await 处等着，不会走到 followUp 那条静默丢消息的路
            held.compaction = maybeCompact(
              held.harness,
              held.session,
              held.compactionState,
              { ...env.compaction, summaryInstructions: SUMMARY_INSTRUCTIONS },
              { pendingMessage: message, onPhase: () => notify({ phase: "start" }) },
            );
            const compaction = await held.compaction.catch(
              (error: unknown): CompactionOutcome => ({
                kind: "failed",
                error: error instanceof Error ? error : new Error(String(error)),
              }),
            );
            held.compaction = undefined;
            held.lastUsedAt = now();
            if (compaction.kind === "skipped" && compaction.overThreshold) {
              // 守卫挡住了、但阈值确实超了：必须告警。不告警的后果是上下文一路
              // 静默涨到模型窗口硬墙，用户只看到「回答突然开始报错」
              notify({ phase: "blocked", reason: compaction.reason });
            } else if (compaction.kind !== "skipped") {
              // 低于阈值时完全静默：绝大多数请求都走那条路，发通知等于每轮都在前端闪一下
              notify({ phase: "end", outcome: compaction });
            }
            if (compaction.kind === "failed") {
              // 压缩失败不阻断本轮：阈值是 80%，还有余量；真超了会落到 (d)
              logger.warn({ err: compaction.error, sessionId }, "自动压缩失败，本轮照常继续");
            }
            if (held.abortRequested || held.retired) {
              held.abortRequested = false;
              return undefined;
            }

            held.running = true;
            outcome = held.harness
              .prompt(message)
              .then(() => undefined)
              .finally(() => {
                held.running = false;
                held.lastUsedAt = now();
              });
            return undefined;
          });
          held.chain = started.catch(() => undefined);
          return started.then(() => outcome);
        },
```

在 `return { ... }` 里 `size()` 之后加一个只给测试用的取状态口子：

```ts
    /**
     * 仅供测试：拿到某个会话的抗抖动状态，用来把它推到「已连续两次无效压缩」
     * 那个分支。没有别的办法——那份状态刻意跟随实例生命周期（放全局 Map 会
     * 泄漏到已淘汰的会话），而 Entry 本身不对外暴露。
     */
    __stateForTest(sessionId: string): CompactionState | undefined {
      return entries.get(sessionId)?.compactionState;
    },
```

`abort()` 里补上压缩期间的处置：

```ts
    async abort(sessionId: string, userId: string): Promise<void> {
      if (!(await sessionRepo.findById(sessionId, userId))) {
        throw new HarnessRegistryError("会话不存在或无权访问", "forbidden");
      }
      const entry = entries.get(sessionId);
      if (!entry) return;
      // pi 的 compact() 内部 signal 是 new AbortController().signal，永远不会被 abort，
      // 所以压缩本身停不下来。能保证的是「压完不再发起新一轮」——不加这一句，
      // 用户点了停止却照样跑一轮
      if (entry.compaction) entry.abortRequested = true;
      await entry.harness.abort();
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts --exclude '**/.claude/**'
```

预期：新的 `自动压缩` 一组与原有全部用例都 PASS。

若「第二个请求排队」那条超时，检查 `held.compaction` 是否在 `await` 之后被置回 `undefined`——忘了置回会让后续每个请求都停在那个 `await` 上。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/harness-registry.ts apps/server/src/services/harness-registry.test.ts
git commit -m "feat(server): 在 prompt 之前自动压缩上下文

互斥靠 Entry.compaction 这条 promise，而不是 chain：chain 在发起 prompt 后
就放行了，(d) 兜底的补救压缩会和第二个请求的压缩撞车。
压缩期间 running 是 false（compact 不发 agent_start），所以 sweep 与容量淘汰
都要把 compaction 视为忙，否则实例被回收而压缩还在往那颗树写。"
```

---

## Task 8: `evict()` 纳入压缩互斥

**Files:**
- Modify: `apps/server/src/services/harness-registry.ts`
- Test: `apps/server/src/services/harness-registry.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `harness-registry.test.ts` 的 `自动压缩` describe 里：

```ts
  /**
   * DELETE /api/sessions/:id 是「先删库、再 evict」，而 session_entries.session_id
   * 是 onDelete: "cascade"。压缩期间删会话：abort 立刻返回（压缩停不下来），
   * 摘要跑完 appendCompaction 撞外键约束，接着还会对着一个已删的会话发起 prompt。
   */
  it("压缩期间 evict 后不再发起 prompt，且 evict 本身不抛", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    factory.faux.setResponses([
      async () => {
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("不该出现的回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const sending = handle.send("问题");
    const evicting = registry.evict(SESSION_ID);
    releaseSummary();
    await expect(evicting).resolves.toBeUndefined();
    await sending.catch(() => undefined);
    handle.release();

    expect(JSON.stringify(await handle.session.getEntries())).not.toContain("不该出现的回答");
    expect(registry.size()).toBe(0);
  });

  it("evict 之后同一会话的新请求拿到新实例", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const first = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");
    first.release();
    await registry.evict(SESSION_ID);

    const second = await registry.acquire(SESSION_ID, TEST_USER_ID, "再问");
    second.release();

    expect(second.harness).not.toBe(first.harness);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts -t "evict" --exclude '**/.claude/**'
```

预期：「压缩期间 evict」FAIL——会话树里出现了「不该出现的回答」。

- [ ] **Step 3: 实现**

替换 `apps/server/src/services/harness-registry.ts` 里的 `evict()`：

```ts
    /**
     * 会话被删除或用户被禁用时调用，否则内存里还有个活实例往已删会话写。
     *
     * 顺序有讲究：先置 retired（让 send() 的临界区在压缩结束后拒绝发起 prompt），
     * 再摘除 Map（不让新请求复用），最后等压缩落地。
     *
     * pi 的压缩不可取消，所以这里只能等它自己跑完；等的过程中的任何错误都吞掉——
     * 会话行已经删了，`session_entries.session_id` 是 cascade，appendCompaction
     * 必然撞外键约束，那不是调用方需要知道的失败。
     */
    async evict(sessionId: string): Promise<void> {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.retired = true;
      entries.delete(sessionId);
      if (entry.compaction) {
        await entry.compaction.catch((error: unknown) => {
          logger.warn({ err: error, sessionId }, "会话已被 evict，进行中的压缩以失败收场");
          return undefined;
        });
      }
      await entry.harness.abort();
    },
```

同时修正 `evict()` 上方与 `routes/sessions.ts` / `routes/admin.ts` 里那条已经不成立的注释。`apps/server/src/http/routes/sessions.ts` 的 `.delete("/:id")` 里，把注释改成：

```ts
    // 会话已经删掉了：清内存实例是收尾，不是这次请求成功与否的一部分。
    // evict() 会先置 retired 再摘除 Map，所以就算这里抛错，那个实例也既不会被
    // 后续请求复用，也不会在压缩结束后继续发起新一轮——失败不该让客户端看到
    // 「删除失败」（会话其实已经没了，重试只会撞 404，体验更乱）
```

`apps/server/src/http/routes/admin.ts` 里第 55 行那句同理改成：

```ts
    // evict() 先置 retired 再摘除 Map 条目，抛错也不代表实例还会继续跑。
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts --exclude '**/.claude/**'
pnpm vitest run apps/server/src/http/routes/sessions.test.ts apps/server/src/http/routes/admin.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/harness-registry.ts apps/server/src/http/routes/sessions.ts apps/server/src/http/routes/admin.ts apps/server/src/services/harness-registry.test.ts
git commit -m "fix(server): evict 纳入压缩互斥，避免孤儿实例

session_entries 是 cascade 删除，压缩期间删会话会让 appendCompaction 撞
外键约束，压缩结束后还会继续对着已删会话发起 prompt。
registry/sessions/admin 里那条「摘除 Map 就不会继续写」的注释同步修正——
引入压缩后那条不变量本来已经不成立。"
```

---

## Task 9: (d) overflow 被动兜底

**Files:**
- Modify: `apps/server/src/services/harness-registry.ts`
- Test: `apps/server/src/services/harness-registry.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `harness-registry.test.ts`：

```ts
describe("createHarnessRegistry 的 overflow 兜底", () => {
  const OVERFLOW = fauxAssistantMessage([fauxText("")], {
    stopReason: "error",
    errorMessage: "This model's maximum context length is 40000 tokens",
  });

  /** 跑一轮并把抛出的错误文案取回来。不用 rejects.toThrow：要对同一条文案做多次断言 */
  async function sendAndCatch(handle: { send: (m: string) => Promise<void> }, message: string) {
    try {
      await handle.send(message);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("压缩成功时文案要求重发", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([OVERFLOW, fauxAssistantMessage([fauxText("## Goal\n摘要")])]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const text = await sendAndCatch(handle, "问题");
    handle.release();

    expect(text).toContain("已自动压缩历史，请重新发送");
  });

  /**
   * 这条是评审抓出的死循环：压缩没成功却告诉用户「已压缩，请重发」，
   * 用户重发 → 又爆窗 → 又被告知已压缩，无限循环。
   */
  it("摘要失败时文案不出现「已自动压缩」", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      OVERFLOW,
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "rate limited" }),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const text = await sendAndCatch(handle, "问题");
    handle.release();

    expect(text).toContain("自动压缩失败");
    expect(text).not.toContain("已自动压缩");
  });

  /**
   * ⑦ 的补救压缩发生在 prompt() 之后，那时 chain 已经放行、running 也已复位成
   * false。若临界区不 await held.compaction，第二个请求会径直发起自己的压缩，
   * 两个 compact() 撞在一起，后者必抛 busy。
   */
  it("补救压缩期间的第二个请求不会并发发起第二次压缩", async () => {
    const factory = compactionFactory();
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryCalls = 0;
    factory.faux.setResponses([
      OVERFLOW,
      async () => {
        summaryCalls += 1;
        await summaryGate;
        return fauxAssistantMessage([fauxText("## Goal\n摘要")]);
      },
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    const first = sendAndCatch(handle, "问题");
    // 等补救压缩真的开始（第一轮的 prompt 已经返回 overflow）
    await new Promise<void>((resolve) => {
      const tick = () => (summaryCalls > 0 ? resolve() : setTimeout(tick, 5));
      tick();
    });
    const second = handle.send("第二个问题");
    releaseSummary();
    await Promise.all([first, second.catch(() => undefined)]);
    handle.release();

    // 只有一次摘要请求：第二个请求等的是同一条 compaction promise，没有自己再压
    expect(summaryCalls).toBe(1);
  });

  it("没东西可压时提示缩短输入或换模型", async () => {
    const factory = compactionFactory();
    factory.faux.setResponses([
      fauxAssistantMessage([fauxText("")], {
        stopReason: "error",
        errorMessage: "context_length_exceeded",
      }),
      fauxAssistantMessage([fauxText("## Goal\n第一次摘要")]),
      fauxAssistantMessage([fauxText("")], {
        stopReason: "error",
        errorMessage: "context_length_exceeded",
      }),
    ]);
    const registry = createHarnessRegistry({ db, createHarness: factory.create });
    const handle = await registry.acquire(SESSION_ID, TEST_USER_ID, "问题");

    // 第一轮：撞窗口 → 兜底压缩成功
    await handle.send("问题").catch(() => undefined);
    // 第二轮：又撞窗口，但最后一条已是 compaction 条目 → Nothing to compact
    await expect(handle.send("再问")).rejects.toThrow(/缩短输入|更大窗口/);
    handle.release();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts -t "overflow 兜底" --exclude '**/.claude/**'
```

预期：三条 FAIL——`send()` 现在对 overflow 的失败回答无感，不抛任何错误。

- [ ] **Step 3: 实现**

在 `apps/server/src/services/harness-registry.ts` 的 `SUMMARY_INSTRUCTIONS` 之后加文案表与错误类型：

```ts
/**
 * (d) overflow 兜底的用户文案。
 *
 * 必须按压缩结果分支。无条件说「已压缩，请重发」会在三种情况下形成死循环
 * （摘要限流 / 单条消息本身超窗口 / 守卫阻断）：用户重发 → 又爆窗 → 又被告知已压缩。
 */
function overflowMessage(outcome: CompactionOutcome): string {
  if (outcome.kind === "compacted") {
    return "上下文超出模型窗口，已自动压缩历史，请重新发送刚才那条消息";
  }
  if (outcome.kind === "failed") {
    return `上下文超出模型窗口，且自动压缩失败（${outcome.error.message}）。请新建会话继续`;
  }
  if (outcome.reason === "nothing-to-compact") {
    return "单条消息或单轮内容超出模型窗口，压缩无法解决。请缩短输入或换用更大窗口的模型";
  }
  return "上下文超出模型窗口，压缩已无法再回收空间。请新建会话继续";
}
```

把 else 分支末尾的 `prompt()` 调用改成检查返回值：

```ts
            held.running = true;
            outcome = held.harness
              .prompt(message)
              .then(async (result) => {
                // pi 模型调用失败不抛异常也不发 error 事件，原因写在 assistant
                // 消息的 errorMessage 里（CLAUDE.md 硬约束第 3 条），所以检测点在这
                if (!isContextOverflow(held.harness, result)) return;
                held.compaction = maybeCompact(
                  held.harness,
                  held.session,
                  held.compactionState,
                  { ...env.compaction, summaryInstructions: SUMMARY_INSTRUCTIONS },
                  { force: true },
                );
                const recovery = await held.compaction.catch(
                  (error: unknown): CompactionOutcome => ({
                    kind: "failed",
                    error: error instanceof Error ? error : new Error(String(error)),
                  }),
                );
                held.compaction = undefined;
                notify({ phase: "end", outcome: recovery });
                // 不自动重发：pi 在 prompt() 时已把 user message 落进会话树，
                // 重发会在树里留下两条一样的 user 消息，前端出现重复气泡
                throw new Error(overflowMessage(recovery));
              })
              .finally(() => {
                held.running = false;
                held.lastUsedAt = now();
              });
            return undefined;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm vitest run apps/server/src/services/harness-registry.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/harness-registry.ts apps/server/src/services/harness-registry.test.ts
git commit -m "feat(server): overflow 被动兜底，文案按压缩结果分支

无条件说「已压缩，请重发」会在摘要限流/单条超窗口/守卫阻断三种情况下
形成死循环。不自动重发：会话树是 append-only 的，重发会留下两条一样的
user 消息。"
```

---

## Task 10: SSE 帧

**Files:**
- Modify: `apps/server/src/http/routes/chat.ts`

- [ ] **Step 1: 实现**

`apps/server/src/http/routes/chat.ts` 里，把 `await handle.send(message)` 那一段改成：

```ts
      try {
        await handle.send(message, {
          /**
           * 同步入队，绝不能在这里 await stream.writeSSE：pi 的订阅回调被串行
           * await 且没有超时，客户端不读流时会因背压永不 resolve，卡住整个 harness
           * （CLAUDE.md 坑 14）。真正的写出交给 queue.pump()。
           */
          onNotice: (notice) => {
            queue.push({ event: "compaction", data: JSON.stringify(toCompactionFrame(notice)) });
          },
        });
      } catch (error) {
```

在文件顶部 `UUID_PATTERN` 之后加投影函数：

```ts
/**
 * 只透出前端要用的字段，不原样透传 CompactionOutcome。
 *
 * failed 的 error 是内部信息（可能带 provider 的原始报错），只进日志不进响应。
 */
function toCompactionFrame(notice: HarnessNotice) {
  if (notice.phase !== "end") return notice;
  const { outcome } = notice;
  if (outcome.kind === "compacted") {
    return {
      phase: "end",
      outcome: {
        kind: "compacted",
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
      },
    };
  }
  if (outcome.kind === "failed") return { phase: "end", outcome: { kind: "failed" } };
  return { phase: "end", outcome: { kind: "skipped", reason: outcome.reason } };
}
```

并在 import 里补 `HarnessNotice`：

```ts
import {
  createHarnessRegistry,
  type HarnessNotice,
  HarnessRegistryError,
} from "../../services/harness-registry.ts";
```

- [ ] **Step 2: 验证类型**

```bash
pnpm run typecheck
```

预期：PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/http/routes/chat.ts
git commit -m "feat(server): SSE 增加 event: compaction

同步入队而不是直接 writeSSE：订阅回调里做网络 I/O 会因背压卡住整个 harness。
failed 的 error 不进响应体，只进日志。"
```

---

## Task 11: 路由级验收测试

**Files:**
- Modify: `apps/server/src/http/routes/chat.test.ts`

这一组钉住 spec §11 的验收标准 1、2、6。

- [ ] **Step 1: 写失败的测试**

先看 `chat.test.ts` 里现有的 `postChat` 与读流辅助函数怎么写的（文件中段），沿用同样的方式。追加：

```ts
describe("自动压缩", () => {
  /** 换一套小窗口 faux，并把会话树填到超阈值 */
  async function seedLongSession(sessionId: string) {
    faux = fauxProvider({
      tokensPerSecond: 10_000,
      models: [{ id: "faux-compaction", contextWindow: 40_000, maxTokens: 8192 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    state.harnessOptions = { models, model: faux.getModel() };

    // 直接写会话树，不跑 agent loop：压缩只读这颗树，跑 20 轮模型调用纯属浪费
    const sessionRepo = (await import("@petrel/database")).createSessionRepository(state.db!);
    const user = await registerUser("long@x.io");
    await sessionRepo.upsert({ id: sessionId, userId: user.id, title: "长会话" });
    const { createPgSession } = await import("@petrel/agent");
    const session = createPgSession(state.db! as never, sessionId, new Date());
    const chunk = "一".repeat(4000);
    for (let i = 0; i < 20; i++) {
      await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: chunk }],
        timestamp: Date.now(),
      } as never);
      await session.appendMessage(fauxAssistantMessage([fauxText(chunk)]));
    }
    return { cookie: user.cookie, session };
  }

  it("压缩后模型侧变短、用户侧 transcript 一条不少", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const { cookie: longCookie, session } = await seedLongSession(sessionId);
    faux.setResponses([
      fauxAssistantMessage([fauxText("## Goal\n摘要")]),
      fauxAssistantMessage([fauxText("回答")]),
    ]);
    const before = (await entryRepo.listAll(sessionId)).filter((e) => e.type === "message").length;

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: longCookie },
      body: JSON.stringify({ message: "再问一句", sessionId }),
    });
    await response.text(); // 读完流，等 harness 跑完

    // 模型侧：compaction 条目已生效，上溯在它那里停住
    const contextEntries = await session.buildContextEntries();
    expect(contextEntries.some((entry) => entry.type === "compaction")).toBe(true);

    // 用户侧：GET /:id/messages 用 listAll 投影，压缩不影响它。
    // 这一条不许改成 buildContext()——那样压缩后用户刷新会看到历史凭空消失
    const history = await app.request(`/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: longCookie },
    });
    const body = (await history.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThanOrEqual(before);
  });

  it("SSE 里有 event: compaction，且不泄露 failed 的 error", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const { cookie: longCookie } = await seedLongSession(sessionId);
    faux.setResponses([
      fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "秘密的内部报错" }),
      fauxAssistantMessage([fauxText("回答")]),
    ]);

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: longCookie },
      body: JSON.stringify({ message: "再问一句", sessionId }),
    });
    const text = await response.text();

    expect(text).toContain("event: compaction");
    expect(text).toContain('"phase":"start"');
    expect(text).toContain('"kind":"failed"');
    expect(text).not.toContain("秘密的内部报错");
  });

  it("低于阈值的普通请求没有任何 compaction 帧", async () => {
    const response = await postChat({ message: "你好", sessionId: SESSION_ID });
    const text = await response.text();

    expect(text).not.toContain("event: compaction");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run apps/server/src/http/routes/chat.test.ts -t "自动压缩" --exclude '**/.claude/**'
```

预期：前两条 FAIL（找不到 `event: compaction`），第三条应当已经 PASS（还没有帧）。

- [ ] **Step 3: 让测试通过**

Task 10 已经实现了帧。若仍失败，按顺序查：

1. `seedLongSession` 造的 token 数够不够（20 轮 × 2 条 × 1000 token = 40000，阈值 32000）；
2. `state.harnessOptions` 是不是在 `app.request` 之前就设好了（`beforeEach` 会把它清成 `undefined`）；
3. `createPgSession` 拿到的 db 是不是 PGlite 那个（`state.db`）。

- [ ] **Step 4: 跑整个文件确认没有回归**

```bash
pnpm vitest run apps/server/src/http/routes/chat.test.ts --exclude '**/.claude/**'
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/http/routes/chat.test.ts
git commit -m "test(server): 压缩的路由级验收

把「模型侧变短」与「用户侧 transcript 一条不少」钉在同一个用例里——
这两条读路径的分工是整个设计的前提。"
```

---

## Task 12: 前端压缩提示

**Files:**
- Modify: `apps/web/src/composables/useAgentStream.js`
- Create: `apps/web/src/components/chat/CompactionDivider.vue`
- Modify: `apps/web/src/views/ChatView.vue`

`apps/web` 没有 typecheck，`pnpm run lint` 也不可用（v0.4 遗留），所以这一步靠 compose 起服务人工验证。

**别改 `AgentChatComponent.vue`**：那是 v0.4 遗留的待删旧对话代码（调的是已不存在的 Python API）。v0.5 的对话界面是 `views/ChatView.vue`，它在 `messages` 上做 `v-for` 渲染 `MessageItem`，唯一状态来源是 `useAgentStream()`。

- [ ] **Step 1: 先读现有代码**

```bash
sed -n '1,60p' apps/web/src/views/ChatView.vue
sed -n '1,60p' apps/web/src/composables/useAgentStream.js
```

确认两件事：`ChatView.vue` 第 10-17 行那个 `v-for` 的形状；`useAgentStream` 的返回值列表（第 170 行）——新增的 ref 要加进去，否则视图拿不到。

- [ ] **Step 2: composable 认新帧**

在 `useAgentStream.js` 的 `running` 等 ref 旁边加：

```js
  /** 正在压缩上下文。压缩发生在回答开始之前，所以要独立于 running 显示 */
  const compacting = ref(false)
  /**
   * 压缩标记。atIndex 记的是压缩发生那一刻 messages 的长度，渲染时插在该下标之前。
   *
   * 这些标记只活在内存里、不落库：刷新页面就没了，而历史消息一条不少。
   * 这是有意的——压缩是模型侧的事，用户侧的 transcript 本来就完整。
   */
  const compactions = ref([])
```

在 `streamChat` 的回调里，`frame.event === 'agent'` 那个分支**之前**插入：

```js
          if (frame.event === 'compaction' && frame.data) {
            if (frame.data.phase === 'start') {
              compacting.value = true
              return
            }
            if (frame.data.phase === 'blocked') {
              error.value =
                '上下文已超过压缩阈值，但自动压缩暂时不可用，建议新建会话继续'
              return
            }
            // phase === 'end'
            compacting.value = false
            if (frame.data.outcome?.kind === 'compacted') {
              compactions.value.push({
                atIndex: messages.value.length,
                tokensBefore: frame.data.outcome.tokensBefore,
                tokensAfter: frame.data.outcome.tokensAfter
              })
            }
            return
          }
```

`finally` 块里补一句复位——压缩期间断连时不能让指示器永远转：

```js
      compacting.value = false
```

`reset()` 里也要清掉，否则切会话时上一个会话的分隔线会留在新会话的列表里：

```js
  function reset() {
    messages.value = []
    toolCalls.value = {}
    error.value = ''
    compactions.value = []
    activeIndex = -1
  }
```

最后把两个新 ref 加进第 170 行的返回值：

```js
  return {
    messages,
    toolCalls,
    running,
    error,
    canSend,
    compacting,
    compactions,
    send,
    stop,
    disconnect,
    reset,
    loadHistory
  }
```

- [ ] **Step 3: 分隔线组件**

新建 `apps/web/src/components/chat/CompactionDivider.vue`：

```vue
<script setup>
defineProps({
  tokensBefore: { type: Number, default: 0 },
  tokensAfter: { type: Number, default: 0 }
})
</script>

<template>
  <!--
    压缩会让模型侧的上下文变短，但用户看到的历史一条不少。
    给出前后 token 数是为了让「为什么回答突然像忘了前面」有个可见的解释。
  -->
  <div class="compaction-divider">
    <span class="line" />
    <span class="label">
      上下文已压缩
      <template v-if="tokensBefore">（{{ tokensBefore }} → {{ tokensAfter }} tokens）</template>
    </span>
    <span class="line" />
  </div>
</template>

<style scoped>
.compaction-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.line {
  flex: 1;
  height: 1px;
  background: rgba(0, 0, 0, 0.1);
}
</style>
```

- [ ] **Step 4: 挂进 ChatView**

`apps/web/src/views/ChatView.vue` 的 `<script setup>` 里补 import 与解构：

```js
import CompactionDivider from '@/components/chat/CompactionDivider.vue'
```

```js
const {
  messages,
  toolCalls,
  running,
  error,
  compacting,
  compactions,
  send,
  stop,
  disconnect,
  reset,
  loadHistory
} = useAgentStream()
```

把模板里第 10-17 行那个 `MessageItem` 的 `v-for` 换成带分隔线的版本：

```vue
        <template v-for="(message, index) in messages" :key="index">
          <!-- 压缩发生在新一轮的 prompt 之前，所以分隔线插在那一刻的消息下标之前 -->
          <CompactionDivider
            v-for="mark in compactions.filter((item) => item.atIndex === index)"
            :key="`mark-${mark.atIndex}-${mark.tokensBefore}`"
            :tokens-before="mark.tokensBefore"
            :tokens-after="mark.tokensAfter"
          />
          <MessageItem
            :message="message"
            :tool-calls="toolCalls"
            :editor-id="index"
            :streaming="running && index === messages.length - 1 && message.role === 'assistant'"
          />
        </template>

        <!-- atIndex 等于当前长度的标记还没有对应消息（压缩刚结束、回答还没开始） -->
        <CompactionDivider
          v-for="mark in compactions.filter((item) => item.atIndex >= messages.length)"
          :key="`tail-${mark.atIndex}-${mark.tokensBefore}`"
          :tokens-before="mark.tokensBefore"
          :tokens-after="mark.tokensAfter"
        />

        <div v-if="compacting" class="compacting">正在压缩上下文…</div>
```

并在 `<style scoped>` 里加：

```css
.compacting {
  margin: 12px 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  text-align: center;
}
```

- [ ] **Step 5: 人工验证**

```bash
docker compose up -d
docker logs petrel-web-dev --tail 30
```

浏览器打开 `http://localhost:5173/agent`，把 `COMPACTION_ABSOLUTE_CAP` 临时调到一个很小的值（如 `2000`）后 `docker compose up -d`（**不能 `restart`**，环境变量不热重载，CLAUDE.md 坑 1），聊两轮，确认：

1. 第二轮发出后先出现「正在压缩上下文…」，随后出现分隔线；
2. 刷新页面，历史一条不少；
3. 把 cap 调回 `120000` 并 `docker compose up -d`，再聊一轮，确认没有任何压缩提示。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/composables/useAgentStream.js apps/web/src/components/chat/CompactionDivider.vue apps/web/src/views/ChatView.vue
git commit -m "feat(web): 压缩提示与分隔线

useAgentStream 之前只认 error 与 agent 两种 frame，其余静默丢弃，
所以服务端发得再对也没有用户可见效果。
分隔线只活在内存里、刷新即失，而历史消息一条不少——压缩是模型侧的事。"
```

**注意** `apps/web/src/composables/useAgentStream.test.js` 已存在。改完 composable 跑一遍它，确认新分支没破坏既有归约：

```bash
pnpm vitest run apps/web/src/composables/useAgentStream.test.js --exclude '**/.claude/**'
```

---

## Task 13: 文档收口

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/backend-plan.md`

- [ ] **Step 1: 补 CLAUDE.md 的硬约束**

在「消费 pi AgentEvent 的硬约束」那一节末尾追加第 8 条：

```markdown
8. **`phase === "compaction"` 时 `prompt()` 抛 `busy`，而 `followUp()` 不抛**——
   它只往队列 push，此时没有 run 会消费，`waitForIdle()` await 的 `runPromise`
   只在 `prompt()`/`skill()` 里创建，压缩期间它是上一轮那个**已 resolve** 的。
   于是 `send()` 立刻返回、SSE 关流、**用户这条消息永久消失且没有任何报错**。
   所以压缩的互斥必须由 `harness-registry` 自己做（`Entry.compaction` 这条 promise），
   不能指望 harness。另外 `compact()` 内部的 signal 是 `new AbortController().signal`，
   **pi 的压缩不可取消**，`abort()` 只能保证「压完不再发起新一轮」。
```

- [ ] **Step 2: 补「踩过的坑」**

在 `CLAUDE.md` 的「踩过的坑」末尾追加：

```markdown
17. **`getSessionStats()` 不能当上下文阈值信号**：它是**全会话累计**（逐条 assistant /
    compaction / branch_summary 的 usage 相加），压缩后继续涨、永不回落。用它做阈值
    等于「聊够久就无条件压缩」。当前上下文有多大只能问
    `estimateContextTokens(await session.buildContext())`，而且那个数**不含 system prompt
    与 tool schema**（它们不在 `buildContext().messages` 里）。
18. **pi 硬编码 `keepRecentTokens: 20000`，所以低于约 2 万 token 的会话压不动**，
    而且后果比「压了但没切掉」更糟：`prepareCompaction` 此时不返回 `undefined`，
    于是 `compact()` 照样发一次摘要请求、拿回一段基于空对话的废摘要、再写入一条
    compaction 条目——白花一次模型调用。生产上走不到（阈值远高于 20k），
    但写压缩测试时必须造 8 万字符以上的会话才能看到真实效果。
```

- [ ] **Step 3: 更新 backend-plan**

先在 `docs/backend-plan.md` 里搜「上下文」定位到子项目 B 那一节，把它改成已实施并追加下面这段（若该节标题不同，就近插入，不要新造一节）：

```markdown
### 子项目 B：上下文自动压缩（已实施）

设计：[2026-08-05-auto-compaction-design.md](superpowers/specs/2026-08-05-auto-compaction-design.md) ·
计划：[2026-08-05-auto-compaction.md](superpowers/plans/2026-08-05-auto-compaction.md)

时机是 (a) pre-prompt 判阈值 + (d) 撞窗口后被动兜底。阈值 =
`min(模型 contextWindow × COMPACTION_THRESHOLD_RATIO, COMPACTION_ABSOLUTE_CAP)`，
默认 `0.8 / 120000`，即 1M 窗口的默认模型 12 万、64k 的备选模型 51.2k。

遗留待办（来自设计文档 §12）：

- [ ] **固定开销估算**——阈值估算不含 system prompt 与工具 schema（它们不在
  `buildContext().messages` 里）。当前 1 个工具误差可忽略，**必须在子项目 C
  （tool/skill 管理）落地时一起补**，否则工具一多就系统性漏判。
- [ ] **压缩可中断**——pi 的 `compact()` 内部 signal 永不 abort，现在点「停止」
  只能保证压完不再跑新一轮。要能真中断得接管 `session_before_compact` hook。
- [ ] **(d) 的确定性降级**——摘要模型限流时压缩帮不上忙。可用
  `Session.appendCompaction()` 写一条机械拼出的摘要（不需要接管 hook），
  但要连并发保护一起接。
- [ ] **mid-turn 压缩**——`harness.compact()` 要求 `phase === "idle"`，
  单轮内 tool result 顶爆窗口时只能落到 (d)。
- [ ] **`keepRecentTokens` 可配**——现在沿用 pi 硬编码的 20000。
  升级触发条件：埋点显示 64k 模型上连续两次压缩各回收不足 10%。
```

- [ ] **Step 4: 跑全量测试与检查**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm run typecheck
pnpm run lint
pnpm run test -- --exclude '**/.claude/**'
```

预期：三条全 PASS。`pnpm run lint` 的配置已排除 `apps/web`，所以前端改动不参与。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md docs/backend-plan.md
git commit -m "docs: 补压缩相关的 pi 硬约束与踩过的坑

新增两条最容易重复踩的：getSessionStats 是累计值不能当阈值信号；
低于 2 万 token 的会话压不动且会白花一次模型调用。"
```

---

## 完成检查

对照 spec §11 的六条验收标准逐条确认：

- [ ] 1. **模型侧上下文变短** —— Task 11「压缩后模型侧变短」
- [ ] 2. **前端刷新历史一条不少** —— Task 11 同一个用例
- [ ] 3. **并发不撞 `phase !== "idle"`** —— Task 7「压缩期间的第二个请求排队等待」
- [ ] 4. **压缩期间删会话不留孤儿** —— Task 8「压缩期间 evict 后不再发起 prompt」
- [ ] 5. **压不动时用户被明确告知** —— Task 9「没东西可压时提示缩短输入或换模型」
- [ ] 6. **低于阈值零噪音** —— Task 11「低于阈值的普通请求没有任何 compaction 帧」

spec §8.1 要求的「被守卫挡住但确实超阈值时必须告警」单独确认：

- [ ] Task 7「守卫挡住但确实超阈值时发 blocked 通知」通过，且前端 `blocked` 分支
  真的会把提示写到 `error`（Task 12 Step 2）。这条容易漏——`blocked` 在 SSE 层
  和前端都有处理代码，但如果 registry 只发 `end` 就永远走不到，测试是唯一的哨兵。

另外确认：

- [ ] `pnpm run typecheck` / `pnpm run lint` / `pnpm run test -- --exclude '**/.claude/**'` 全绿
- [ ] `docker compose up -d` 起来后 `/api/system/health` 正常、聊天可用
- [ ] `.env.template` 里三个新键都在，且默认值与 `packages/config` 一致

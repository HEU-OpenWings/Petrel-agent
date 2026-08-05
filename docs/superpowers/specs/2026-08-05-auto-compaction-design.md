# 上下文管理：自动压缩（设计）

日期：2026-08-05 · 状态：待实施 · 对应 Linear：M2 内核

本文是 agent 核心能力升级的**第二个**子项目（`2026-08-04-agent-harness-session-design.md`
里分解的 **B**）的设计。它建立在 A 已经落地的会话树之上，只做「自动压缩」这一件事：
判断什么时候该压、由谁发起、压缩期间的并发怎么处置、压不动或压失败怎么办。

不做的事：context 用量透出前端的图表/占用条、手动 `/compact` 入口、分支摘要
（`navigateTree`）、记忆系统。

## 1. 现状：压缩通路已通，触发器是空的

A 落地后，压缩在存储层的全部实现已经就位：

- `packages/database/src/repositories/entries.ts:120` 的 `pathToRootOrCompaction()`
  用递归 CTE 从 leaf 沿 `parent_id` 上溯，**遇到 `compaction` 条目就停（含它自己）**。
  压缩不删任何条目，只是让上溯提前终止。
- `packages/agent/src/session/pg-storage.ts:182` 把它接成 pi 的
  `SessionStorage.getPathToRootOrCompaction()`，于是 `session.buildContext()` 拿到的
  是压缩后的版本，而 `entryRepo.listAll()` 仍能投影出完整 transcript。
- `pg-storage.test.ts:97` 已覆盖「compaction 条目之后，上下文只剩摘要与保留尾部」。

**缺的只有触发器**：全仓没有任何地方调用 `harness.compact()`。

## 2. 核对过的 pi 行为（勿凭文档记忆）

以下全部来自读 `pi-agent-core@0.83` 的 dist。行号指
`node_modules/.../pi-agent-core/dist/harness/`。

1. **`harness.compact()` 只能手动调、要求 `phase === "idle"`、硬编码
   `DEFAULT_COMPACTION_SETTINGS`**（`agent-harness.js:640-684`）。文档里说的
   「超阈值自动触发」与 `settings.json` 都不在库层。
2. **`phase` 是私有字段没有 getter**。要判断是否在跑只能自己订阅
   `agent_start` / `settled` 维护标记——`harness-registry.ts` 已经这么做了（`running`）。
3. **pi 的 CLI 压根不用 `AgentHarness`**。它持有底层 `Agent`，自己写了一整套
   `AgentSession` + 平行的 compaction 模块（`packages/coding-agent/src/core/compaction/compaction.ts`）。
   所以我们基于 `createHarness()` **没有上游接线可抄，只能抄策略**。
4. **`DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384,
   keepRecentTokens: 20000 }`**（`compaction/compaction.js:88`）。
   `reserveTokens` 只决定摘要输出上限（`maxTokens = min(0.8 × reserveTokens, model.maxTokens)`），
   不参与我们的阈值判断。
5. **`shouldCompact(tokens, window, s)` 就是 `tokens > window - s.reserveTokens`**
   （`compaction.js:157`）。默认模型 `deepseek-v4-flash` 的 `contextWindow` 是
   **1_000_000** → 阈值 983,616 token。**按 pi 的默认配置，压缩永远不会触发。**
6. **`estimateContextTokens(messages)`**（`compaction.js:130`）= 最后一条 assistant 的
   真实 usage + 该条之后所有消息的字符估算（`estimateTokens` 是 `chars/4`，图片按 4800 字符）。
7. **`getSessionStats()` 不能当阈值信号**：它是**全会话累计**
   （`pg-storage.ts:151`，逐条 assistant/compaction/branch_summary 的 usage 相加），
   压缩后继续涨、永不回落。用它做阈值等于「聊够久就无条件压缩」。它只适合展示成本。
8. **`compact()` 先 `prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS)`
   算好切点，再发 `session_before_compact` hook**（`agent-harness.js:649-661`）。
   所以想改 `keepRecentTokens` 必须在 hook 里自己重新 prepare + compact，
   把结果塞进 `SessionBeforeCompactResult.compaction`——即整条摘要链路都由我们接管。
9. **`customInstructions` 会被拼成 `Additional focus: ...`** 追加到 pi 的摘要提示词末尾
   （`compaction.js:399`）。所以「摘要用中文」不需要接管任何东西。
10. **pi 库层已带完整的 7 段摘要提示词**（`compaction.js:319`）：
    `## Goal / ## Constraints & Preferences / ## Progress (Done|In Progress|Blocked) /
    ## Key Decisions / ## Next Steps / ## Critical Context`，结尾
    `Preserve exact file paths, function names, and error messages.`；
    另有 `UPDATE_SUMMARIZATION_PROMPT` 做**迭代累积**（上次摘要放进 `<previous-summary>` 再更新）。
11. **`compact()` 内部的 signal 是 `new AbortController().signal`，永远不会被 abort**
    （`agent-harness.js:660`）。**pi 的压缩不可取消。**
12. **`phase === "compaction"` 时 `prompt()` 抛 `busy`，而 `followUp()` 不抛**——
    它只往队列 push（`agent-harness.js:617`），此时没有 run 会消费；
    `waitForIdle()` await 的 `runPromise` 只在 `prompt()`/`skill()` 里创建，
    压缩期间它是上一轮那个**已 resolve** 的。于是 `send()` 立刻返回、SSE 关流、
    **用户这条消息永久消失且没有任何报错**。
13. **`harness.getModel()` 有 public getter**（`agent-harness.d.ts:69`），
    所以 `contextWindow` 可以在 `packages/agent` 内部读到，`apps/server` 不必碰 pi 的 `Model` 类型。
14. **`compact()` 不发 `agent_start`**，所以 `entry.running` 在压缩期间是 `false`。

## 3. 调研：其他实现的时机与阈值

Codex（`openai/codex`）、pi CLI、Hermes（`NousResearch/hermes-agent`）、gemini-cli、
cline、OpenHands、Aider、Roo-Code、opencode、Google ADK、oh-my-pi。

**时机分布**：

| 时机 | 项目 |
| --- | --- |
| (a) 发请求前判阈值 | gemini-cli · cline · Roo-Code · opencode · OpenHands · Codex |
| (b) 一轮结束后 | Google ADK · oh-my-pi（主）· pi CLI |
| (c) 后台异步 | Aider（唯一真正后台的）· oh-my-pi 的 idle 压缩（默认关） |
| (d) 撞 context overflow 后被动补救 | **全部项目都有，无一例外** |

**阈值实际数值**：

| 项目 | 阈值 | 压后保留 |
| --- | --- | --- |
| Codex | `0.9 × window` 触发，`0.95 × window` 硬墙 | 最近 20k token 的 user 消息，assistant/tool 全丢 |
| cline | `0.9 ×` 可用输入预算 | 目标 0.7，保留最近 20k |
| gemini-cli | `0.5 × window`（历史上 0.95 → 0.7 → 0.5 一路下调） | 保留尾部 0.3 |
| Roo-Code | 默认 100（只靠硬墙 `window × 0.9 − maxTokens`） | 超限后强制砍 75% |
| opencode | `input_limit − min(20k, maxOutput)` | `clamp(usable×0.25, 2k, 8k)` |
| Hermes | 0.50，但**窗口 < 512K 的模型抬到 0.75** | 摘要目标 0.20 × 阈值 |

**三条直接影响本设计的结论**：

- **(d) 不可省。** cline 的注释最直白：`overflowRecovery` 存在是因为
  「**估算刚刚被证明是错的**」，所以补救路径不能再依赖另一次成功的 LLM 请求。
- **抗抖动是必须项。** pi CLI 有 `assistantIsFromBeforeCompaction` 时间戳守卫；
  Hermes 有 `cooldown`（摘要失败后 600s）与 `ineffective`（**连续两次压缩各回收不足 10%** 就退避），
  且被阻塞又确实超阈值时**必须告警**，否则上下文静默涨到硬墙。
- **小窗口模型容易抖动。** Hermes 把 <512K 窗口的阈值从 0.50 抬到 0.75，理由是
  「不可压缩地板（system prompt + tool schema + 保护尾部 + 滚动摘要）」吃掉大部分回收空间，
  50% 触发会导致每 1-2 轮压一次。

## 4. 决策：时机 = (a) + (d)

**(a) pre-prompt 判阈值为主，(d) overflow 被动兜底，(c) 后台压缩明确不做。**

排除 (b) 的理由：在常驻 harness + SSE 的架构下，(b) 若在 `send()` 返回前压，
用户等待时间与 (a) 完全一样，只是从「回答前转圈」挪到「回答出完了还转圈」，体验更差；
真正 fire-and-forget 才省时间，但那就是 (c)，要连带抄 Aider 的
「摘要期间历史变了就整份丢弃」与 oh-my-pi 的「压缩期间禁止起新 run、结束后排空队列、
abort 不能被压缩挡住」。**(b) 在我们这里没有独立价值。**

**放弃 mid-turn 压缩**：`harness.compact()` 要求 `phase === "idle"`，结构上做不到。
代价是单轮内爆窗时只能落到 (d)。Codex 有 mid-turn 是因为它一轮里能跑几十个 tool call。

**并发处置 = 排队 + 给等待的连接发进行中提示**（不是 cline 式的直接拒绝）：
代价只是第二个请求多等几秒，且这几秒有可见解释；拒绝会在会话里凭空多出一类
需要前端处理的失败，还和现有的「第二个请求进 followUp 队列」语义打架。

**接管程度 = 直接调 `harness.compact(customInstructions)`，不接管 `session_before_compact` hook。**
沿用 pi 的 `DEFAULT_COMPACTION_SETTINGS`。算一遍最容易抖动的 64k 模型：
阈值 51.2k 触发，压后 = 保留 20k + 摘要上限 13k ≈ 33k，回收 18k，
离阈值还有 18k 增长空间，不会进 Hermes 描述的「每 1-2 轮压一次」。**默认值可用。**

**升级到接管 hook 的触发条件**：埋点显示 64k 模型上真的出现抖动
（连续两次压缩各回收不足 10%）。在那之前，为一个可配参数接管整条链路是投机性开发。

**明确反对绕开 `harness.compact()` 自己编排** `prepareCompaction` + `compact` +
`session.appendCompaction`：`phase === "idle"` 那道检查是唯一防止
「压缩与 run 撞车、同时往同一颗树写」的保护，绕开它等于把并发安全从 harness 手里拿走却不接管；
而且不会发 `session_compact` 事件，前端拿不到压缩发生的信号。

## 5. 组件与边界

新增一个模块，改动**六个**现有文件（三个服务端 + 一个 config + 两个前端，见 §9.2）。
**不动** `pg-storage.ts`、`entries.ts`、`services/session.ts`。

### 5.1 `packages/agent/src/compaction.ts`（新增）

纯策略层。pi 的压缩 API 全部关在这里（`estimateContextTokens` · `estimateTokens` ·
`harness.getModel()` · `harness.compact()`），守住「pi 接线只在 agent 与 ai」。
对外只导出：

```ts
maybeCompact(
  harness: AgentHarness,
  session: Session,
  state: CompactionState,
  policy: CompactionPolicy,
  options: {
    /** 本轮即将 prompt 的用户消息。必传：判定发生在 prompt() 之前，
     *  这条消息还不在 session 里，不算进去就会漏判。见 §7.1 */
    pendingMessage?: string;
    /** (d) 兜底：无视阈值与 cooldown */
    force?: boolean;
    /** 同步生命周期回调，见 §6 与 §9.1。策略层在真正要调 harness.compact()
     *  之前才发 "start"，所以低于阈值的普通请求不会产生任何 notice */
    onPhase?: (phase: "start") => void;
  },
): Promise<CompactionOutcome>

/** (d) 兜底判定。吃 harness 而不是 contextWindow：窗口从 harness.getModel() 读，
 *  这样 apps/server 不必碰 pi 的 Model 类型。message 的类型由 prompt() 的返回值推断出来，
 *  不需要在 @petrel/agent 里新增 AssistantMessage 的转导出。 */
isContextOverflow(harness: AgentHarness, message: AssistantMessage): boolean

interface CompactionPolicy {
  enabled: boolean;
  thresholdRatio: number;
  absoluteCap: number;
  /** 传给 harness.compact() 的 customInstructions，见 §7 */
  summaryInstructions?: string;
}

type CompactionOutcome =
  | { kind: "skipped"; reason: "disabled" | "below-threshold" | "nothing-to-compact"
                             | "cooldown" | "ineffective"; overThreshold: boolean }
  // 两对数：usage-based 的给埋点与前端展示，纯字符估算的给 ineffective 守卫。
  // 混用会让守卫失效，见 §8.1.3
  | { kind: "compacted"; tokensBefore: number; tokensAfter: number;
      pureBefore: number; pureAfter: number }
  | { kind: "failed"; error: Error }
```

**`nothing-to-compact` 是从异常里翻出来的，不是返回值**：`harness.compact()` 在
`prepareCompaction` 返回 `undefined` 时抛 `AgentHarnessError("compaction", "Nothing to compact")`
（`agent-harness.js:654`）。这种情况是「会话太短，或者上一条已经是 compaction 条目」，
属于正常结果而非故障，必须在 `maybeCompact()` 里识别出来归到 `skipped`，
否则每轮都会被记成 `failed` 并触发 60s 冷却。

`CompactionState` 是抗抖动所需的可变状态（上次压缩时间戳、连续无效压缩计数、
冷却截止时间），**由调用方持有**——它的生命周期必须和 harness 实例严格一致，
实例被淘汰时状态跟着消失。放在模块内部的全局 Map 会泄漏到已淘汰的会话。

`skipped` 带 `overThreshold` 是为了让调用方能区分「没到阈值所以没压」与
「到了阈值但被守卫挡住」——后者必须告警。

### 5.2 `apps/server/src/services/harness-registry.ts`（改）

只管时机与并发，不认识 token、不认识阈值。`Entry` 加三个字段：

```ts
/** 正在进行的压缩。非 undefined 即「正在压缩」：进临界区要 await 它，
 *  sweep()/evictOldestIdle() 要视为忙，abort() 靠它判断。见 §6 */
compaction: Promise<CompactionOutcome> | undefined;
/** 抗抖动状态（上次压缩时间、连续无效计数、冷却截止），跟随实例生命周期 */
compactionState: CompactionState;
/** 压缩期间收到 abort 的兑现标记，见 §6⑤ */
abortRequested: boolean;
/** 已被 evict（会话删除 / 用户禁用）。压缩结束后一律不再 prompt，见 §6 evict 一段 */
retired: boolean;
```

### 5.3 `apps/server/src/http/routes/chat.ts`（改）

只管把 `onNotice` 回调翻成 SSE 帧。

### 5.4 `packages/config`（改）

新增三项配置（仍是全仓唯一读 `process.env` 的位置）。

**边界的检验**：`compaction.ts` 不知道 HTTP、不知道并发、不知道 registry；
registry 不知道 token 阈值；route 不知道压缩策略。三者可独立测试——`compaction.ts`
用 `fauxProvider` + 内存 session 直接测，不经过 HTTP。

## 6. 时序：`send()` 的精确顺序

压缩插在 **prompt 分支之前**，整段仍在 `held.chain` 临界区里：

压缩的互斥不靠 `chain`，而靠 `Entry` 上的一条 **`compaction: Promise<void> | undefined`**：
任何人进入临界区先 await 它。理由见本节末。

```
send(message, { onNotice }):
  ① 同步：if (held.compaction) onNotice({ phase: "start" })   // 我是等待者，先给个解释
  ② await held.chain：
       ③ if (held.compaction) {                               // 别人正在压，等它
            onNotice({ phase: "start" })                      //   ①漏发时在这里补
            await held.compaction
          }
          if (held.retired) → 抛「会话已删除」，不 prompt          // 见本节 evict 一段
          if (held.running) → followUp 分支（原样不动，不压缩：正在跑，phase 不是 idle）
          else:
       ④ held.compaction = maybeCompact(..., {                // ← 唯一的网络 I/O 等待点
            pendingMessage: message,
            onPhase: (p) => onNotice({ phase: p }),           // 策略层确认要压才回调
          })
          outcome = await held.compaction
          held.compaction = undefined
          if (outcome.kind !== "skipped" || outcome.overThreshold)
            onNotice({ phase: "end", outcome })               // 低于阈值时静默
       ⑤ if (held.abortRequested || held.retired) { 复位标记; 不 prompt，直接结束本轮 }
       ⑥ held.running = true
          result = await harness.prompt(message)              // 返回值不再丢弃
       ⑦ (d) 兜底：if (result.stopReason === "error" && isContextOverflow(harness, result))
            held.compaction = maybeCompact(..., { force: true })   // 无视阈值与 cooldown
            outcome = await held.compaction; held.compaction = undefined
            按 §8.3 的文案表抛出对应错误 → route 发 event: error
```

**通知只在真要压的时候发**（④ 的 `onPhase`）：如果在调 `maybeCompact()` 之前就发
`start`，那么**每一个空闲请求**都会先闪一次「正在压缩」再立刻结束——绝大多数请求
根本不到阈值。所以 `start` 由策略层在阈值判定通过、即将调 `harness.compact()` 那一刻
同步回调发出；`end` 也只在「真压了」或「被守卫挡住且确实超阈值」时发。

**③ 要补发等待提示**：① 是同步读 `held.compaction`，但两个 `send()` 几乎同时进来时，
第二个可能在第一个（在 ④ 里）设上 `held.compaction` **之前**就跑完了 ①，于是漏掉提示，
然后在 ③ 静默等几秒。③ 里再判一次并补发，两处都发到时按 `phase: "start"` 幂等处理
（前端对同一会话的重复 start 只显示一个指示器）。

**为什么压缩互斥不能只靠 `chain`**：`chain` 在 ⑥ 发起 prompt 之后就放行了
（这是 `harness-registry.ts` 现有注释反复强调的——绝不能把「等整轮跑完」串进 chain，
否则 `followUp` 分支永远走不到）。于是 ⑦ 的补救压缩发生时 `chain` 是空的，
而 `running` 已经在 `prompt()` 的 `finally` 里复位成 false，第二个请求进临界区
会看到「不在跑」而径直走到 ④ 自己发起一次压缩——两个压缩撞在一起，
后者的 `harness.compact()` 必抛 `busy`。③ 那一句 await 就是为了堵这个。

`compaction` 这条 promise 同时替掉了原先设想的布尔 `compacting` 标记：
`sweep()` 与 `evictOldestIdle()` 的判空闲条件改成
`!entry.running && !entry.compaction`，`abort()` 判断「是否正在压缩」也看它。
一个字段两用，不需要额外的布尔量。

- **②③ 的等待天然消灭了 oh-my-pi #5800 那个坑**：第二个请求被卡住，
  压根走不到 `followUp()`，所以「压缩期间入队的消息被搁死」在结构上不可能发生，
  不需要额外的「压缩后排空队列」逻辑。这也是拒绝 (c) 的一部分理由——(c) 下这个坑会回来。
- **`entry.compaction` 必须喂给 `sweep()` 与 `evictOldestIdle()`**。
  否则压缩期间 `running` 是 false（§2.14）、`refCount` 也可能因客户端断连归零，
  实例会被回收，而压缩还在往那颗树写。
- **⑤ 是必要的，因为 pi 的压缩不可取消**（§2.11）。用户在压缩期间点「停止」，
  `registry.abort()` 里的 `harness.abort()` → `waitForIdle()` 立刻返回，压缩照跑。
  若不加 ⑤，结果是「用户点了停止，却照样跑了一轮」。所以 `abort()` 在
  `entry.compaction !== undefined` 时置 `abortRequested = true`，由 ⑤ 兑现。
- **`evict()` 必须纳入互斥，否则压缩期间删会话会留下孤儿实例。**
  现在 `evict()`（`harness-registry.ts:394`）是「先从 Map 删除、再 `harness.abort()`」，
  而 `DELETE /api/sessions/:id`（`routes/sessions.ts:89`）是「先删库、再 evict」。
  压缩期间走这条路：`abort()` 里的 `waitForIdle()` 立刻返回（§2.11），压缩照跑，
  而 `session_entries.session_id` 是 `onDelete: "cascade"`（`schema.ts:46`）
  —— 条目已被连带删除，摘要跑完 `appendCompaction` 撞外键约束，
  日志里出现一堆不指向根因的 FK 错误；接着 ⑤ 也不会拦（`abortRequested` 没被置），
  于是继续对着一个已删的会话发起 `prompt()`。
  **修法**：`Entry` 再加一个 `retired: boolean`，`evict()` 的顺序改为
  「置 `retired = true` → 从 Map 删除 → 若 `entry.compaction` 存在则 `await` 它
  （catch 住并只记日志）→ `harness.abort()`」，由 ③ 与 ⑤ 两处兑现。
  **`harness-registry.ts:393` 那条注释也要改**：它现在写着「就算这里抛错，常驻实例
  也已经不在 registry 里、不会继续往这个已删的会话写」——引入压缩后这条不变量不再成立，
  正是本条要恢复的东西。
  同一条路径覆盖 **admin 禁用用户**（`routes/admin.ts` 也调 `evict()`），
  否则禁用后压缩仍会继续产生模型调用。
- **`followUp` 分支不压缩**：正在跑，`phase !== "idle"`，`compact()` 必抛。
  这一轮的上下文压力留给下一轮的 pre-prompt 判定。
- **前端信号**：`onNotice` 是**同步**回调，route 把它 push 进已有的 `sse-queue`
  （不能 `await stream.writeSSE`，CLAUDE.md 坑 14）。压缩结束时 pi 自己会发
  `session_compact` 事件，经现有的 `harness.subscribe` 透传，前端能拿到摘要内容；
  `onNotice` 只负责「开始」「失败」「被守卫阻塞」这三个 pi 不给的信号。

## 7. 阈值与配置

`packages/config` 新增：

| 键 | 默认值 | 合法范围 | 含义 |
| --- | --- | --- | --- |
| `COMPACTION_ENABLED` | `true` | 只接受 `"true"` / `"false"` | 总开关 |
| `COMPACTION_THRESHOLD_RATIO` | `0.8` | `0 < ratio < 1` 的有限数 | 占模型 `contextWindow` 的比例 |
| `COMPACTION_ABSOLUTE_CAP` | `120000` | 正整数 | 绝对上限，控成本与延迟 |

**非法值一律启动即 throw，附中文说明与合法范围**——沿用 `packages/config/src/index.ts`
里 `oneOf()` / `port()` 已有的写法，不做「悄悄回落到默认值」。
必须挡住的输入：`NaN`、空串、`ratio <= 0`、`ratio >= 1`、`cap <= 0`、非整数 cap、
`"1"` / `"yes"` 这类非标准布尔。放过任意一个的后果是**永不压缩或每轮都尝试压缩**，
而且没有任何报错指向配置。新增三项各配一条 config 单测。

### 7.1 判定式

```
contextTokens  = estimateContextTokens(await session.buildContext()).tokens
pendingTokens  = pendingMessage ? estimateTokens(asUserMessage(pendingMessage)) : 0
effectiveWindow = min(model.contextWindow * ratio, absoluteCap)
需要压缩 = contextTokens + pendingTokens > effectiveWindow
```

**`pendingTokens` 不能省。** 判定发生在 `harness.prompt(message)` **之前**，
那条消息还没进会话树，`buildContext()` 里看不到它。漏算的后果是一整类可以在
请求前避免的 overflow 被推到 (d)：已有上下文 48k、阈值 51.2k、新消息 8k 时，
判定说「不必压」，真实请求 56k 直接爆窗，用户被要求手动重发。
这正是 Codex 自己承认还没修的那个洞（`session/turn.rs:159-162` 的 TODO：
pre-turn 压缩发生在「记录 context 更新 + 新用户消息」之前）。我们一开始就要算进去。

**已知的估算缺口：固定开销不在内。** `buildSessionContext()` 返回
`{ ...state, messages }`，**system prompt 不在 `messages` 里**，工具定义也不在。
所以 `estimateContextTokens()` 从来不含系统提示与 tool schema。
当前只有 1 个工具、system prompt 一句话，误差可忽略；但**子项目 C（tool/skill 管理）
落地后会变成真问题**——Hermes 为此专门记了一条（50+ 工具能占 20-30k tokens）。
本期不实现固定开销估算，列入 §12.9；届时的挂点是在判定式里加一项
`fixedOverheadTokens`（系统提示字符估算 + 工具 schema 序列化后的字符估算）。

得到的实际阈值：`deepseek-v4-flash`（1M 窗口）→ **12 万**；
SiliconFlow `DeepSeek-V3`（64k 窗口）→ **51.2k**。

**不复用 pi 的 `shouldCompact()`**：它是 `tokens > window - settings.reserveTokens`，
要用它就得伪造一个 `{ enabled, reserveTokens: 0, keepRecentTokens: 0 }` 的假 settings，
比自己写一行比较更难读。

**不做 Codex 那样的双阈值（0.9 触发 + 0.95 硬墙）**：它的第二道之所以有用，
是因为它有 mid-turn 压缩能在同一轮里兜第二次；我们只有 pre-prompt 一个判定点，
两个阈值在同一点取或就等于取小的那个，第二道纯属摆设。我们的硬墙由 (d) 承担。

**不做 per-model 阈值覆盖**：`min(ratio × window, cap)` 本身就给了两个模型不同的阈值，
且 §4 算过 64k 模型不会抖动。额外的 per-model 键现在是投机性配置项，真出问题再加。

**摘要用中文**：`harness.compact("用中文输出摘要；文件路径、函数名、错误信息原样保留不译。")`。

## 8. 抗抖动与错误处理

### 8.1 三道守卫（`maybeCompact()` 判定阶段按顺序短路）

1. **`stale-usage`（最要紧）** —— 压缩后 `buildContext()` 返回
   `[摘要消息, ...retainedTail]`，而 `retainedTail` 里那些压缩前的 assistant 消息
   **带着反映压缩前完整上下文的旧 usage**，`estimateContextTokens()` 直接用就会
   刚压完立刻又判超阈值。
   守卫：取 `session.findEntries("compaction")` 最后一条的 timestamp，与提供 usage
   那条消息的 timestamp 比；usage 来自压缩之前就**丢弃 usage 分量，改用纯字符估算**
   （`messages.reduce((s, m) => s + estimateTokens(m), 0)`）。
   比 pi CLI 的 `return false` 更准：纯估算下 `retainedTail` 本身就超阈值的情况是真实存在的，
   那种时候应该压。**注意这不是一个独立的 skip reason**，而是估算方式的切换；
   切换后仍要过阈值判定。
2. **`cooldown`** —— 摘要调用失败后 60 秒内不再主动压。（Hermes 用 600s，
   但我们的实例本身 5 分钟就被 idle TTL 回收，60s 足够避免每轮都撞限流。）
   **只挡 pre-prompt 主动压缩，不挡 (d) 兜底**——兜底时上下文已经真的爆了，冷却无意义。
3. **`ineffective`** —— 连续两次压缩各回收不足 10% 就停止自动压缩。
   **`tokensBefore` 与 `tokensAfter` 必须用同一种估算口径，否则这个守卫会失效。**
   `harness.compact()` 返回的 `CompactResult.tokensBefore` 是 usage-based 的
   （含 provider 计入的 system prompt 等固定开销），而压缩后拿不到新的 usage，
   只能纯字符估算——两个数不可比，相减会系统性高估回收比例，`ineffective` 永远不触发。
   所以 ineffective 单独算一对纯字符估算值（`pureBefore` / `pureAfter`，
   `pureBefore` 在调 `harness.compact()` 之前算），只用于这一个守卫；
   §7 的阈值判定继续用更准的 usage-based 估算。
   `CompactionOutcome.compacted` 里同时带上两对数（usage-based 的用于埋点与展示，
   纯估算的用于守卫），别只留一对。

**被守卫挡住、但确实超了阈值时必须告警**（`skipped` 带 `overThreshold: true`）：
发 `onNotice({ phase: "blocked", reason })`，前端提示「上下文已超阈值但自动压缩暂时不可用
（原因），建议新建会话」，按 reason 种类去重、压缩成功后清除。
不告警的后果是上下文静默涨到硬墙——Hermes 明确踩过。

### 8.2 压缩失败

**不抛、不阻断本轮**：记 `warn` 日志 + 发 notice + **照常 prompt**。
理由：阈值是 80%，还有余量；真超了会落到 (d)。
Codex 那种「压缩失败就整轮丢弃、用户消息压根不记录」对 HTTP 服务端不可接受。

### 8.3 (d) overflow 兜底

- **检测点**：`prompt()` 的返回值。registry 现在是 `.then(() => undefined)`
  把 `AssistantMessage` 丢了，改成检查 `stopReason === "error" &&
  isContextOverflow(harness, message)`。
  这是 CLAUDE.md 硬约束第 3 条的直接应用：**pi 模型调用失败不抛异常也不发 error 事件**，
  而是把原因写进 assistant 消息的 `errorMessage`。
- **`isContextOverflow` 判定**：`errorMessage` 关键词匹配
  （`context length` / `context_length_exceeded` / `too many tokens` / `maximum context`，
  大小写不敏感）**或** `usage.input > contextWindow`。
- **处置**：立刻 `maybeCompact(..., { force: true })`（无视阈值与 cooldown），
  然后**不自动重发**，向前端发 `event: error`。
  **文案必须按 `CompactionOutcome` 分支，不能无条件说「已压缩」**：

  | outcome | 文案 |
  | --- | --- |
  | `compacted` | 「上下文超出模型窗口，已自动压缩历史，请重新发送刚才那条消息」 |
  | `failed` | 「上下文超出模型窗口，且自动压缩失败（原因）。请新建会话继续」 |
  | `skipped / nothing-to-compact` | 「单条消息或单轮内容超出模型窗口，压缩无法解决。请缩短输入或换用更大窗口的模型」 |
  | `skipped / ineffective` | 「上下文超出模型窗口，压缩已无法再回收空间。请新建会话继续」 |

  无条件说「已压缩，请重发」会在摘要限流、单条消息本身超窗口、守卫阻断这三种情况下
  形成**死循环**：用户重发 → 又 overflow → 又被告知已压缩请重发。
- **(d) 仍然依赖一次成功的 LLM 请求，这与 §3 引用的 cline 结论（
  「补救路径不能再依赖另一次成功的 LLM 请求」）相违。本期接受这个缺口**，
  代价由上面的文案分支承担——压不动时明确告诉用户压不动，而不是让他徒劳重试。
  确定性降级（不调 LLM、机械拼一份摘要）是 (d) 的升级路径，见 §12.8；
  可行性已核实：`Session.appendCompaction()` 是 public 方法（`session.d.ts:37`），
  不需要接管 `session_before_compact` hook，但它绕开 `harness.compact()` 的
  phase 检查，属于 §4 明确反对的那类做法，要做得连并发保护一起接。
- **为什么不自动重发**：pi 在 `prompt()` 时已把 user message 落进会话树。
  自动重发会在树里留下**两条一模一样的 user 消息**，前端 transcript 出现重复气泡。
  pi CLI 能自动重试一次，是因为它直接改 `agent.state.messages` 数组
  （摘掉最后那条 assistant），而我们的历史是 append-only 的树，摘不掉。
  这是取舍：想要自动重发就得接受树里出现重复条目。
- **(d) 只覆盖 prompt 分支**：`followUp()` 返回 `void`，拿不到 `AssistantMessage`。
  followUp 那一轮撞窗口时用户会看到 pi 写进 assistant 消息的 `errorMessage`，
  下一轮的 pre-prompt 判定会因为 usage 超标而压缩。

## 9. 用户可见行为

压缩发生后：

- **模型侧上下文变短**：`session.buildContext()` 走 `getPathToRootOrCompaction()`，
  在 compaction 条目处停止上溯，实际喂模型的是 `[摘要消息, ...retainedTail]`。
- **用户侧历史一条不少**：`GET /api/sessions/:id/messages` 用 `entryRepo.listAll()`
  过滤 `message` 条目投影，**不受 compaction 影响**。
  **这一条不许改成 `session.buildContext()`**——压缩发生后用户刷新会看到历史凭空消失。
  两条读路径的分工是本设计的前提，不是实现细节。
### 9.1 SSE 契约

新增**一个**事件名，与现有的 `agent` / `error` 并列：

```
event: compaction
data: { "phase": "start" }
data: { "phase": "end", "outcome": { "kind": "compacted", "tokensBefore": n, "tokensAfter": m } }
data: { "phase": "end", "outcome": { "kind": "failed" } }
data: { "phase": "blocked", "reason": "cooldown" | "ineffective" }
```

`outcome` 只透出前端要用的字段，**不原样透传 `CompactionOutcome`**：
`failed` 的 `error` 不给前端（内部信息，只进日志）。
压缩结束时 pi 原生的 `session_compact` 事件（带摘要正文）仍经 `event: agent` 透传。

### 9.2 前端改动在本期范围内

`apps/web/src/composables/useAgentStream.js:120-127` 现在只处理 `error` 与 `agent`
两种 frame，其余**静默丢弃**；`apply()` 的 switch 也不认 `session_compact`。
所以服务端发得再对，不改前端就没有任何用户可见效果——「§9 承诺的提示」与
「只改三个服务端文件」这两句原本是矛盾的。本期把前端一并做掉：

- `composables/useAgentStream.js`：认 `event: compaction`，归约出
  `compacting: Ref<boolean>` 与一条插进 `messages` 的压缩标记；
  `apply()` 处理 `session_compact`（拿摘要正文）
- `components/chat/`：一个分隔线式的压缩提示组件（分隔线 + 「上下文已压缩」+ 可展开摘要），
  `compacting` 为真时显示指示器
- `blocked` 与 (d) 的 `event: error` 走现有的 `error.value` 渠道，不需要新组件

`apps/web` 没有 typecheck、`pnpm run lint` 也不可用（v0.4 遗留），所以前端这部分
**靠 compose 起服务人工验证**，不写自动化测试——与仓库现状一致，不为本期单独补前端测试设施。

## 10. 测试

**存储层不需要新测试**——`pg-storage.test.ts:97` 已覆盖
「compaction 条目之后，上下文只剩摘要与保留尾部」。

### 10.1 `packages/agent/src/compaction.test.ts`（新增）

`fauxProvider` + 内存 session，不碰数据库。
`fauxProvider({ models: [{ id, contextWindow: 30000 }] })` 把窗口压到测试友好的大小，
`FauxResponseFactory` 按 `callCount` 返回 `stopReason: "error"` + 指定 `errorMessage`。

- 阈值以下 → `skipped / below-threshold`
- 超阈值 → `compacted`，且 `session.buildContextEntries()` 里出现 `compaction` 条目、
  消息数减少
- **`stale-usage` 守卫回归**：压缩成功后紧接着再判定一次 → `skipped`，不会连压两次
- **`ineffective`**：连续两次回收不足 10% → `skipped / ineffective`，且 `overThreshold: true`
- **`cooldown`**：摘要调用失败 → `failed`；60s 内再判定 → `skipped / cooldown`；
  `force: true` 无视 cooldown
- **`pendingMessage` 计入阈值**（§7.1）：构造「已有上下文低于阈值、但加上当前输入后
  超过阈值」的会话 → `compacted`；同一份上下文不传 `pendingMessage` 时 → `below-threshold`。
  这一对用例是 §7.1 那个洞的回归测试，缺了就等于没修。
- **`nothing-to-compact` 归到 skipped 而非 failed**（§5.1）：短会话调 `maybeCompact` →
  `skipped / nothing-to-compact`，且**不设置冷却**（紧接着再判定不会返回 `cooldown`）
- **notice 只在真要压时发**（§6④）：低于阈值的判定**一次 `onPhase` 都不回调**；
  超阈值时回调恰好一次
- **ineffective 用同口径估算**（§8.1.3）：断言守卫读的是纯字符估算的那一对，
  而不是 usage-based 的 `tokensBefore`——否则回收比例被高估、守卫永不触发
- `isContextOverflow()` 单测：关键词命中、`usage.input > contextWindow` 命中、
  普通错误不命中

**测试与生产共同的约束**：pi 硬编码 `keepRecentTokens: 20000`，所以
**总量低于约 2 万 token（≈8 万字符）的会话压不动**——`findCutPoint` 会把全部内容
都算作「近期」。注意实际后果比「压了但没切掉」更糟：`prepareCompaction` 此时
**不返回 `undefined`**（它只在「路径为空」或「最后一条已是 compaction」时才返回），
而是返回一个 `messagesToSummarize` 为空、`retainedTail` 是全部历史的 preparation
（`compaction.js:430-495`）。于是 `compact()` 会**照样发一次摘要请求**、拿回一段
基于空对话的废摘要、再写入一条 compaction 条目——白花一次模型调用。
（下一次才会因为「最后一条是 compaction」拿到 `Nothing to compact`。）
生产上走不到这里：阈值 12 万与 51.2k 都远高于 20k，判定过不了就不会调 `compact()`。
测试必须生成 8 万字符以上的填充内容才能看到真实压缩效果。

### 10.2 `apps/server/src/services/harness-registry.test.ts`（增补）

- 压缩期间第二个 `send()` 被 chain 卡住，压缩结束后走 `followUp` 分支：
  **不抛 `busy`、消息不丢**
- 压缩期间 `sweep()` 与 `evictOldestIdle()` 都不回收该实例
- 压缩期间 `abort()` → 压缩结束后**不发起 prompt**（`abortRequested` 兑现）
- 压缩失败 → 不阻断本轮，照常 prompt
- **两个 `send()` 同步发起**：第一个进入压缩，第二个仍收到 `phase: "start"`
  （§6③ 的补发路径），不会静默等待
- **压缩期间 `evict()`（删会话）** → 压缩结束后**不 prompt**、不产生 FK 错误，
  `evict()` 本身不抛（`retired` 兑现，§6 evict 一段）
- **压缩期间 admin 禁用用户** → 同上，不再产生新的模型调用
- **⑦ 的补救压缩与新请求互斥**：`prompt()` 返回 overflow 错误后，
  第二个请求不会并发发起第二次压缩（③ 的 `await held.compaction`）
- **(d) 文案按 outcome 分支**（§8.3）：`compacted` / `failed` /
  `nothing-to-compact` / `ineffective` 四种各断言一条不同的错误文案，
  尤其**压缩没成功时不出现「已自动压缩」字样**

### 10.3 `apps/server/src/http/routes/chat.test.ts`（增补）

- SSE 流里出现 `event: compaction` 帧（§9.1 的 payload 形状）与透传的
  `session_compact` 事件；`failed` 的 `error` 字段**不出现在 payload 里**
- 低于阈值的普通请求**不产生任何 `event: compaction` 帧**
- **压缩后 `GET /:id/messages` 返回的 transcript 一条不少**，同时
  `session.buildContextEntries()` 已经变短——两者在同一个用例里一起断言，
  把「模型侧变短」与「用户侧不变」钉在一起

跑测试要加 `--exclude '**/.claude/**'`（CLAUDE.md 坑 16）。

## 11. 验收标准

造一个超阈值的长会话（≥8 万字符，见 §10.1），压缩后：

1. **模型侧上下文确实变短** —— `session.buildContextEntries()` 里出现 `compaction` 条目，
   条目数显著少于 `entryRepo.listAll()`。
2. **前端刷新历史一条不少** —— `GET /api/sessions/:id/messages` 的返回数量与压缩前一致。
3. **压缩期间的并发请求不撞 `phase !== "idle"` 报错** —— 第二个请求排队后走 `followUp`，
   既不抛 `busy`，也不出现「消息被静默吞掉」（§2.12 那条路被 §6②③ 堵死）。
4. **压缩期间删会话不留孤儿** —— `DELETE /api/sessions/:id` 后，压缩结束不再发起
   `prompt()`，日志里没有外键约束错误（§6 evict 一段）。
5. **压不动时用户被明确告知** —— 单条消息本身超窗口的会话发一次请求，
   得到的错误文案是「压缩无法解决」而**不是**「已自动压缩，请重发」（§8.3）。
6. **低于阈值的请求零噪音** —— 普通短会话的一次请求，SSE 里没有任何
   `event: compaction` 帧（§6④）。

## 12. 已知限制

1. **压缩本身不可中断**（§2.11）。压缩期间点「停止」只能保证压完之后不再发起新一轮
   （§6⑤），不能让压缩提前结束。要能中断必须走「接管 `session_before_compact` hook」
   那条路，届时可以传入自己的 `AbortSignal`。
2. **没有 mid-turn 压缩**（§4）。单轮内 tool result 把上下文顶爆时只能落到 (d)。
3. **(d) 不自动重发**（§8.3）。用户需要手动重发那条消息。
4. **(d) 不覆盖 followUp 分支**（§8.3）。
5. **`keepRecentTokens` 不可配**（沿用 pi 的 20000）。升级触发条件见 §4。
6. **低于 ~2 万 token 的会话压不动**（§10.1）。两个模型的阈值都远高于此，不影响生产。
7. **压缩延迟落在触发那一轮的用户身上**（选 (a) 的直接代价），第二个并发请求还要
   额外多等这几秒。后续优化是 (c) 后台压缩，需要连带引入 Aider 的陈旧结果丢弃与
   oh-my-pi 的队列排空。
8. **(d) 没有不依赖 LLM 的确定性降级**（§8.3）。摘要模型限流、或单条消息本身就超窗口时，
   压缩帮不上忙，用户只能新建会话。本期靠文案分支把这件事说清楚，不让用户徒劳重试。
   升级路径：用 `Session.appendCompaction()` 写一条机械拼出的摘要（Hermes 的
   `_FALLBACK_SUMMARY` 与 Codex 的 `token_budget` 路径都是这个思路），
   但要连并发保护一起接，因为它绕开 `harness.compact()` 的 phase 检查。
9. **阈值估算不含固定开销**（§7.1）。system prompt 与工具 schema 都不在
   `buildContext().messages` 里，所以估算天生偏低。当前 1 个工具 + 一句系统提示，
   误差可忽略；**子项目 C（tool/skill 管理）落地时必须补**，否则工具一多就系统性漏判。
10. **前端压缩提示没有自动化测试**（§9.2）。`apps/web` 没有 typecheck、
    `pnpm run lint` 也不可用（v0.4 遗留），这部分靠 compose 起服务人工验证。

## 13. 非目标

- (c) 后台/idle 异步压缩
- 手动 `/compact` 入口
- context 用量透出前端（占用条、百分比）
- 分支摘要（`navigateTree` / `session_before_tree`）
- 摘要模型与对话模型分离（用便宜模型做摘要）
- 记忆系统（子项目 D）

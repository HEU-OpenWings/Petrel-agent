# 上下文压缩策略

长对话迟早会撞上模型的上下文窗口。撞上之后 provider 直接报错，用户看到的是
「回答突然开始失败」，而且此后每一轮都失败——除了新建会话没有出路。

压缩（compaction）就是在撞墙之前把历史折成一段摘要：保留最近若干轮原文，
更早的部分交给模型总结成一条 `compaction` 条目，之后喂模型的上下文从这条摘要
开始上溯。用户侧的 transcript 一条不少，只有模型侧变短了。

本文讲的是**策略**：什么时候压、什么时候不压、并发怎么办、用户看到什么。
摘要本身由 pi 的库层完成，我们不接管。

原始设计稿：[docs/superpowers/specs/2026-08-05-auto-compaction-design.md](../superpowers/specs/2026-08-05-auto-compaction-design.md)。
本文是收口后的现状说明，冲突时以本文与代码为准。

**代码位置**

| 关注点 | 文件 |
| --- | --- |
| 阈值判定、守卫、结果模型 | `packages/agent/src/compaction.ts` |
| 触发点、并发互斥、生命周期 | `apps/server/src/services/harness-registry.ts` |
| SSE 帧与两条手动端点 | `apps/server/src/http/routes/chat.ts` |
| 前端归约与展示 | `apps/web/src/composables/useAgentStream.js`、`components/chat/CompactionDivider.vue` |

---

## 1. 为什么要自己写

**pi 的 `AgentHarness` 不带自动压缩。** `harness.compact()` 只能手动调用、
硬编码 `DEFAULT_COMPACTION_SETTINGS`、且要求 `phase === "idle"`。pi 文档里说的
「超阈值自动触发」与 `settings.json` 都是 pi **CLI 层**的实现，harness 里没有。

于是三件事得自己做：判定何时该压、保证并发安全、把过程告诉用户。

顺带排掉一个看起来很顺手的做法：**`getSessionStats()` 不能当阈值信号**。
它是全会话累计（逐条 assistant / compaction / branch_summary 的 usage 相加），
压缩后继续涨、永不回落。用它做阈值等于「聊够久就无条件压缩」。

---

## 2. 阈值

```
threshold = min(model.contextWindow × COMPACTION_THRESHOLD_RATIO, COMPACTION_ABSOLUTE_CAP)
```

默认 `ratio = 0.8`、`cap = 120_000`（`packages/config`）。

`ratio` 留出 20% 余量：判定发生在 prompt 之前，这一轮的回答、工具调用与结果都还没
产生，压到 100% 再压就晚了。

`absoluteCap` 存在的理由**不是防爆窗，而是控成本与延迟**：默认模型窗口 1,000,000，
80% 是 80 万 token，一次摘要请求的费用和耗时都不可接受。所以两者取小。

### 当前上下文有多大：估算口径

只能问 `estimateContextTokens(await session.buildContext())` 那一套。两个必须知道的偏差：

1. **不含 system prompt 与 tool schema**——它们不在 `buildContext().messages` 里。
   实际发给 provider 的比估算值大，20% 余量也在补这一块。
2. **压缩后它会采信一个过期的 usage**。`estimateContextTokens` 取「最后一条**非
   error** assistant 的真实 usage + 其后消息的字符估算」，而压缩后 retainedTail
   里留着的正是压缩前那条 assistant——它的 usage 反映的是压缩前的完整上下文。
   直接用就会「刚压完又判超阈值」。

所以判定走 `estimateForDecision()`：先比一次时间戳，**提供 usage 的那条消息若早于
最近一条 `compaction` 条目，整个 usage 分量作废**，退回纯字符估算。
比 pi CLI 的「压缩后干脆不判」更准——纯估算下 retainedTail 本身就超阈值的情况
真实存在，那种时候应该压。

还要把**本轮即将发送的用户消息**算进去（`MaybeCompactOptions.pendingMessage`）：
判定发生在 `harness.prompt()` 之前，这条消息还没进会话树，`buildContext()` 看不到它。
漏算会把一整类「本可以在请求前避免」的爆窗推到事后兜底。

---

## 3. 三个触发点

### (a) 请求前主动压缩

`harness-registry.ts` 的 `send()` 里，在 `harness.prompt()` 之前判一次阈值。
这是绝大多数压缩发生的地方。

### (b) 溢出后兜底

pi **模型调用失败时不抛异常也不发 error 事件**，而是把原因写进 assistant 消息的
`errorMessage`。所以 `prompt()` resolve 之后要检查返回的消息是不是撞了窗口
（`isContextOverflow()`），命中就 `force` 压一次，然后抛一个带用户文案的错误。

**不自动重发**：pi 在 `prompt()` 时已把 user message 落进会话树，重发会在树里留下
两条一样的 user 消息，前端出现重复气泡。

兜底文案必须按压缩结果分支（`overflowMessage()`）。真实的死循环条件不是「压缩没成功」，
而是**压缩成功了、但上下文仍然超窗口**——典型场景是单条消息本身就大到超过窗口
（`compact()` 不会砍掉最新的一轮），此时提示「已压缩请重发」只会让用户对着同一条
巨型消息再爆一次窗。所以 `compacted` 分支要用 `contextWindow` 再判一次。

### (c) 手动命令

前端 `/compact`（见 §7）。`force: true`。

判定是否溢出委托给 pi-ai 的 `isContextOverflow`，不自己搓关键词表：它维护着 25 条
正则、一张「非溢出」排除表（限流/429 会命中 `/too many tokens/` 这类模式，必须排除），
还覆盖静默溢出与 length-stop 溢出两种自己判不出来的情况。自己写的话，最先踩的就是
「把限流当成溢出、白压一次还给用户错误提示」。

---

## 4. 四道守卫

压缩本身要花一次模型调用。压不出效果还反复压，就是纯烧钱 + 每轮卡顿。
`maybeCompact()` 按这个顺序挡：

| 守卫 | 条件 | `force` 能否穿透 |
| --- | --- | --- |
| 总开关 | `COMPACTION_ENABLED=false` | **不能** |
| 阈值 | `tokens ≤ threshold` | 能 |
| 冷却 | 上次摘要失败后 60s 内 | 能 |
| 无效 | 连续 2 次回收不足 10% | 能 |

**总开关优先于 `force`** 是有意的：`force` 同样要发一次摘要请求、往会话树写一条
`compaction` 条目，而那正是运维关掉这个键时想停掉的东西。代价是关掉之后撞窗口的
会话只能收到「压缩已关闭」的提示、自己新建会话。

「无效」守卫的比较必须**同口径**：`tokensBefore` 是 usage-based 的（含 provider
计入的 system prompt 等固定开销），拿它跟纯字符估算的 `tokensAfter` 相减会系统性
高估回收比例，守卫就永远不触发。所以 `CompactionOutcome` 上另带一个 `pureBefore`，
只给这道守卫用。

抗抖动状态（`CompactionState`：`cooldownUntil` + `ineffectiveStreak`）由 registry 的
`Entry` 持有，**生命周期必须与 harness 实例严格一致**——放模块级全局 Map 会泄漏到
已被淘汰的会话。代价是实例被 idle TTL 回收后状态归零，可接受：60s 冷却本来就比
5 分钟 TTL 短。

---

## 5. 并发与互斥

这一节是整个策略里最容易写错的部分。

### 为什么互斥必须自己做

`phase === "compaction"` 时 `prompt()` 会抛 `busy`，但 **`followUp()` 不抛**——
它只往队列 push，此时没有 run 会消费；而 `waitForIdle()` await 的 `runPromise`
只在 `prompt()` / `skill()` / `promptFromTemplate()` 里创建，run 收尾时会置回
`undefined`。压缩期间 `await` 的其实是 `undefined`，立即 resolve。

于是 `send()` 立刻返回、SSE 关流，**用户这条消息永久消失且没有任何报错**。

所以压缩的互斥由 registry 自己做，不能指望 harness。

### Entry.compaction：一个字段四用

`Entry.compaction: Promise<CompactionOutcome> | undefined`，非 `undefined` 即
「正在压缩」：

- 进 `send()` 的临界区要先 await 它
- `sweep()` / `evictOldestIdle()` 把它当作「忙」，不回收（压缩期间 `running` 是
  `false`——`compact()` 不发 `agent_start`——只看 `running` 会把正在压缩的实例回收掉，
  而压缩还在往它的树上写）
- `abort()` / `evict()` 靠它判断要不要等
- 手动压缩与自动压缩共用它

### chain 临界区的边界

`Entry.chain` 串行化的**只有「判断状态 + 发起调用」**，绝不能把「等整轮跑完」或
「等压缩跑完」串进去：

- 串进 prompt 的等待 → 第二个请求排到第一轮结束之后才发起，那时 `running` 已是
  `false`，于是永远走 `prompt`，`followUp` 分支形同虚设。
- 串进压缩的等待 → chain 要等整个压缩跑完才放行，几乎同时到达的第三个请求排进
  chain 时压缩早已结束、`compaction` 已被清空，它看不到「压缩正在进行」这个事实，
  补发通知与排队等待全部落空。

手动压缩的实现里有个相关的坑：临界区回调返回压缩 promise 时要用 `{ outcome }`
**包一层**。直接 return 裸 promise 的话，外层 promise 会采纳（adopt）它，
要等压缩跑完才 settle，chain 跟着卡到那时候——恰好毁掉上面这条性质。

### 中断与淘汰

- **pi 的压缩不可取消**：`compact()` 内部的 signal 是
  `new AbortController().signal`。`abort()` 能保证的只是「压完不再发起新一轮」
  （置 `abortRequested`）。
- `abortRequested` 的唯一消费点是请求前压缩那个分支。**落在兜底压缩期间的置位
  没人兑现**，会一直挂在实例上，等到用户下一次 `send()` 时命中——那一轮不 prompt、
  不报错、SSE 空流关闭，用户消息静默消失。所以兜底分支收尾时要主动清掉它。
- 会话删除 / 用户禁用要 `evict()`：先置 `retired`（让临界区在压缩结束后拒绝发起
  prompt），再摘除 Map，最后等压缩落地。等待过程中的错误全部吞掉——会话行已经删了，
  `session_entries.session_id` 是 cascade，写入必然撞外键，那不是调用方需要知道的失败。
- **evict 失败不能让主操作报错**：删会话与禁用用户都是「先落库、再清理」，
  清理抛错时库里已经改完了，冒泡成 500 会让客户端以为主操作失败。

---

## 6. 结果模型与投影

```ts
type CompactionOutcome =
  | { kind: "skipped"; reason: CompactionSkipReason; overThreshold: boolean }
  | { kind: "compacted"; tokensBefore; tokensAfter; pureBefore; contextWindow }
  | { kind: "failed"; error: Error }

type CompactionSkipReason =
  "disabled" | "below-threshold" | "nothing-to-compact" | "cooldown" | "ineffective"
```

几个约定：

- **`tokensAfter` 只能是纯字符估算**，理由见 §2 的第 2 点。它同时是调用方判断
  「压完还超不超窗口」的依据；换成 usage-based 的数会让那个判断恒真。
- **`Nothing to compact` 归 `skipped` 而非 `failed`**，也不设冷却：pi 只在
  「上次压缩后再没写过任何东西」时抛它，那是正常结果。识别只能靠 message 文本匹配
  （pi 抛的 `AgentHarnessError` 的 `code` 同时覆盖真正的摘要失败），**pi 升级时
  这条要重新核对**。
- `overThreshold` 区分「没超阈值所以没压」与「超了但被守卫挡住」。后者必须告警，
  见 §7。

**对外一律投影，不原样透传**（`routes/chat.ts` 的 `projectOutcome`）：

| 内部字段 | 为什么不能出去 |
| --- | --- |
| `failed.error` | provider SDK 的报错可能带限流阈值、区域信息，个别 SDK 会回显请求 id 或 key 片段 |
| `pureBefore`、`contextWindow` | 内部逻辑用的中间量 |

SSE 帧与 `POST /api/chat/compact` 的响应体**共用这一份投影**——分成两处早晚会
只改一处，从另一处漏出去。测试锁的是**键集合**而不是「不含某字符串」：
`Error` 的 `message`/`stack` 是不可枚举属性，`JSON.stringify` 本来就带不出来，
字符串断言在这个数据形状下恒真，测不出投影有没有做事。

摘要提示词只追加一句 `customInstructions`：
「用中文输出摘要；文件路径、函数名、错误信息原样保留不译。」
pi 库层已带一份完整的 7 段英文提示词，质量够用，不接管整条摘要链路。

---

## 7. 用户能看到什么

### SSE 帧

pi 只在压缩**结束**时发 `session_compact`，「开始 / 失败 / 被守卫挡住」它不给，
所以自己发一组 `event: compaction`：

| phase | 何时 | 前端反应 |
| --- | --- | --- |
| `start` | 阈值判定通过、即将调 `compact()` | 显示「正在压缩上下文…」 |
| `end` | 压缩结束（含 `failed`） | 复位提示；`compacted` 时插一条分隔线 |
| `blocked` | 被守卫挡住**且** `overThreshold` | 显示告警 |

三条注意：

1. **`start` 只在真要调 `compact()` 前发**。提前发的话，每个低于阈值的普通请求都会
   在前端闪一次「正在压缩」。
2. **低于阈值时完全静默**，不发任何帧——绝大多数请求都走那条路。
3. **`blocked` 不能存进前端的 `error`**。它紧跟着就是 `agent_start`，而
   `agent_start` 会清掉 `error`（「新一轮开始，上一轮的错误作废」是正常语义），
   提示刚写进去就被擦掉。它也不该被下一轮的真错误覆盖——两者是两回事，
   所以前端给它独立的 `warning` 槽位。

`blocked` 存在的意义就是让用户在撞上硬墙之前知道该新建会话了；
文案按 `reason` 分：`cooldown` 是「等一会儿还会再试」，`ineffective` 是
「已经压不动了，只能新建会话」。

**等待者也要收到配对的帧**：第二个请求撞上正在进行的压缩时，它自己不会收到发起者的
`end`，所以 registry 给它补发 `start` / `end`，否则前端会把「正在压缩」保持到整轮
回答结束。

### 前端展示

- `compacting`（bool）→ 「正在压缩上下文…」
- `warning`（string）→ `blocked` 告警，`compacted` 成功时清掉（那条告警不再成立）
- `notice`（string）→ 斜杠命令的回执，中性陈述，不与 `warning` 抢配色
- `compactions`（数组）→ 每条 `{ id, atIndex, tokensBefore, tokensAfter }`，
  渲染成 `CompactionDivider`。`atIndex` 记的是压缩发生那一刻 `messages` 的长度，
  分隔线插在该下标之前

`compactions` **只活在内存里、不落库**：刷新页面就没了，而历史消息一条不少。
这是有意的——压缩是模型侧的事，用户侧的 transcript 本来就完整。

### 两条斜杠命令

命令注册在 `views/ChatView.vue`，机制在 `composables/useCommandPalette.js`。

**`/compact` → `POST /api/chat/compact` `{ sessionId }` → `{ outcome }`**

- `force: true`：绕过阈值与抗抖动守卫（总开关仍优先）。手动命令的语义就是
  「我说压就压」。
- **不走 SSE**：压缩是一次请求一个结果，为它铺一整套 sse-queue + pump 只是徒增复杂度。
- **生成中返回 409**（pi 的 `compact()` 要求 idle）。前端也先本地挡一次，
  为的是给出理由而不是静默无反应。
- 与自动压缩共用 `Entry.compaction`：已有压缩在跑时不发起第二次，而是 await
  同一条 promise 并返回它的结果——用户敲命令的那一刻正好有一次自动压缩在跑，
  他要的「压一下」已经在发生了。
- **压缩失败返回 200 + `{ outcome: { kind: "failed" } }`，不是 5xx**：
  「压不动」是用户要看到的结果，不是请求失败。

**`/context` → `GET /api/chat/context?sessionId=` → `{ tokens, threshold, contextWindow }`**

只读，不改任何状态。`tokens` 与阈值判定同口径（走 `estimateForDecision`），
所以压完再看数字确实会变小。

归属校验用 `findById` 而非 `upsert`（同 `POST /api/chat/abort`）：手动命令面对的
一定是已存在的会话，不该顺手把一个空会话建出来。

---

## 8. 调参

| 想要的效果 | 怎么调 |
| --- | --- |
| 更少压缩、更省钱，容忍偶尔爆窗后兜底 | 提高 `COMPACTION_THRESHOLD_RATIO`（如 0.9） |
| 更早压缩、更稳，接受更高摘要开销 | 降低 ratio（如 0.7） |
| 控制单次摘要的成本上限 | 降低 `COMPACTION_ABSOLUTE_CAP` |
| 完全关掉 | `COMPACTION_ENABLED=false`，撞窗口的会话会被告知「新建会话」 |

`.env` 改完**必须 `docker compose up -d`**，`restart` 不重新读环境变量。

---

## 9. 已知局限

- **pi 硬编码 `keepRecentTokens: 20000`，低于约 2 万 token 的会话压不动。**
  而且后果比「压了但没切掉」更糟：`prepareCompaction` 此时不返回 `undefined`，
  于是照样发一次摘要请求、拿回一段基于空对话的废摘要、再写入一条 `compaction`
  条目——白花一次模型调用。生产上走不到（阈值远高于 20k），但**写压缩测试时必须造
  8 万字符以上的会话**才能看到真实效果。
- 估算不含 system prompt 与 tool schema（§2），阈值余量在替它兜。
  tool schema 大幅增长时要重新审视 ratio。
- 抗抖动状态是**单实例内存**的，跟随 harness 实例生死。多副本部署下无效。
- `/context` 在会话没有常驻实例时会用**系统默认模型**装配 harness，
  `contextWindow` 可能与用户偏好的模型不同。命令是个粗略量度，
  为它把用户偏好读进 registry 不划算。
- 摘要质量没有自动化评估。目前只保证「压完确实变短了」（`ineffective` 守卫），
  不保证「摘要没丢关键信息」。

---

## 10. 测试落点

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 策略 | `packages/agent/src/compaction.test.ts` | 阈值、四道守卫、stale usage、口径一致性 |
| 并发 | `apps/server/src/services/harness-registry.test.ts` | 互斥、等待者通知、abort/evict、兜底路径 |
| 契约 | `apps/server/src/http/routes/chat.test.ts` | SSE 帧序列与形状、手动端点的状态码与投影 |
| 前端 | `apps/web/src/composables/useAgentStream.test.js` | 帧归约、`warning` 不被 `agent_start` 擦掉 |

两条写测试时的陷阱：

1. **`fauxAssistantMessage` 的 usage 全 0**，退回纯估算。断言 usage-based 数值的
   用例必须自己塞一条带真实 usage 的消息，否则断言恒真。
2. **fixture 的窗口要选在「阈值 < 内容 < 窗口」区间**。让内容正好等于窗口，
   压缩失败后模型照样「成功」应答，但 `usage.input`（含 system prompt 等固定开销）
   已超窗口，被 pi-ai 的静默溢出检测判成真实溢出——用例名义上在验「压缩失败的帧」，
   实际验的是一条四段混合路径。现有 fixture 用 `contextWindow: 48_000`
   （阈值 38,400）配 40,000 token 的内容。

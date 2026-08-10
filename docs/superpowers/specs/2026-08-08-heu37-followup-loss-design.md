# HEU-37 设计：首轮 error / aborted 收尾时排队消息丢失

## 1. 根因（已核对 pi 0.83 源码，勿凭文档记忆）

`agent-loop.js:108`：当 `stopReason === "error" || stopReason === "aborted"` 时，
循环 `emit(turn_end)` + `emit(agent_end)` 后**直接 return**，跳过第 163 行的
`getFollowUpMessages()` 抽干点与整个 while 循环。

两个子情形：

- **error**：`harness.followUp()` 只把消息 push 进 `followUpQueue`（不落库），
  下一次 `prompt()` 结束时才被消化 → 排到「下一个问题的回答」之后，顺序错乱；
  进程重启彻底丢失。
- **aborted**：`agent-harness.js:912` 的 `abort()` 直接 `followUpQueue = []` →
  永久静默丢失。

用户可见：第二条消息发出后流正常结束，没有回答也没有 `event: error`，
刷新历史里也没有它。连接不挂住（`waitForIdle()` 正常 resolve）。

## 2. 修法：接管队列管理

不再调用 `harness.followUp()`，registry 自己维护队列，settled 后按需重新 `prompt()`：

### 2.1 Entry 新增

```ts
interface PendingMessage {
  message: string;
  assembly: HarnessAssemblyOptions;
  notify: (notice: HarnessNotice) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

// Entry 上：
pending: PendingMessage[];   // 我们的 followUp 队列
draining: boolean;           // drain 互斥，防止并发消费
```

### 2.2 send() 运行中分支

`held.running` 为真或队列已有条目时不再 `followUp().then(waitForIdle())`，改为 push 进 `pending`，
返回该条目的 promise。**语义保持**：send() 在该消息真正跑完（settled）后才 resolve，
并发连接的 SSE 流因此能看到答案再收尾。条目同时保存该请求的 model、systemPrompt 与
压缩通知回调，独立 run 启动前再应用，避免被后到请求的配置覆盖。

### 2.3 settled 后 drain

`settled` 事件（error / aborted 收尾也会发，见 agent-loop.js:110 → agent_end →
`agent-harness.js:475` 的 settled）里 `running = false` 并 **setImmediate** 调度 drain。

延迟到 setImmediate 的原因：settled 之后旧 `prompt()` 的 promise 还要走 finally
复位 `running`，drain 若同步开始会把 `running` 踩成 false。setImmediate 保证
微任务链（含 finally）先跑完。

```ts
async function drain(entry, sessionId) {
  if (entry.draining) return;
  entry.draining = true;
  try {
    while (entry.pending.length > 0) {
      const started = entry.chain.then(() => {
        if (entry.retired) { /* reject 剩余条目 */ return; }
        if (entry.running || entry.compaction) { /* settled/compaction 完成后再唤醒 */ return; }
        const item = entry.pending.shift();
        if (!item) return;
        entry.running = true;
        const outcome = applyAssembly(entry, item.assembly)
          .then(() => promptWithOverflowRecovery(entry, sessionId, item.message, item.notify))
          .finally(() => { entry.running = false; });
        return { item, outcome }; // 包对象，chain 不等待整轮
      });
      entry.chain = started.catch(() => undefined);
      const launched = await started;
      if (!launched) return;
      await launched.outcome.then(launched.item.resolve, launched.item.reject);
    }
  } finally { entry.draining = false; }
}
```

drain 的「判断状态 + 发起 prompt」与 send/compact 共用 `entry.chain`，但等待整轮发生在
chain 外；这样既不会插队或撞上压缩，也不会堵住后续请求入队。排队 run 保留**不做预压缩**
的取舍，但 prompt 后复用普通 send 的 overflow 检测与强制压缩兜底，避免一次溢出让队列
后续消息连锁失败。

### 2.4 abort 语义（本 issue 要求明确定义）

**abort 只停当前轮，排队消息照常处理**。理由：

- 排队消息是用户在停止前就已经表达过的意图，静默丢弃是这次 issue 要消灭的故障；
- 验收要求 aborted 路径同样「第二条最终有回答且落库」，丢弃语义无法满足。

因此 `abort()` 依然调用 `harness.abort()`（清的是 pi 自己的队列，我们不用了），
被中止的轮次正常 settled → drain 继续处理排队消息。

### 2.5 evict

`retired` 置位后 drain 不再 prompt；剩余 pending 条目 reject
（`HarnessRegistryError forbidden`），SSE 路由 catch 后发 `event: error`，不挂连接。

## 3. 验收

- fauxProvider 首轮响应 `stopReason: "error"`，同会话并发第二条消息 →
  第二条最终有回答且落库（registry 层 + chat 路由层各一条）；
- `stopReason: "aborted"` 同样断言；
- 既有「并发第三条消息」测试改为断言**每个排队消息各占一轮 run**（agent_end 数
  与消息数一致）、prompt 顺序与发送顺序一致，仍然全部有回答且落库；
- 排队 prompt 抛运输异常时 send reject，路由对应 SSE 收到 `event:error`；
- 排队 run 溢出时执行补救压缩；运行期间 acquire 的 model/systemPrompt 在该条目起轮前应用。

## 4. 已知取舍

- 排队消息从「同一 run 内消化」变为「各自独立 run」：多一个 agent_start/agent_end
  周期，前端按消息 id 归约，可正常渲染（不改前端）。
- 排队消息的 run 不做预压缩；溢出后的补救压缩与普通 send 一致。

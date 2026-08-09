import { beforeEach, describe, expect, it, vi } from "vitest";
import { abortChat, streamChat } from "@/apis/chat_api";
import { useAgentStream } from "./useAgentStream.js";

// 模块级替身：不改 useAgentStream 的结构就能拿到 streamChat 的入参
vi.mock("@/apis/chat_api", () => ({ streamChat: vi.fn(), abortChat: vi.fn() }));

/** 让 streamChat 替身按给定顺序回放 SSE 帧 */
function replay(frames) {
  streamChat.mockImplementation(async (_params, onFrame) => {
    for (const frame of frames) onFrame(frame);
  });
}

/**
 * 造一条测试说了算的流：什么时候吐帧、什么时候结束都由用例决定。
 *
 * emit 前必须查 signal —— 真实的 streamChat 一旦被 abort，fetch 的 reader 就抛
 * AbortError 不再产出任何帧。不照着模拟的话，测的就不是 abort 的效果。
 */
function controllableStream() {
  const handle = {};
  streamChat.mockImplementation((params, onFrame) => {
    handle.emit = (frame) => {
      if (params.signal.aborted) return;
      onFrame(frame);
    };
    return new Promise((resolve, reject) => {
      handle.close = resolve;
      params.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
  return handle;
}

/** 放空宏任务队列，让 send 的 catch / finally 跑完 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const HISTORY = [
  { role: "user", content: "上一轮问题" },
  { role: "assistant", content: "上一轮回答" },
];

beforeEach(() => {
  streamChat.mockReset();
  streamChat.mockResolvedValue(undefined);
  abortChat.mockReset();
  abortChat.mockResolvedValue(undefined);
});

describe("send", () => {
  it("把 sessionId 透传给 streamChat", async () => {
    const stream = useAgentStream();

    await stream.send("你好", { sessionId: "a3f1c2d4-0000-4000-8000-000000000001" });

    expect(streamChat).toHaveBeenCalledOnce();
    const params = streamChat.mock.calls[0][0];
    expect(params.message).toBe("你好");
    expect(params.sessionId).toBe("a3f1c2d4-0000-4000-8000-000000000001");
  });

  it("systemPrompt 与中断信号一并透传", async () => {
    const stream = useAgentStream();

    await stream.send("你好", { sessionId: "sid", systemPrompt: "你是助手" });

    const params = streamChat.mock.calls[0][0];
    expect(params.systemPrompt).toBe("你是助手");
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });

  it("用户主动中断不算错误，不往界面上报", async () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    streamChat.mockRejectedValue(aborted);
    const stream = useAgentStream();

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.error.value).toBe("");
    expect(stream.running.value).toBe(false);
    expect(stream.canSend.value).toBe(true);
  });

  it("其它异常写进 error 供界面显示", async () => {
    streamChat.mockRejectedValue(new Error("sessionId 必须是 UUID"));
    const stream = useAgentStream();

    await stream.send("你好", { sessionId: "bad" });

    expect(stream.error.value).toBe("sessionId 必须是 UUID");
    expect(stream.running.value).toBe(false);
  });
});

describe("loadHistory", () => {
  it("用历史覆盖消息，并清空工具调用与错误", async () => {
    const stream = useAgentStream();
    // 先真跑一轮，让 toolCalls 和 error 都是脏的
    replay([
      {
        event: "agent",
        data: { type: "tool_execution_start", toolCallId: "t1", toolName: "now", args: {} },
      },
      { event: "error", data: { message: "炸了" } },
    ]);
    await stream.send("你好", { sessionId: "sid" });
    expect(Object.keys(stream.toolCalls.value)).toHaveLength(1);
    expect(stream.error.value).toBe("炸了");

    stream.loadHistory(HISTORY);

    expect(stream.messages.value).toEqual(HISTORY);
    expect(stream.toolCalls.value).toEqual({});
    expect(stream.error.value).toBe("");
  });

  it("拷贝一份历史，调用方之后改自己的数组不会影响界面", () => {
    const stream = useAgentStream();
    const history = [{ role: "user", content: "上一轮问题" }];

    stream.loadHistory(history);
    history.push({ role: "assistant", content: "调用方后来自己追加的" });

    expect(stream.messages.value).toHaveLength(1);
  });

  it("传非数组时退化成空数组", () => {
    const stream = useAgentStream();
    stream.loadHistory(HISTORY);

    stream.loadHistory(undefined);
    expect(stream.messages.value).toEqual([]);

    stream.loadHistory(HISTORY);
    stream.loadHistory(null);
    expect(stream.messages.value).toEqual([]);
  });

  it("切会话时掐断上一轮，旧流的帧不落进新会话", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("会话A的问题", { sessionId: "session-a" });
    await tick();
    expect(stream.running.value).toBe(true);

    stream.loadHistory([{ role: "user", content: "会话B的历史" }]);
    await tick();

    // 不中断的话旧请求还在飞，输入框会一直禁用着
    expect(stream.running.value).toBe(false);
    expect(stream.canSend.value).toBe(true);

    // 会话 A 的帧在切走之后才到（切会话时上一轮往往还在等首帧）
    flow.emit({
      event: "agent",
      data: { type: "message_start", message: { role: "assistant", content: "会话A的回答" } },
    });
    flow.emit({
      event: "agent",
      data: { type: "tool_execution_start", toolCallId: "tA", toolName: "now", args: {} },
    });
    flow.emit({ event: "error", data: { message: "会话A的错误" } });

    expect(stream.messages.value).toEqual([{ role: "user", content: "会话B的历史" }]);
    expect(stream.toolCalls.value).toEqual({});
    expect(stream.error.value).toBe("");

    flow.close();
    await pending;
  });

  it("切会话只断本地接收，不调 abortChat 打断上一轮生成", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("会话A的问题", { sessionId: "session-a" });
    await tick();

    stream.loadHistory([{ role: "user", content: "会话B的历史" }]);
    await tick();

    expect(abortChat).not.toHaveBeenCalled();

    flow.close();
    await pending;
  });

  it("重置写入位置，迟到的 message_update 不会覆盖历史", async () => {
    const stream = useAgentStream();
    // 先跑完整一轮，message_start 会把写入位置指到第 0 条，activeIndex 就脏了
    replay([
      {
        event: "agent",
        data: { type: "message_start", message: { role: "assistant", content: "会话A的回答" } },
      },
    ]);
    await stream.send("会话A的问题", { sessionId: "session-a" });
    expect(stream.messages.value).toHaveLength(1);

    stream.loadHistory(HISTORY);

    // 新一轮只有 message_update 没有 message_start：写入位置若没被重置成 -1，
    // 这一帧会盖掉历史的第 0 条
    replay([
      {
        event: "agent",
        data: { type: "message_update", message: { role: "assistant", content: "迟到的增量" } },
      },
    ]);
    await stream.send("会话B的问题", { sessionId: "session-b" });

    expect(stream.messages.value).toEqual(HISTORY);
  });

  it("灌入历史后新消息接在历史后面", async () => {
    const stream = useAgentStream();
    stream.loadHistory(HISTORY);
    replay([
      {
        event: "agent",
        data: { type: "message_start", message: { role: "assistant", content: "" } },
      },
      {
        event: "agent",
        data: { type: "message_end", message: { role: "assistant", content: "新回答" } },
      },
    ]);

    await stream.send("再问一次", { sessionId: "sid" });

    expect(stream.messages.value).toEqual([...HISTORY, { role: "assistant", content: "新回答" }]);
  });
});

describe("compaction", () => {
  it("phase: start 时置 compacting 为真", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("你好", { sessionId: "sid" });
    await tick();
    flow.emit({ event: "compaction", data: { phase: "start" } });

    expect(stream.compacting.value).toBe(true);

    flow.close();
    await pending;
  });

  it("phase: end 且 kind: compacted 时复位 compacting 并推一条带 atIndex 的标记", async () => {
    const stream = useAgentStream();
    replay([
      { event: "compaction", data: { phase: "start" } },
      {
        event: "compaction",
        data: {
          phase: "end",
          outcome: { kind: "compacted", tokensBefore: 90000, tokensAfter: 20000 },
        },
      },
    ]);

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.compacting.value).toBe(false);
    expect(stream.compactions.value).toEqual([
      { id: 1, atIndex: 0, tokensBefore: 90000, tokensAfter: 20000 },
    ]);
  });

  it("phase: end 且 kind: failed 时复位 compacting 但不推标记", async () => {
    const stream = useAgentStream();
    replay([
      { event: "compaction", data: { phase: "start" } },
      { event: "compaction", data: { phase: "end", outcome: { kind: "failed" } } },
    ]);

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.compacting.value).toBe(false);
    expect(stream.compactions.value).toEqual([]);
  });

  /**
   * 这条用例原来只回放一帧 blocked，于是恒过——而真实帧序里 blocked 之后**紧接着**
   * 就是 agent_start（registry 先 notify 再 prompt，pi 无条件发 agent_start）。
   * 提示当初写在 error 里，被 agent_start 的 `error.value = ''` 一并擦掉，
   * spec §8.1「压不动时必须告警」在生产上完全落空。所以必须把 agent_start 补进
   * 帧序里，否则这条哨兵形同虚设。
   */
  it("phase: blocked 的告警不会被紧随其后的 agent_start 擦掉", async () => {
    const stream = useAgentStream();
    replay([
      { event: "compaction", data: { phase: "blocked", reason: "cooldown" } },
      { event: "agent", data: { type: "agent_start" } },
    ]);

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.warning.value).toContain("冷却");
    // 告警不占 error 的槽位：本轮并没有失败
    expect(stream.error.value).toBe("");
  });

  it("blocked 的文案按 reason 分", async () => {
    const stream = useAgentStream();
    replay([{ event: "compaction", data: { phase: "blocked", reason: "ineffective" } }]);

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.warning.value).toContain("无法回收空间");
  });

  /**
   * blocked 之后不会再有 end 帧（守卫在发 start 之前就 return 了），而「等待者」
   * 连接是先收到 start 的——不复位的话它整轮都显示「正在压缩上下文…」。
   * 这里必须先 emit start，否则 compacting 本来就是 false，断言恒过。
   */
  it("phase: blocked 也复位 compacting", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("你好", { sessionId: "sid" });
    await tick();
    flow.emit({ event: "compaction", data: { phase: "start" } });
    expect(stream.compacting.value).toBe(true);

    flow.emit({ event: "compaction", data: { phase: "blocked", reason: "cooldown" } });

    expect(stream.compacting.value).toBe(false);

    flow.close();
    await pending;
  });

  it("压缩成功后清掉之前的 blocked 告警", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("你好", { sessionId: "sid" });
    await tick();
    flow.emit({ event: "compaction", data: { phase: "blocked", reason: "cooldown" } });
    expect(stream.warning.value).not.toBe("");

    flow.emit({
      event: "compaction",
      data: { phase: "end", outcome: { kind: "compacted", tokensBefore: 90000, tokensAfter: 20000 } },
    });

    expect(stream.warning.value).toBe("");

    flow.close();
    await pending;
  });

  it("断连时 finally 复位 compacting，压缩指示器不会一直转", async () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const stream = useAgentStream();
    streamChat.mockImplementation(async (_params, onFrame) => {
      onFrame({ event: "compaction", data: { phase: "start" } });
      throw aborted;
    });

    await stream.send("你好", { sessionId: "sid" });

    expect(stream.compacting.value).toBe(false);
  });

  it("loadHistory() 清掉 blocked 告警：换会话后它不再成立", async () => {
    const stream = useAgentStream();
    replay([{ event: "compaction", data: { phase: "blocked", reason: "cooldown" } }]);
    await stream.send("你好", { sessionId: "sid" });
    expect(stream.warning.value).not.toBe("");

    stream.loadHistory(HISTORY);

    expect(stream.warning.value).toBe("");
  });

  it("reset() 清空 compactions", async () => {
    const stream = useAgentStream();
    replay([
      {
        event: "compaction",
        data: { phase: "end", outcome: { kind: "compacted", tokensBefore: 1, tokensAfter: 1 } },
      },
    ]);
    await stream.send("你好", { sessionId: "sid" });
    expect(stream.compactions.value).toHaveLength(1);

    stream.reset();

    expect(stream.compactions.value).toEqual([]);
  });
});

describe("stop", () => {
  it("停止按钮要真的叫停：调 abortChat 带当前会话 id，再断本地接收", async () => {
    const stream = useAgentStream();
    const flow = controllableStream();

    const pending = stream.send("你好", { sessionId: "session-a" });
    await tick();

    await stream.stop();

    expect(abortChat).toHaveBeenCalledOnce();
    expect(abortChat).toHaveBeenCalledWith("session-a");

    flow.close();
    await pending;
    expect(stream.running.value).toBe(false);
  });

  it("停止请求在飞时进入 stopping，重复点击只调用一次 abort", async () => {
    let finishAbort;
    abortChat.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAbort = resolve;
        }),
    );
    const stream = useAgentStream();
    const flow = controllableStream();
    const pending = stream.send("你好", { sessionId: "session-a" });
    await tick();

    const first = stream.stop();
    const second = stream.stop();

    expect(stream.stopping.value).toBe(true);
    expect(abortChat).toHaveBeenCalledOnce();
    finishAbort();
    await Promise.all([first, second]);
    await pending;
    expect(stream.stopping.value).toBe(false);
    expect(stream.running.value).toBe(false);

    flow.close();
  });

  it("abort 接口失败时仍断开本地流，并显示服务端可能继续生成", async () => {
    abortChat.mockRejectedValue(new Error("网络错误"));
    const stream = useAgentStream();
    const flow = controllableStream();
    const pending = stream.send("你好", { sessionId: "session-a" });
    await tick();

    await stream.stop();
    await pending;

    expect(stream.running.value).toBe(false);
    expect(stream.stopping.value).toBe(false);
    expect(stream.error.value).toContain("服务端可能仍在生成");

    flow.close();
  });
});

import { computed, ref, shallowRef } from "vue";
import { abortChat, compactChat, streamChat } from "@/apis/chat_api";

/**
 * blocked 的文案按 reason 分。两种原因对用户的意味完全不同：cooldown 是「等一会儿
 * 还会再试」，ineffective 是「已经压不动了，只能新建会话」。reason 取值来自
 * 服务端的 CompactionSkipReason（packages/agent/src/compaction.ts），
 * 但只有 overThreshold 的 skip 才会发 blocked 帧，所以这里只可能是这两个。
 */
const BLOCKED_HINTS = {
  cooldown: "上一次自动压缩失败，正在冷却，稍后会自动重试。上下文已超过压缩阈值，必要时可新建会话",
  ineffective: "自动压缩已连续多次无法回收空间，上下文会一直逼近模型窗口，建议新建会话继续",
  default: "上下文已超过压缩阈值，但自动压缩暂时不可用，建议新建会话继续",
};

/**
 * `/compact` 没压成时的说明。手动压缩走 force，cooldown / ineffective / below-threshold
 * 三个守卫都被跳过，所以这里实际只可能收到 disabled 与 nothing-to-compact，
 * 其余留一条兜底文案。
 */
const MANUAL_SKIP_HINTS = {
  disabled: "压缩功能已在服务端关闭",
  "nothing-to-compact": "上次压缩之后还没有新内容，无需再压",
  default: "本次没有可回收的上下文",
};

/**
 * 把 pi 的 AgentEvent 序列归约为消息状态。
 *
 * 整个对话界面的唯一状态来源：组件只做渲染，不参与事件拼接。
 * 消息结构直接沿用 pi 的 AgentMessage（role: user / assistant / toolResult），
 * 不再自己定义一套中间格式。
 */
export function useAgentStream() {
  /** @type {import('vue').Ref<any[]>} */
  const messages = ref([]);
  /** toolCallId -> { state: 'running' | 'done' | 'error', args, result, ms } */
  const toolCalls = ref({});
  const running = ref(false);
  const error = ref("");
  /**
   * 压缩被守卫挡住、但上下文确实超阈值时的告警。
   *
   * 必须独立于 error：blocked 帧紧跟着就是 prompt，agent_start 会到达并清掉
   * error（那是「新一轮开始，上一轮的错误作废」的正常语义），提示刚写进去就被
   * 擦掉，用户什么都看不到——而这条告警存在的理由正是让用户在撞上模型窗口硬墙
   * 之前就知道要新建会话（spec §8.1）。它也不该被下一轮的真错误覆盖，两者是
   * 两回事，所以给它自己的槽位。
   */
  const warning = ref("");
  /**
   * 中性信息槽，给 `/compact` / `/context` 这类命令的回执用。
   *
   * 不并进 warning：那条是「上下文快撑爆了」的告警，而这里多数时候是
   * 「压完了」「当前占用 12k」这种陈述，两者的分量与配色都不同。
   */
  const notice = ref("");
  /** 正在压缩上下文。压缩发生在回答开始之前，所以要独立于 running 显示 */
  const compacting = ref(false);
  /**
   * 压缩标记。atIndex 记的是压缩发生那一刻 messages 的长度，渲染时插在该下标之前。
   *
   * 这些标记只活在内存里、不落库：刷新页面就没了，而历史消息一条不少。
   * 这是有意的——压缩是模型侧的事，用户侧的 transcript 本来就完整。
   */
  const compactions = ref([]);
  const controller = shallowRef(null);
  /** abort 接口在飞时单独标记。running 只表示生成流还没收尾，无法阻止停止按钮重复请求。 */
  const stopping = ref(false);
  let stopRequest = null;
  /** 当前这一轮的会话 id。stop() 要用它调后端接口，而 send 之外没有别的地方知道它。
   * 只在这一轮生成期间有效，send() 收尾时会清空，避免被后续误用于对错会话调 abortChat */
  const activeSessionId = ref(null);
  /** 当前正在流式写入的消息下标，由 message_start 确定 */
  let activeIndex = -1;
  /** 给压缩标记发稳定的渲染 key。atIndex + token 数会撞（同一下标压两次且数值相同） */
  let compactionSeq = 0;

  const canSend = computed(() => !running.value);

  function reset() {
    messages.value = [];
    toolCalls.value = {};
    error.value = "";
    warning.value = "";
    notice.value = "";
    compactions.value = [];
    activeIndex = -1;
  }

  /** 切换会话时把历史消息灌进来。归约逻辑不参与，直接覆盖整个数组。 */
  function loadHistory(history) {
    // 只断开本地接收：切走会话不等于要停止上一轮生成，harness 是常驻的，
    // 上一个会话的回答会在服务端继续跑完并落库，用户切回来能看到完整结果。
    // 不断开的话旧流的消息、工具调用、错误文案会继续写进新会话的界面，
    // running 也会一直卡在 true 让输入框禁用
    disconnect();
    messages.value = Array.isArray(history) ? [...history] : [];
    toolCalls.value = {};
    error.value = "";
    // 告警说的是「这个会话的上下文超阈值」，换会话就不再成立
    warning.value = "";
    notice.value = "";
    // 同样的道理：不清的话上一个会话的压缩分隔线会残留到这个会话的列表里
    compactions.value = [];
    activeIndex = -1;
  }

  /** message_start / message_update / message_end 都带完整或部分消息，按下标覆盖即可。 */
  function upsertMessage(index, message) {
    if (index < 0) return;
    const next = messages.value.slice();
    next[index] = message;
    messages.value = next;
  }

  function apply(event) {
    switch (event.type) {
      case "agent_start":
        // 只清 error（上一轮的失败作废），不碰 warning：blocked 帧就在 agent_start
        // 之前一瞬到达，一起清掉等于这条告警永远不可见
        error.value = "";
        break;

      case "message_start":
        activeIndex = messages.value.length;
        messages.value = [...messages.value, event.message];
        break;

      case "message_update":
      case "message_end":
        // message_update / message_end 都带完整的（部分）消息，覆盖即可，不用自己拼 delta
        upsertMessage(activeIndex, event.message);
        break;

      case "tool_execution_start":
        toolCalls.value = {
          ...toolCalls.value,
          [event.toolCallId]: {
            state: "running",
            name: event.toolName,
            args: event.args,
            startedAt: performance.now(),
          },
        };
        break;

      case "tool_execution_end": {
        const previous = toolCalls.value[event.toolCallId] ?? {};
        toolCalls.value = {
          ...toolCalls.value,
          [event.toolCallId]: {
            ...previous,
            // isError 在事件顶层，不在 result 里
            state: event.isError ? "error" : "done",
            result: event.result,
            ms: previous.startedAt ? Math.round(performance.now() - previous.startedAt) : undefined,
          },
        };
        break;
      }

      default:
        break;
    }
  }

  async function send(message, options = {}) {
    if (running.value || !message.trim()) return;
    running.value = true;
    error.value = "";
    // 命令回执是上一轮的事，新一轮开始就作废（warning 不清，理由见它的注释）
    notice.value = "";
    controller.value = new AbortController();
    activeSessionId.value = options.sessionId;

    try {
      await streamChat(
        {
          message,
          sessionId: options.sessionId,
          systemPrompt: options.systemPrompt,
          model: options.model,
          signal: controller.value.signal,
        },
        (frame) => {
          if (frame.event === "error") {
            error.value = frame.data?.message ?? "服务端返回未知错误";
            return;
          }
          if (frame.event === "compaction" && frame.data) {
            if (frame.data.phase === "start") {
              compacting.value = true;
              return;
            }
            // start 之外的每个 phase 都要复位 compacting：blocked 之后不会再有 end
            // 帧（守卫在发 start 之前就 return 了），漏了这一句的话，收到过 start 的
            // 「等待者」连接会一直显示「正在压缩上下文…」直到整轮结束
            compacting.value = false;
            if (frame.data.phase === "blocked") {
              warning.value = BLOCKED_HINTS[frame.data.reason] ?? BLOCKED_HINTS.default;
              return;
            }
            // phase === 'end'
            if (frame.data.outcome?.kind === "compacted") {
              // 压成功了，之前那条「压不动」的告警不再成立（spec §8.1）
              warning.value = "";
              compactions.value.push({
                id: ++compactionSeq,
                atIndex: messages.value.length,
                tokensBefore: frame.data.outcome.tokensBefore,
                tokensAfter: frame.data.outcome.tokensAfter,
              });
            }
            return;
          }
          if (frame.event === "agent" && frame.data) {
            apply(frame.data);
          }
        },
      );
    } catch (err) {
      if (err.name !== "AbortError") {
        error.value = err.message;
      }
    } finally {
      running.value = false;
      compacting.value = false;
      controller.value = null;
      // 这一轮已经结束（无论正常收尾还是被中断），activeSessionId 不再对应
      // 任何还在跑的生成，清掉以免被后续误用于对着别的会话调 abortChat
      activeSessionId.value = null;
    }
  }

  /**
   * 只断开本地接收，不影响服务端的生成。
   *
   * 给「用户只是切走看别的会话/开新会话」的场景用：harness 是常驻的，
   * 断开 SSE 只是不再接收推送，上一轮生成会继续跑完并落库。
   */
  function disconnect() {
    controller.value?.abort();
  }

  /**
   * 真正停止生成（停止按钮用）。
   *
   * 两件事都要做：先调后端接口让 agent 真的停下（harness 是常驻的，
   * 断开 SSE 只是不再接收推送，生成会一直跑完），再断开本地读取。
   * 顺序不能反：先断流会让下面那次 await 处在组件收尾流程里，容易被跳过。
   */
  async function stop() {
    if (stopRequest) return stopRequest;
    if (!running.value) return;

    const sessionId = activeSessionId.value;
    const request = (async () => {
      stopping.value = true;
      try {
        if (sessionId) {
          await abortChat(sessionId);
        }
      } catch (err) {
        // 本地仍要断流，否则停止按钮会一直卡住；同时明确告诉用户服务端可能还在跑，
        // 不能把「界面不再接收」伪装成「生成已成功停止」。
        error.value = `停止请求失败：${err.message}。已断开当前响应，服务端可能仍在生成`;
      } finally {
        disconnect();
      }
    })();
    stopRequest = request;

    try {
      await request;
    } finally {
      if (stopRequest === request) {
        stopRequest = null;
        stopping.value = false;
      }
    }
  }

  /**
   * 手动压缩（`/compact` 命令）。
   *
   * 成功时复用自动压缩那套显示：清掉「压不动」的告警、插一条分隔线。
   * 生成中不发请求——后端会回 409，本地先挡住少一次往返。
   */
  async function compactNow(sessionId) {
    if (!sessionId || running.value || compacting.value) return;
    notice.value = "";
    compacting.value = true;
    try {
      const outcome = await compactChat(sessionId);
      if (outcome?.kind === "compacted") {
        warning.value = "";
        compactions.value.push({
          id: ++compactionSeq,
          atIndex: messages.value.length,
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
        });
        return;
      }
      if (outcome?.kind === "failed") {
        notice.value = "压缩失败，请稍后再试";
        return;
      }
      notice.value = MANUAL_SKIP_HINTS[outcome?.reason] ?? MANUAL_SKIP_HINTS.default;
    } catch (err) {
      notice.value = err.message;
    } finally {
      compacting.value = false;
    }
  }

  return {
    messages,
    toolCalls,
    running,
    stopping,
    error,
    warning,
    notice,
    canSend,
    compacting,
    compactions,
    compactNow,
    send,
    stop,
    disconnect,
    reset,
    loadHistory,
  };
}

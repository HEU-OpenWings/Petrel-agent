import { type AgentHarnessEvent, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

/** 用 pi 自带的 faux provider + 内存 session 跑真实 harness，无需模型凭据也无需数据库 */
async function fauxHarness(options: { tokensPerSecond?: number } = {}) {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  const events: AgentHarnessEvent[] = [];
  const harness = createHarness({ session, models, model: faux.getModel() });
  harness.subscribe((event) => {
    events.push(event);
  });
  return { faux, harness, session, events };
}

/** session 里所有 message 条目的 role 序列 */
async function storedRoles(session: Awaited<ReturnType<typeof fauxHarness>>["session"]) {
  const entries = await session.getEntries();
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: { role: string } }).message.role);
}

describe("createHarness", () => {
  it("一轮对话后 user 与 assistant 都进了 session", async () => {
    const { faux, harness, session } = await fauxHarness();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，我是 Petrel。")])]);

    await harness.prompt("你好");

    // 落库由 harness 自己完成，没有任何事件订阅落库代码参与
    expect(await storedRoles(session)).toEqual(["user", "assistant"]);
    const entries = await session.getEntries();
    expect(JSON.stringify(entries)).toContain("你好，我是 Petrel。");
  });

  it("工具循环：toolResult 也落进 session", async () => {
    const { faux, harness, session, events } = await fauxHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_current_time", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("现在已经查到时间了。")]),
    ]);

    await harness.prompt("现在几点");

    expect(await storedRoles(session)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(events.map((e) => e.type)).toContain("tool_execution_end");
  });

  it("followUp 的消息在同一个 run 内被消化，agent_end 只发一次", async () => {
    const { faux, harness, session, events } = await fauxHarness({ tokensPerSecond: 50 });
    faux.setResponses([
      fauxAssistantMessage([fauxText("第一轮回答")]),
      fauxAssistantMessage([fauxText("第二轮回答")]),
    ]);

    const running = harness.prompt("第一个问题");
    // 等第一轮真的开跑（phase 是私有的，只能靠事件判断）
    await new Promise<void>((resolve) => {
      const stop = harness.subscribe((event) => {
        if (event.type === "agent_start") {
          stop();
          resolve();
        }
      });
    });
    await harness.followUp("第二个问题");
    await running;
    await harness.waitForIdle();

    expect(await storedRoles(session)).toEqual(["user", "assistant", "user", "assistant"]);
    // 这是 SSE 能用「收到 settled 就收尾」的依据：整个 run 只发一次
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "settled")).toHaveLength(1);
  });

  it("systemPrompt 传给模型", async () => {
    const { faux, harness } = await fauxHarness();
    let seenSystem: string | undefined;
    faux.setResponses([
      (context) => {
        seenSystem = context.systemPrompt;
        return fauxAssistantMessage([fauxText("好")]);
      },
    ]);

    await harness.prompt("你好");

    expect(seenSystem).toContain("Petrel");
  });
});

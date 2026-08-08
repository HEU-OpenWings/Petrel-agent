import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/**
 * HEU-40 usage 提取与规范化。
 *
 * pi 的 SessionTreeEntry（会话树条目）→ database 的 UsageFact（用量事实）的唯一翻译点。
 * 与 pg-storage.ts 的 getSessionStats 取数路径同源，但用途不同：
 * - getSessionStats 是「per-session 累计」，给上下文管理/未来 Dashboard 用；
 * - 这里是「每条 entry 一行事实」，给配额计量用，幂等键是 entry.id。
 *
 * **字段名编译期钉死**：用 `Pick<Usage, ...>` 约束参与统计的字段。issue 警告的坑是——
 * pi 升级后 Usage 字段若改名，运行时 `?? 0` 会静默把统计变成全零。这里提取时走 isCountableUsage
 * 守卫（缺字段返回 undefined，不记），并在测试里故意构造 totalTokens 与四分量不一致的
 * 非零 usage，断言「不读 usage.totalTokens」。升级 pi 时字段漂移会被编译期 + 测试双重拦。
 */
type CountableUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

/**
 * 一条 entry 是否携带可计量的 usage。
 *
 * 缺任一字段（input/output/cacheRead/cacheWrite/cost.total）即视为不可计量，跳过——
 * 不伪造 0。与 pg-storage.ts:39-49 的 hasCountableUsage 同构。
 *
 * 故意不校验 usage.totalTokens：不读它（某些 provider 不填），total 由四分量相加。
 */
function isCountableUsage(usage: unknown): usage is CountableUsage {
  const u = usage as Partial<CountableUsage> | undefined;
  return (
    !!u &&
    typeof u.input === "number" &&
    typeof u.output === "number" &&
    typeof u.cacheRead === "number" &&
    typeof u.cacheWrite === "number" &&
    typeof u.cost?.total === "number"
  );
}

/**
 * 从一条会话树条目提取并规范化成完整的 UsageFact。
 *
 * 三类 usage-bearing entry（与 getSessionStats 一致）：
 * - message：只有 assistant role 带 usage（user 不计；toolResult.usage 是工具执行自身用量，
 *   不是主 LLM 上下文计量，见 pi-ai types.d.ts:309-310）。
 * - compaction：顶层 usage（压缩那次模型调用的用量）。
 * - branch_summary：顶层 usage（分支摘要那次模型调用的用量）。
 *
 * **totalTokens 由四分量相加**，不读 usage.totalTokens——这是 issue 警告的核心。
 * 相加结果会被 DB 的 CHECK 约束二次校验（schema.ts: token_usage_total_check）。
 *
 * model/provider/api 从 assistant 消息透传；compaction/branch_summary 不带这些，留空。
 * entryId/userId/sessionId 由调用方（pg-storage）填——它持有 entry.id 和装配时的 userId。
 */
export function extractFact(
  entry: SessionTreeEntry,
  userId: string,
  sessionId: string,
): import("@petrel/database").UsageFact | undefined {
  let sourceType: "message" | "compaction" | "branch_summary" | undefined;
  let rawUsage: unknown;
  let model: string | undefined;
  let provider: string | undefined;
  let api: string | undefined;

  if (entry.type === "message") {
    if (entry.message.role !== "assistant") return undefined;
    const assistant = entry.message as { usage?: unknown; model?: string; provider?: string; api?: string };
    rawUsage = assistant.usage;
    sourceType = "message";
    model = assistant.model;
    provider = assistant.provider;
    api = assistant.api;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    rawUsage = (entry as { usage?: unknown }).usage;
    sourceType = entry.type;
  } else {
    return undefined;
  }

  if (!isCountableUsage(rawUsage)) return undefined;

  return {
    entryId: entry.id,
    userId,
    sessionId,
    sourceType,
    model,
    provider,
    api,
    inputTokens: rawUsage.input,
    outputTokens: rawUsage.output,
    cacheReadTokens: rawUsage.cacheRead,
    cacheWriteTokens: rawUsage.cacheWrite,
    // 四分量相加，不读 rawUsage.totalTokens
    totalTokens: rawUsage.input + rawUsage.output + rawUsage.cacheRead + rawUsage.cacheWrite,
    costTotal: rawUsage.cost.total.toString(),
  };
}

import type { CompactionOutcome } from "@petrel/agent";
import { listModels, projectAgentEvent } from "@petrel/agent";
import { getDb } from "@petrel/database";
import { logger } from "@petrel/logger";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import {
  createHarnessRegistry,
  type HarnessNotice,
  HarnessRegistryError,
} from "../../services/harness-registry.ts";
import { getQuotaService, isEnforcementEnabled, QuotaError } from "../../services/quota.ts";
import type { AppEnv } from "../../types.ts";
import { createSseQueue } from "../sse-queue.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只透出前端要用的字段，不原样透传 CompactionOutcome。
 *
 * failed 的 error 是内部信息（可能带 provider 的原始报错），只进日志不进响应；
 * compacted 的 pureBefore / contextWindow 是内部字段。
 *
 * SSE 帧与 POST /compact 的响应体共用这一份：分成两处投影的话，哪天只改了一处
 * 就等于从另一处漏出内部字段。
 */
function projectOutcome(outcome: CompactionOutcome) {
  if (outcome.kind === "compacted") {
    return {
      kind: "compacted",
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    };
  }
  if (outcome.kind === "failed") return { kind: "failed" };
  return { kind: "skipped", reason: outcome.reason };
}

function toCompactionFrame(notice: HarnessNotice) {
  if (notice.phase !== "end") return notice;
  return { phase: "end", outcome: projectOutcome(notice.outcome) };
}

/**
 * registry 是进程级单例：常驻实例的全部意义就是跨请求复用，
 * 每个请求建一个等于没有缓存。
 *
 * 懒初始化而不是模块顶层建：getDb() 会建连接池，顶层调用会让「只导入 app 就连数据库」，
 * 校验类用例也就没法脱离数据库跑（同 routes/sessions.ts 的注释）。
 */
let registry: ReturnType<typeof createHarnessRegistry> | undefined;

/** 导出给 sessions / admin 路由用：删会话、禁用用户时要清掉活实例 */
export function getRegistry() {
  registry ??= createHarnessRegistry({ db: getDb() });
  return registry;
}

/** 仅供测试：单例会跨测试文件把上一个 PGlite 实例带过来 */
export function __resetRegistry(): void {
  registry = undefined;
}

/**
 * registry 只表达「哪一种失败」，不认识 HTTP（同 services/auth.ts 的 AuthError 那套）。
 * forbidden 是越权 → 403；capacity 是运维信号，不是客户端的错 → 503。
 */
const REGISTRY_ERROR_STATUS = { forbidden: 403, capacity: 503, busy: 409 } as const;

function toHttpException(error: unknown): never {
  if (error instanceof HarnessRegistryError) {
    throw new HTTPException(REGISTRY_ERROR_STATUS[error.kind], { message: error.message });
  }
  throw error;
}

/**
 * 请求体是运行时来的 unknown，必须真判类型再用：
 * c.req.json<T>() 的泛型只是断言，body 完全可能是 null、数组、或者数字 message，
 * 直接 body.message?.trim() 会抛成 500——客户端错误报成服务端错误。
 *
 * 校验顺序是 message 先于 sessionId：空消息是最常见的误用。
 */
function parseChatRequest(body: unknown) {
  const fields = body as {
    message?: unknown;
    sessionId?: unknown;
    systemPrompt?: unknown;
    model?: unknown;
  } | null;

  const message = typeof fields?.message === "string" ? fields.message.trim() : "";
  if (!message) {
    throw new HTTPException(400, { message: "message 必须是非空字符串" });
  }

  const sessionId = fields?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }

  const rawSystemPrompt = fields?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === "string" ? rawSystemPrompt : undefined;

  // model 同样可选。但传了一个不认识的 id 时直接 400，不静默回落到默认模型——
  // 用户在设置里选的模型被悄悄换掉，账单和输出都变了却没有任何信号
  const rawModel = fields?.model;
  const model = typeof rawModel === "string" && rawModel !== "" ? rawModel : undefined;
  if (model !== undefined && !listModels().some((item) => item.id === model)) {
    // 附上可选值：只说「未注册」的话，客户端不知道该改成什么。
    // 这条是客户端实际会看到的那一条——@petrel/agent 的 resolveModel 里同类错误
    // 因为本函数先校验过而不可达
    throw new HTTPException(400, {
      message: `模型未注册：${model}，可选值为 ${listModels()
        .map((item) => item.id)
        .join(" | ")}`,
    });
  }

  return { message, sessionId, systemPrompt, model };
}

function requireSessionId(body: unknown): string {
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
    throw new HTTPException(400, { message: "sessionId 必须是 UUID" });
  }
  return sessionId;
}

export const chat = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const { message, sessionId, systemPrompt, model } = parseChatRequest(body);

    // acquire 里的 upsert 同时完成归属校验与建会话；不属于自己时抛 403（容量满时 503）。
    // 放在 streamSSE 之外：一旦开了流就只能在流里报错了。
    //
    // model 是前端从 stores/preferences 读出来的默认模型，校验已在 parseChatRequest
    // 做过，到这里一定在注册表里。缓存命中时，模型通过 setModel 更新，
    // systemPrompt 通过 before_agent_start hook 在下一次新 run 开始时注入。
    const handle = await getRegistry()
      .acquire(sessionId, c.get("currentUser").id, message, { systemPrompt, modelId: model })
      .catch(toHttpException);

    // HEU-54：凭据检查必须在配额与开流之前。checkModelAuth 走 handle 自己的 Models，
    // stored kill switch 开启时会在每一轮重新读取当前用户的 DB CredentialStore；因此保存或
    // 覆盖个人 Key 后不需要重建常驻 harness。DB / envelope / 解密异常全部 fail-closed 为 503，
    // 未配置则用普通 HTTP 409 拒绝，二者都不会扣配额或打开 SSE。
    let modelAuthConfigured: boolean;
    try {
      modelAuthConfigured = await handle.checkModelAuth();
    } catch {
      handle.release();
      logger.error({ sessionId }, "model credential preflight failed");
      throw new HTTPException(503, { message: "模型服务凭据暂时无法读取，请稍后重试" });
    }
    if (!modelAuthConfigured) {
      handle.release();
      throw new HTTPException(409, { message: "当前模型服务凭据未配置" });
    }

    // HEU-40：配额检查。挂在 acquire / 模型凭据检查之后、streamSSE 之前——
    // acquire 之后：归属校验已完成（不会把越权也当超配额拒绝，泄漏会话是否存在）；
    // 凭据之后：无凭据时不查询、更不消耗聊天配额；
    // streamSSE 之前：开流后只能用 event:error，无法用 HTTP 状态码区分「超配额」与「错误」。
    //
    // 任何拒绝都必须先 release：acquire 内部已经 refCount+=1，不释放会泄漏，最终耗尽容量（registry 503）。
    // memory 降级（会话表故障）与配额查询失败的 fail-closed（→ unavailable → 503）**整体受
    // QUOTA_ENFORCEMENT 开关控制**：enforcement=false（纯计量阶段）时，memory 降级也放行，
    // 恢复配额引入前的「能聊不落库」行为——这样 enforcement 才是真正的 kill switch，
    // 可随时回滚到配额功能上线前的可用性。check() 内部对 enforcement=false 直接 return，
    // 所以这里的 memory 检查也要用同一开关守卫，否则开关关了仍会因会话表抖动 503。
    try {
      if (handle.persistence === "memory") {
        throw new QuotaError("配额服务暂不可用，请稍后重试", "unavailable");
      }
      await getQuotaService().check(c.get("currentUser"));
    } catch (error) {
      // enforcement 关闭时，memory 降级不再阻塞：放过本轮（usage 不落库，但用户能继续对话）。
      // 这是把「kill switch 可回滚」贯彻到底：关掉配额 = 完整恢复旧行为，包括降级容忍。
      if (error instanceof QuotaError && error.kind === "unavailable" && !isEnforcementEnabled()) {
        // 不 release：继续走 streamSSE。memory 降级实例本来就不落库，放行不增加风险。
      } else {
        handle.release();
        throw error;
      }
    }

    return streamSSE(c, async (stream) => {
      const queue = createSseQueue();
      let torn = false;
      let unsubscribe: () => void = () => undefined;

      // 幂等：溢出、client abort、正常收尾三条路径都会走到这里，只处理一次
      function teardown() {
        if (torn) return;
        torn = true;
        unsubscribe();
        handle.release();
        queue.close();
      }

      // 只把 core AgentEvent 的安全投影交给浏览器。Harness 自有事件可能含 provider payload、
      // headers、完整 context / model / baseUrl 或内部重试错误，由 projector fail-closed 丢弃。
      // 订阅是会话级的，所以同一会话的另一个连接的输出也会流过来——
      // 它们本来就是这个会话的消息，前端按消息 id 归约，多标签页因此自动同步。
      //
      // 这个回调必须保持同步（不能 async/await 任何 I/O），见 createSseQueue 顶部注释
      unsubscribe = handle.harness.subscribe((event) => {
        const projected = projectAgentEvent(event);
        if (!projected) return;
        const accepted = queue.push({ event: "agent", data: JSON.stringify(projected) });
        if (!accepted) {
          logger.error({ sessionId }, "chat SSE 队列溢出，客户端疑似不读流，断开这一个连接");
          teardown();
          // 强制结束这一路 HTTP 响应：writer 一旦被 abort，pump() 里卡住的
          // writeSSE 会立刻结束等待（write() 内部吞掉错误），不必等它自然写完
          stream.abort();
        }
      });

      // 连接断开只退订，不 abort：harness 常驻，回答继续跑完并落库。
      // 用户主动停止走 POST /api/chat/abort
      stream.onAbort(teardown);

      const pumpDone = queue.pump((frame) => stream.writeSSE(frame));

      try {
        await handle.send(message, {
          /**
           * 同步入队，绝不能在这里 await stream.writeSSE：pi 的订阅回调被串行
           * await 且没有超时，客户端不读流时会因背压永不 resolve，卡住整个 harness
           * （CLAUDE.md 坑 15）。真正的写出交给 queue.pump()。
           */
          onNotice: (notice) => {
            queue.push({ event: "compaction", data: JSON.stringify(toCompactionFrame(notice)) });
          },
        });
      } catch {
        // 上游异常可能带请求 id、headers、响应正文甚至 key 片段：既不进日志，也不进 SSE。
        logger.error({ sessionId }, "agent run failed");
        queue.push({
          event: "error",
          data: JSON.stringify({ message: "模型调用失败，请稍后重试" }),
        });
      } finally {
        teardown();
      }

      // 队列里可能还有没写出的事件（包括 agent_end）：收尾前先等 pump() 写完，
      // 否则一个读得不慢、只是没读到最后的正常客户端也会丢掉结尾几帧
      await pumpDone;
    });
  })

  /**
   * 显式停止。连接断开不再等于停止（见 spec §5），所以这是唯一的中断入口。
   * 会话已经跑完时幂等成功——abort 一个结束了的会话不是错误。
   */
  .post("/abort", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const sessionId = requireSessionId(body);

    await getRegistry().abort(sessionId, c.get("currentUser").id).catch(toHttpException);
    return c.json({ ok: true });
  })

  /**
   * 手动压缩（前端 `/compact` 命令）。
   *
   * 不走 SSE：压缩是一次请求一个结果，为它铺一整套 sse-queue + pump 只是徒增
   * 复杂度。正在生成回答时返回 409（pi 的 compact() 要求 idle）。
   */
  .post("/compact", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const sessionId = requireSessionId(body);

    const outcome = await getRegistry().compact(sessionId, c.get("currentUser").id).catch(toHttpException);
    if (outcome.kind === "failed") {
      // 原始 error 只进日志：provider SDK 的报错可能带限流阈值、区域信息
      logger.warn({ err: outcome.error, sessionId }, "手动压缩失败");
    }
    return c.json({ outcome: projectOutcome(outcome) });
  })

  /** 当前上下文占用（前端 `/context` 命令）。只读，所以用 GET + query。 */
  .get("/context", async (c) => {
    const sessionId = requireSessionId({ sessionId: c.req.query("sessionId") });
    const usage = await getRegistry().inspect(sessionId, c.get("currentUser").id).catch(toHttpException);
    return c.json(usage);
  });

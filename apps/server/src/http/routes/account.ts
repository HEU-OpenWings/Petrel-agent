import { listConfiguredModels } from "@petrel/agent";
import { createPreferencesRepository, getDb } from "@petrel/database";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AuthError, getAuthService } from "../../services/auth.ts";
import type { AppEnv } from "../../types.ts";
import { issueToken } from "../middleware/auth.ts";

/**
 * system prompt 的长度上限。
 *
 * 之所以要有上限：schema 里 system_prompt 是无长度限制的 text，一次请求就能塞进
 * 几十万字，之后每一轮对话都要整份发给模型。同 routes/sessions.ts 的 TITLE_LENGTH_LIMIT。
 */
const SYSTEM_PROMPT_LENGTH_LIMIT = 4000;

/**
 * 用 fromCharCode 而不是把 NUL 写成字面量：源码里放一个不可见的控制字符，
 * 编辑器和 diff 都看不出来（同 routes/sessions.ts）
 */
const NUL = String.fromCharCode(0);

/**
 * 全量写入语义下的字段解析：缺失、null、清完为空一律归一成 null（= 跟随系统默认）。
 *
 * 不归一空串的后果很具体：「清空 system prompt」会存一个 ""，然后被当作有效值
 * 传给 createHarness，harness 拿到的是一个空 prompt 而不是 DEFAULT_SYSTEM_PROMPT。
 *
 * NUL 要单独清掉：trim() 不管它，但 Postgres 的 text 存不了 NUL，漏过去是 500。
 */
function parseNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} 必须是字符串或 null` });
  }
  const cleaned = value.replaceAll(NUL, "").trim();
  return cleaned === "" ? null : cleaned;
}

/** AuthError 带着状态码，翻译成 HTTPException 交给 error 中间件统一出格式（同 routes/auth.ts） */
function toHttpException(error: unknown): never {
  if (error instanceof AuthError) {
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

export const account = new Hono<AppEnv>()
  /**
   * 模型清单语义上不属于「偏好」，合在这个响应里是因为消费者完全重合：
   * 设置面板要用它渲染下拉，ChatView 要用它显示当前模型名。少一个端点少一个往返。
   */
  .get("/preferences", async (c) => {
    const repo = createPreferencesRepository(getDb());
    const preferences = await repo.findByUserId(c.get("currentUser").id);
    // 只返回已配置（API key 可解析）的 provider 的模型，没配 key 的厂商不下拉。
    // PUT 侧校验也用同一口径（见下方），读写一致，避免存入选择器里看不到的 id。
    return c.json({ preferences, models: await listConfiguredModels() });
  })

  .put("/preferences", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    // JSON.parse("null") 不抛异常，body 完全可能合法地解析成 null（或数组/数字）；
    // 不挡住的话 fields?.x 会静默短路成 undefined，两个字段全部归一成 null 而不报错
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HTTPException(400, { message: "请求体必须是 JSON 对象" });
    }
    const fields = body as { defaultModel?: unknown; systemPrompt?: unknown };

    const defaultModel = parseNullableString(fields.defaultModel, "defaultModel");
    // 与 GET 同口径：按「已配置」（API key 可解析）校验，而非全部注册模型。
    // 否则能存一个选择器里根本看不到、且必然运行时失败的 model id——设置面板显示
    // 「跟随默认」但每条消息都传它，/api/chat 拿到没配 key 的 provider 直接报错。
    // PUT 本就是 async，await listConfiguredModels() 无副作用。
    if (defaultModel !== null) {
      const configured = await listConfiguredModels();
      if (!configured.some((model) => model.id === defaultModel)) {
        throw new HTTPException(400, {
          message: `模型未配置或未注册：${defaultModel}（仅已配置 API key 的模型可设为默认）`,
        });
      }
    }

    const systemPrompt = parseNullableString(fields.systemPrompt, "systemPrompt");
    if (systemPrompt !== null && systemPrompt.length > SYSTEM_PROMPT_LENGTH_LIMIT) {
      throw new HTTPException(400, {
        message: `systemPrompt 不能超过 ${SYSTEM_PROMPT_LENGTH_LIMIT} 字`,
      });
    }

    const repo = createPreferencesRepository(getDb());
    const preferences = await repo.save(c.get("currentUser").id, { defaultModel, systemPrompt });
    return c.json({ preferences });
  })

  .post("/password", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "请求体必须是 JSON" });
    });
    const fields = body as { currentPassword?: unknown; newPassword?: unknown } | null;

    if (typeof fields?.currentPassword !== "string" || typeof fields?.newPassword !== "string") {
      throw new HTTPException(400, { message: "currentPassword 与 newPassword 必须是字符串" });
    }

    const user = c.get("currentUser");
    await getAuthService()
      .changePassword(user, fields.currentPassword, fields.newPassword)
      .catch(toHttpException);

    // 重新签发：改完密码当前会话不该掉线。
    // 这不会失效其他设备上的旧 token——JWT 无状态，见 CLAUDE.md「尚未实现」
    await issueToken(c, user);

    return c.json({ ok: true });
  });

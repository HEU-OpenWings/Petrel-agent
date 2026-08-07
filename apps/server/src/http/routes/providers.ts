import { listProviderModels, listProviderStatuses } from "@petrel/agent";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../types.ts";

/**
 * HEU-53 Settings「模型服务」面板的只读接口。
 *
 * 挂在 requireAuth 之下（与 /api/account 同级），任何登录用户都能看——这与
 * GET /api/account/preferences 返回已配置模型清单是同一个信任级别：知道「系统配了哪些
 * provider」本身不泄露敏感信息（env var 名是公开的，且不带 key 值）。
 *
 * 这一层刻意做薄：安全投影（把 pi 的 Provider/Model 投射成不含 baseUrl/headers/key 的
 * DTO、按 provider 分别 try/catch 隔离故障）全部在 packages/agent 里完成，路由只负责
 * HTTP 状态码、缓存头和 404 翻译。把投影放进 server 会让上层重新了解 pi 内部对象，
 * 既违反「pi 接线只在 agent」的边界，也增加误序列化明文 key 的风险。
 *
 * 凭据状态实时变化（改 .env 重启后不同），所以两个端点都带 Cache-Control: no-store。
 */
export const providers = new Hono<AppEnv>()
  .get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await listProviderStatuses());
  })

  .get("/:providerId/models", async (c) => {
    // 凭据状态实时变化，所有响应（含 404）都不缓存：新增同名 provider 后，
    // 暂存过的 404 会让客户端短期内继续以为它不存在。
    c.header("Cache-Control", "no-store");
    const providerId = c.req.param("providerId");
    const result = await listProviderModels(providerId);
    // provider 不在运行时注册表 → 404。不手造 providerId 语法校验：pi 的 Provider.id
    // 是任意字符串，自造 regex 可能让「列表能返回的新 provider 却查不到模型」自相矛盾。
    if (!result) {
      throw new HTTPException(404, { message: `未知的 provider：${providerId}` });
    }
    return c.json(result);
  });

import { createUserProviderService, UserProviderServiceError } from "@petrel/agent";
import { env } from "@petrel/config";
import { getDb } from "@petrel/database";
import { type Context, Hono } from "hono";
import { createRateLimiter, type RateLimiter } from "../../services/rate-limit.ts";
import type { AppEnv } from "../../types.ts";

type UserProviderService = ReturnType<typeof createUserProviderService>;

export type ProviderRouteService = Pick<
  UserProviderService,
  | "listProviders"
  | "listProviderModels"
  | "saveCredential"
  | "testCredential"
  | "deleteCredentialAndNormalizeDefaultModel"
>;

export interface CreateProvidersRoutesOptions {
  managementEnabled?: boolean;
  createService?: (userId: string) => ProviderRouteService;
  writeLimiter?: RateLimiter;
  testLimiter?: RateLimiter;
}

class InvalidProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderRequestError";
  }
}

function errorResponse(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof InvalidProviderRequestError) {
    return c.json({ error: { code: "INVALID_REQUEST", message: error.message } }, 400);
  }
  if (!(error instanceof UserProviderServiceError)) {
    return c.json(
      { error: { code: "PROVIDER_OPERATION_FAILED", message: "模型服务操作失败，请稍后重试" } },
      500,
    );
  }

  switch (error.kind) {
    case "provider_not_found":
      return c.json({ error: { code: "PROVIDER_NOT_FOUND", message: error.message } }, 404);
    case "invalid_api_key":
      return c.json({ error: { code: "INVALID_API_KEY", message: error.message } }, 400);
    case "credential_conflict":
      return c.json({ error: { code: "CREDENTIAL_CONFLICT", message: error.message } }, 409);
    case "credential_not_configured":
      return c.json({ error: { code: "CREDENTIAL_NOT_CONFIGURED", message: error.message } }, 409);
    case "credential_rejected":
      return c.json({ error: { code: "CREDENTIAL_REJECTED", message: error.message } }, 422);
    case "credential_test_failed":
    case "local_service_unavailable":
      return c.json({ error: { code: "CREDENTIAL_TEST_FAILED", message: error.message } }, 422);
    case "credential_store_unavailable":
      return c.json({ error: { code: "CREDENTIAL_STORE_UNAVAILABLE", message: error.message } }, 503);
    case "credential_test_timeout":
      return c.json({ error: { code: "CREDENTIAL_TEST_TIMEOUT", message: error.message } }, 504);
    case "management_disabled":
      // 生产中 management=false 时路由根本不会注册；若依赖注入配置不一致，保持 fail-closed。
      return c.json(
        { error: { code: "PROVIDER_OPERATION_FAILED", message: "模型服务操作失败，请稍后重试" } },
        500,
      );
  }
}

async function runOperation(c: Context<AppEnv>, operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new InvalidProviderRequestError("请求体必须是 JSON 对象");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidProviderRequestError("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function parseSaveBody(body: Record<string, unknown>): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "apiKey" || typeof body.apiKey !== "string") {
    throw new InvalidProviderRequestError("请求体必须且只能包含字符串 apiKey");
  }
  return body.apiKey;
}

function parseTestBody(body: Record<string, unknown>): { apiKey?: string } {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "apiKey")) {
    throw new InvalidProviderRequestError("请求体只能包含可选的字符串 apiKey");
  }
  if (!Object.hasOwn(body, "apiKey")) return {};
  if (typeof body.apiKey !== "string") {
    throw new InvalidProviderRequestError("apiKey 必须是字符串");
  }
  return { apiKey: body.apiKey };
}

function rateLimited(c: Context<AppEnv>): Response {
  return c.json({ error: { code: "CREDENTIAL_RATE_LIMITED", message: "凭据操作过于频繁，请稍后重试" } }, 429);
}

/**
 * HEU-54 当前用户 Provider 路由。
 *
 * GET 始终注册；management kill switch 关闭时不注册 PUT/POST/DELETE，令其自然 404。
 * 所有用户隔离只依赖 requireAuth 注入的 currentUser.id，任何 path/body/query userId 都不参与。
 */
export function createProvidersRoutes(options: CreateProvidersRoutesOptions = {}) {
  const managementEnabled = options.managementEnabled ?? env.providerCredentials.managementEnabled;
  const createService =
    options.createService ?? ((userId: string) => createUserProviderService(getDb(), userId));
  const writeLimiter =
    options.writeLimiter ??
    createRateLimiter(env.rateLimit.providerCredentialWriteMax, env.rateLimit.providerCredentialWindowMs);
  const testLimiter =
    options.testLimiter ??
    createRateLimiter(env.rateLimit.providerCredentialTestMax, env.rateLimit.providerCredentialWindowMs);

  const routes = new Hono<AppEnv>();

  // 中间件覆盖成功、显式错误和未注册写路由的自然 404。
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/", (c) =>
    runOperation(c, async () => {
      const service = createService(c.get("currentUser").id);
      return c.json(await service.listProviders());
    }),
  );

  routes.get("/:providerId/models", (c) =>
    runOperation(c, async () => {
      const service = createService(c.get("currentUser").id);
      const result = await service.listProviderModels(c.req.param("providerId"));
      if (!result) {
        throw new UserProviderServiceError("provider_not_found", "模型服务不存在");
      }
      return c.json(result);
    }),
  );

  if (managementEnabled) {
    routes.put("/:providerId/credential", (c) =>
      runOperation(c, async () => {
        const userId = c.get("currentUser").id;
        if (!writeLimiter.hit(userId)) return rateLimited(c);
        const apiKey = parseSaveBody(await readJsonObject(c));
        const service = createService(userId);
        return c.json(await service.saveCredential(c.req.param("providerId"), apiKey));
      }),
    );

    routes.post("/:providerId/test", (c) =>
      runOperation(c, async () => {
        const userId = c.get("currentUser").id;
        if (!testLimiter.hit(userId)) return rateLimited(c);
        const input = parseTestBody(await readJsonObject(c));
        const service = createService(userId);
        return c.json(await service.testCredential(c.req.param("providerId"), input));
      }),
    );

    routes.delete("/:providerId/credential", (c) =>
      runOperation(c, async () => {
        const userId = c.get("currentUser").id;
        if (!writeLimiter.hit(userId)) return rateLimited(c);
        const service = createService(userId);
        return c.json(await service.deleteCredentialAndNormalizeDefaultModel(c.req.param("providerId")));
      }),
    );
  }

  return routes;
}

export const providers = createProvidersRoutes();

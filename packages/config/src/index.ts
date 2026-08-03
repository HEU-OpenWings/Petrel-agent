/**
 * 全项目唯一读取 process.env 的位置。
 * 其他模块一律从这里导入 env，不要直接访问 process.env。
 */

type NodeEnv = "development" | "production" | "test";
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const NODE_ENVS: readonly NodeEnv[] = ["development", "production", "test"];
const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function oneOf<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`环境变量 ${name} 非法：${raw}，可选值为 ${allowed.join(" | ")}`);
  }
  return raw as T;
}

function port(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为 1-65535 的整数`);
  }
  return value;
}

/** 开发与测试环境的回落密钥。生产环境不允许走到这里，见 jwtSecret() */
const DEV_JWT_SECRET = "petrel-dev-secret-do-not-use-in-production";

/**
 * JWT 签名密钥。
 *
 * 生产环境必须显式提供：带着一个公开在源码里的默认密钥上线，
 * 等于任何人都能自己签一个 admin token。所以这里宁可让进程起不来。
 */
function jwtSecret(raw: string | undefined, nodeEnv: NodeEnv): string {
  const value = raw?.trim();
  if (value) return value;
  if (nodeEnv === "production") {
    throw new Error("生产环境必须提供 JWT_SECRET");
  }
  return DEV_JWT_SECRET;
}

/** 逗号分隔的 admin 邮箱名单。统一小写，与 users.email 的存储形式对齐 */
function adminEmails(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const nodeEnv = oneOf("NODE_ENV", process.env.NODE_ENV, NODE_ENVS, "development");

export const env = {
  nodeEnv,
  port: port("PORT", process.env.PORT, 5050),
  logLevel: oneOf("LOG_LEVEL", process.env.LOG_LEVEL, LOG_LEVELS, "info"),
  // compose 内用服务名 db，宿主机直连用 localhost
  databaseUrl: process.env.DATABASE_URL ?? "postgres://petrel:petrel@localhost:5432/petrel",
  jwtSecret: jwtSecret(process.env.JWT_SECRET, nodeEnv),
  adminEmails: adminEmails(process.env.ADMIN_EMAILS),
} as const;

export const isProduction = nodeEnv === "production";

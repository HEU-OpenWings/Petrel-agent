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

export const env = {
  nodeEnv: oneOf("NODE_ENV", process.env.NODE_ENV, NODE_ENVS, "development"),
  port: port("PORT", process.env.PORT, 5050),
  logLevel: oneOf("LOG_LEVEL", process.env.LOG_LEVEL, LOG_LEVELS, "info"),
  // compose 内用服务名 db，宿主机直连用 localhost
  databaseUrl: process.env.DATABASE_URL ?? "postgres://petrel:petrel@localhost:5432/petrel",
} as const;

export const isProduction = env.nodeEnv === "production";

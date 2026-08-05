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

/**
 * 以下三个函数（bool / ratio / positiveInt）对空串的处理与同文件的
 * `port()` / `oneOf()` 不同：空串按「未设置」处理，返回默认值，不抛错。
 * `.env` 里把值留空是「未设置」的惯用写法，为此让进程起不来是过度严格；
 * `port()` 对空串抛错（`Number("") === 0` 越界）是历史行为，不值得为了
 * 与它一致而传染过来。真正危险的是「看起来合理但非法的值」
 * （如 `0` / `1` / `yes` / `1.5`），那些仍然一律抛错。
 */

/**
 * 严格布尔。只认 "true" / "false"：接受 "1" / "yes" 这类写法会让
 * `COMPACTION_ENABLED=0`（作者以为是关）被当成 truthy 字符串静默开启。
 */
function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") {
    throw new Error(`环境变量 ${name} 非法：${raw}，只接受 true | false`);
  }
  return raw === "true";
}

/** 开区间比例。0 会让每轮都尝试压缩，1 会让压缩永不触发，两端都必须挡住 */
function ratio(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为 0 与 1 之间（不含两端）的小数`);
  }
  return value;
}

/** 压缩阈值的绝对上限。存在的理由不是防爆窗，而是控成本与延迟，见下方 compaction 字段注释 */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为正整数`);
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
  /**
   * 上下文自动压缩。阈值 = min(模型 contextWindow × thresholdRatio, absoluteCap)。
   *
   * absoluteCap 存在的理由不是防爆窗，而是控成本与延迟：默认模型窗口 1_000_000，
   * 0.8 就是 80 万 token，一次请求又慢又贵。对 64k（65536）的备选模型这个上限不起作用
   * （52.4k < 120000），所以两个数各管一头。见 docs/superpowers/specs/2026-08-05-auto-compaction-design.md §7
   */
  compaction: {
    enabled: bool("COMPACTION_ENABLED", process.env.COMPACTION_ENABLED, true),
    thresholdRatio: ratio("COMPACTION_THRESHOLD_RATIO", process.env.COMPACTION_THRESHOLD_RATIO, 0.8),
    absoluteCap: positiveInt("COMPACTION_ABSOLUTE_CAP", process.env.COMPACTION_ABSOLUTE_CAP, 120_000),
  },
} as const;

export const isProduction = nodeEnv === "production";

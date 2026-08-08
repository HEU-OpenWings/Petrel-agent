/**
 * 全项目唯一读取 process.env 的位置。
 * 其他模块一律从这里导入 env，不要直接访问 process.env。
 */

type NodeEnv = "development" | "production" | "test";
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type MailTransport = "console" | "smtp";

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
 * 以下四个函数（bool / ratio / positiveInt / nonNegativeInt）对空串的处理与同文件的
 * `port()` / `oneOf()` 不同：空串按「未设置」处理，返回默认值，不抛错。
 * `.env` 里把值留空是「未设置」的惯用写法，为此让进程起不来是过度严格；
 * `port()` 对空串抛错（`Number("") === 0` 越界）是历史行为，不值得为了
 * 与它一致而传染过来。真正危险的是「看起来合理但非法的值」
 * （如 `0` / `1` / `yes` / `1.5`），那些仍然一律抛错。
 *
 * 特别地，`nonNegativeInt` 也必须判空串：否则 `QUOTA_TOKEN_LIMIT=`（dotenv 下是
 * `""` 而非 `undefined`）→ `Number("") === 0` → 通过整数校验 → 额度 0，enforcement
 * 开启后表现为全员被拒且提示「联系管理员」，排查方向完全被带偏；
 * `QUOTA_WINDOW_HOURS=` 同理 → 窗口 0 → 配额永不生效（静默失效）。
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

/**
 * 简单字符串配置。空串按「未设置」处理（与 bool / ratio / positiveInt 同口径）。
 * 用于 baseUrl 这类没有固定校验规则的自由文本。不做 trim：URL 里的空格本就非法，
 * 让它原样透传比悄悄改写更易定位问题。
 *
 * 保留 `name` 形参与同文件的 port/bool/ratio 等校验函数签名一致，便于将来给
 * 字符串加格式校验时复用；当前不做校验故未使用，前缀下划线表明有意。
 */
function stringEnv(_name: string, raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

/** 非负整数（含 0）。HEU-40 配额参数：token 上限、窗口小时数都用它。 */
function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`环境变量 ${name} 非法：${raw}，应为非负整数`);
  }
  return value;
}

/**
 * 布尔开关。接受 "true"/"false"（大小写不敏感），缺失走 fallback。
 * HEU-40 的 enforcement 用它：分阶段上线——先部署计量（off，只落库不拦截），
 * 验证事实一致后再开 on 拦截，最后才开放注册。
 */
function booleanEnv(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  throw new Error(`环境变量 ${name} 非法：${raw}，应为 true 或 false`);
}

/**
 * 邮件传输通道。
 *
 * 开发与测试默认 `console`（邮件打到日志，含验证/重置链接），零外部依赖即可跑通；
 * 生产环境**必须** `smtp`——console 传输下验证/重置邮件永远发不出去，
 * 等于把用户锁在门外，所以宁可与 JWT_SECRET 一样让进程起不来。
 */
function mailTransport(raw: string | undefined, nodeEnv: NodeEnv): MailTransport {
  if (raw === "console" || raw === "smtp") return raw;
  if (nodeEnv === "production") {
    throw new Error("生产环境必须配置 MAIL_TRANSPORT=smtp");
  }
  return "console";
}

/** SMTP 服务器地址。生产环境缺失即启动失败；非生产不校验（console 传输用不到） */
function smtpHost(raw: string | undefined, nodeEnv: NodeEnv): string {
  const value = raw?.trim();
  if (value) return value;
  if (nodeEnv === "production") {
    throw new Error("生产环境必须配置 SMTP_HOST");
  }
  return "";
}

/** 从分钟换算毫秒的限流窗口。minutes 必须是正整数，非法即启动失败 */
function windowMs(name: string, raw: string | undefined, fallbackMinutes: number): number {
  return positiveInt(name, raw, fallbackMinutes) * 60_000;
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
  // 邮箱验证开关。默认 true（安全默认）；开发/内网演示可关掉（注册即登录、不发验证邮件）
  emailVerificationEnabled: bool("EMAIL_VERIFICATION_ENABLED", process.env.EMAIL_VERIFICATION_ENABLED, true),
  /** 邮件里的链接前缀。生产必须指到站点对外域名 */
  publicApiUrl: process.env.PUBLIC_API_URL?.trim() || "http://localhost:5050",
  /** 后端渲染 HTML 页里的「返回登录」链接（前端 SPA 地址） */
  publicWebUrl: process.env.PUBLIC_WEB_URL?.trim() || "http://localhost:5173",
  mail: {
    transport: mailTransport(process.env.MAIL_TRANSPORT, nodeEnv),
    from: process.env.MAIL_FROM?.trim() || "Petrel <no-reply@petrel.local>",
    smtp: {
      host: smtpHost(process.env.SMTP_HOST, nodeEnv),
      port: port("SMTP_PORT", process.env.SMTP_PORT, 587),
      secure: bool("SMTP_SECURE", process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER?.trim() || "",
      password: process.env.SMTP_PASSWORD ?? "",
    },
  },
  rateLimit: {
    // 注册限流按 IP；默认 5 次 / 15 分钟
    registerMax: positiveInt("REGISTER_RATE_LIMIT_MAX", process.env.REGISTER_RATE_LIMIT_MAX, 5),
    registerWindowMs: windowMs(
      "REGISTER_RATE_LIMIT_WINDOW_MINUTES",
      process.env.REGISTER_RATE_LIMIT_WINDOW_MINUTES,
      15,
    ),
    // 忘记密码 / 重发验证限流按邮箱；默认 3 次 / 15 分钟
    authMailMax: positiveInt("AUTH_MAIL_RATE_LIMIT_MAX", process.env.AUTH_MAIL_RATE_LIMIT_MAX, 3),
    authMailWindowMs: windowMs(
      "AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES",
      process.env.AUTH_MAIL_RATE_LIMIT_WINDOW_MINUTES,
      15,
    ),
  },
  /**
   * vLLM 本地服务的 baseUrl。vLLM 不像 Ollama 有约定俗成的默认端口，
   * 实际地址取决于本机启动参数（`--host` / `--port`），所以从 env 读。
   *
   * 走 @petrel/config 而非 pi-ai 的 auth 机制：pi-ai 只识别凭据类 env
   * （API key / OAuth），不解析 baseUrl。留空时回落到最常见的 `:8000/v1`。
   */
  vllmBaseUrl: stringEnv("VLLM_BASE_URL", process.env.VLLM_BASE_URL, "http://localhost:8000/v1"),
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
  // HEU-40 配额。默认值是 dev 占位：生产开放注册前必须据真实用量分布重新配置，
  // 不能靠这个默认值上线。enforcement=false 时只计量（双写 token_usage）不拦截，
  // 便于分阶段验证事实一致性后再开拦截。
  quotaTokenLimit: nonNegativeInt("QUOTA_TOKEN_LIMIT", process.env.QUOTA_TOKEN_LIMIT, 1_000_000),
  quotaWindowHours: nonNegativeInt("QUOTA_WINDOW_HOURS", process.env.QUOTA_WINDOW_HOURS, 24),
  quotaEnforcement: booleanEnv("QUOTA_ENFORCEMENT", process.env.QUOTA_ENFORCEMENT, false),
} as const;

export const isProduction = nodeEnv === "production";

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

/**
 * HEU-54 R1 provider 凭据加密密钥（AES-256-GCM，32 字节）。
 *
 * 用标准 base64 编码（44 字符，含 1 个 = padding），不是 base64url。
 * 校验：精确 44 字符 → 解码精确 32 字节 → 再编码必须与输入逐字符相等（拒绝 Node
 * Buffer 的宽松容错，如内嵌空白、非法字符被忽略）。
 *
 * **只在 storedEnabled 或 managementEnabled 任一为 true 时才校验与要求**：
 * 两个开关都 false 时（即 R0 行为），就算 env 里留了非法 key 也不解析、不报错，
 * 保证 kill switch 能完整回退到 R0。任一开关开而 key 缺失/非法 → 启动失败，
 * 不静默回落到某个默认 key（否则所有人用同一个公开 key 加密，等于明文）。
 *
 * 不给 dev/test 默认值：与 JWT_SECRET 不同，加密 key 没有安全的公开回落值——
 * 一旦写死在源码里，开发者本机存的凭据就等于明文。要开 R1 就必须显式生成一个。
 *
 * 返回 Uint8Array 而非 base64 字符串：调用方（crypto 模块）要的是密钥字节，
 * 直接返回字节能避免 key 在多处缓存成字符串。返回前复制一份，防止外部改 Uint8Array。
 */
function providerCredentialEncryptionKey(raw: string | undefined, required: boolean): Uint8Array | undefined {
  if (!required) return undefined;
  const value = raw?.trim() ?? "";
  if (!value) {
    throw new Error(
      "PROVIDER_CREDENTIAL_ENCRYPTION_KEY 未配置：开启 provider 凭据功能（PROVIDER_STORED_CREDENTIALS_ENABLED 或 PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED）时必须提供 32 字节 base64 编码的加密密钥。生成方式：node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  // 精确 44 字符（32 字节 base64 含 1 个 padding =）
  if (value.length !== 44) {
    throw new Error(
      `PROVIDER_CREDENTIAL_ENCRYPTION_KEY 非法：长度应为 44（32 字节的标准 base64），实际 ${value.length}`,
    );
  }
  // 只接受标准 base64 字符集，拒绝 base64url（- _）和非法字符
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(
      "PROVIDER_CREDENTIAL_ENCRYPTION_KEY 非法：只接受标准 base64 字符（A-Z a-z 0-9 + / 与末尾 =）",
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new Error("PROVIDER_CREDENTIAL_ENCRYPTION_KEY 非法：无法解码为 base64");
  }
  if (bytes.length !== 32) {
    throw new Error(`PROVIDER_CREDENTIAL_ENCRYPTION_KEY 非法：解码后应为 32 字节，实际 ${bytes.length}`);
  }
  // round-trip：解码再编码必须与输入逐字符相等。Buffer.from 的 base64 解码对某些
  // 非法输入会宽松处理（忽略内嵌空白等），这一步堵住它——密钥必须严格规范。
  if (bytes.toString("base64") !== value) {
    throw new Error("PROVIDER_CREDENTIAL_ENCRYPTION_KEY 非法：base64 编码不规范（解码再编码与输入不一致）");
  }
  // 复制一份返回，防止调用方修改原 Buffer
  return new Uint8Array(bytes);
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

// HEU-54 R1 provider 凭据。两个 kill switch 默认 false（完整 R0 行为）：
// storedEnabled 控制运行时是否读用户 DB 凭据装配 per-session Models；
// managementEnabled 控制 HTTP 写端点（保存/测试/删除凭据）是否开放。
// 任一为 true 时必须提供合法的 PROVIDER_CREDENTIAL_ENCRYPTION_KEY（见上方校验）。
const providerStoredCredentialsEnabled = booleanEnv(
  "PROVIDER_STORED_CREDENTIALS_ENABLED",
  process.env.PROVIDER_STORED_CREDENTIALS_ENABLED,
  false,
);
const providerCredentialManagementEnabled = booleanEnv(
  "PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED",
  process.env.PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED,
  false,
);

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
    // HEU-54 凭据写/test 限流按 userId（已在 requireAuth 下）。单实例内存，
    // 重启即失效、多副本不共享（与登录失败限流同一局限，随 HEU-43 迁 Redis）
    providerCredentialWriteMax: positiveInt(
      "PROVIDER_CREDENTIAL_WRITE_RATE_LIMIT_MAX",
      process.env.PROVIDER_CREDENTIAL_WRITE_RATE_LIMIT_MAX,
      10,
    ),
    providerCredentialTestMax: positiveInt(
      "PROVIDER_CREDENTIAL_TEST_RATE_LIMIT_MAX",
      process.env.PROVIDER_CREDENTIAL_TEST_RATE_LIMIT_MAX,
      5,
    ),
    providerCredentialWindowMs: windowMs(
      "PROVIDER_CREDENTIAL_RATE_LIMIT_WINDOW_MINUTES",
      process.env.PROVIDER_CREDENTIAL_RATE_LIMIT_WINDOW_MINUTES,
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
  /**
   * HEU-54 R1 provider 凭据（用户自填 API key）。两个开关构成 kill switch 矩阵：
   *
   *   stored   management   行为
   *   false    false        完整 R0：global Models/env、写端点 404、不要求加密密钥
   *   false    true         可预灌/删除/检查个人 key，但对话仍用 R0 env（部署过渡）
   *   true     false        runtime 用已有个人 key，冻结写操作
   *   true     true         完整 R1
   *
   * 开关是启动配置，不热切换：改完必须 docker compose up -d（不能 restart，坑 1）。
   * storedEnabled=false 时 harness 装配回落 global Models，行为与 R0 完全一致。
   */
  providerCredentials: {
    storedEnabled: providerStoredCredentialsEnabled,
    managementEnabled: providerCredentialManagementEnabled,
    // 任一开关开才要求 key；都关时 key 不解析（即使 env 里留了非法值也能起）
    encryptionKey: providerCredentialEncryptionKey(
      process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY,
      providerStoredCredentialsEnabled || providerCredentialManagementEnabled,
    ),
  },
} as const;

export const isProduction = nodeEnv === "production";

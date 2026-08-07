import { createHash, randomBytes } from "node:crypto";
import { env } from "@petrel/config";
import { createUserRepository, type Database, getDb, type PublicUser } from "@petrel/database";
import { logger } from "@petrel/logger";
import { isUniqueViolation } from "./db-errors.ts";
import { escapeHtml } from "./html.ts";
import { getMailer, type Mailer } from "./mailer.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { createRateLimiter } from "./rate-limit.ts";

/** 带 HTTP 状态码的业务错误。route 层把它翻译成 HTTPException */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
/** 邮箱验证链接 24h、密码重置链接 30min 内有效 */
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 邮箱真伪由验证链接证明；重置邮件本身就是邮箱所有权证明 */
const VERIFY_MAIL_SUBJECT = "验证你的 Petrel 邮箱";
const RESET_MAIL_SUBJECT = "重置你的 Petrel 密码";

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 库里只存哈希：即便数据库泄露，链接也不能被伪造 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertPasswordValid(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AuthError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`, 400);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(`密码不能超过 ${PASSWORD_MAX_LENGTH} 位`, 400);
  }
}

function verificationMail(link: string): { text: string; html: string } {
  return {
    text: `打开下面的链接验证邮箱（24 小时内有效）：\n\n${link}\n\n如果不是你注册的，请忽略这封邮件。`,
    html: `<p>打开下面的链接验证邮箱（24 小时内有效）：</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  };
}

function resetMail(link: string): { text: string; html: string } {
  return {
    text: `打开下面的链接重置密码（30 分钟内有效）：\n\n${link}\n\n如果不是你申请的，请忽略这封邮件，你的密码不会变化。`,
    html: `<p>打开下面的链接重置密码（30 分钟内有效）：</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  };
}

/**
 * 邮箱格式只做基本形状校验：本轮不验证邮箱真实性（那要邮件发送基础设施），
 * 这里挡住的是明显不是邮箱的输入，不追求 RFC 5322 完备。
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * 登录失败一律用同一句文案。
 *
 * 区分「邮箱不存在」和「密码错误」会把登录端点变成账号枚举器——
 * 对开放注册的系统等于白送一份用户名单。限流触发时也用它，
 * 不让攻击者知道自己已经打到阈值。
 */
const LOGIN_FAILED_MESSAGE = "邮箱或密码不正确";

/**
 * 改密码的失败文案可以具体，不像登录那样必须统一。
 * 走到这个端点的人已经通过 requireAuth，「当前密码不正确」不泄漏任何身份信息。
 */
const CHANGE_PASSWORD_FAILED_MESSAGE = "当前密码不正确";
const TOO_MANY_ATTEMPTS_MESSAGE = "尝试次数过多，请 15 分钟后再试";

export function createAuthService(db: Database, mailer: Mailer = getMailer()) {
  const userRepo = createUserRepository(db);

  // 关闭邮箱验证只服务于开发 / 内网演示：注册即登录等于放弃了邮箱所有权这道闸，
  // 公开部署必须保持 true。醒目告警而非 throw（内网部署确实可能不需要它）。
  if (!env.emailVerificationEnabled) {
    logger.warn(
      "EMAIL_VERIFICATION_ENABLED=false：注册即登录、不发送验证邮件（仅限开发/内网演示，公开部署请保持 true）",
    );
  }

  /**
   * 忘记密码 / 重发验证的限流（按邮箱）。单实例内存，与登录失败限流同一类
   * 实现与取舍；多副本共享计数在风控 issue。
   */
  const emailSendLimiter = createRateLimiter(env.rateLimit.authMailMax, env.rateLimit.authMailWindowMs);

  /**
   * 登录失败计数。单实例内存，重启失效，多副本部署下无效——
   * 正式修法在风控轮（Redis）。
   */
  const failures = new Map<string, { count: number; firstFailAt: number }>();

  /** 惰性清理：不清的话被大量不同邮箱打一遍就是无界增长 */
  function pruneExpired(now: number): void {
    for (const [email, record] of failures) {
      if (now - record.firstFailAt > LOCKOUT_MS) failures.delete(email);
    }
  }

  function isLockedOut(email: string, now: number): boolean {
    const record = failures.get(email);
    if (!record) return false;
    if (now - record.firstFailAt > LOCKOUT_MS) {
      failures.delete(email);
      return false;
    }
    return record.count >= MAX_FAILURES;
  }

  function recordFailure(email: string, now: number): void {
    const record = failures.get(email);
    if (!record || now - record.firstFailAt > LOCKOUT_MS) {
      failures.set(email, { count: 1, firstFailAt: now });
      return;
    }
    record.count += 1;
  }

  /** admin 名单在注册与每次登录时生效，改完 .env 重启即可，不需要改库 */
  function shouldBeAdmin(email: string): boolean {
    return env.adminEmails.includes(email);
  }

  async function sendVerificationEmail(user: PublicUser): Promise<void> {
    const token = randomToken();
    await userRepo.setEmailVerifyToken(user.id, hashToken(token), new Date(Date.now() + VERIFY_TOKEN_TTL_MS));
    const link = `${env.publicApiUrl}/api/auth/verify-email?token=${token}`;
    await mailer.send({
      to: user.email,
      subject: VERIFY_MAIL_SUBJECT,
      ...verificationMail(link),
    });
  }

  async function sendPasswordResetEmail(user: PublicUser): Promise<void> {
    const token = randomToken();
    await userRepo.setPasswordResetToken(
      user.id,
      hashToken(token),
      new Date(Date.now() + RESET_TOKEN_TTL_MS),
    );
    const link = `${env.publicApiUrl}/api/auth/reset-password?token=${token}`;
    await mailer.send({
      to: user.email,
      subject: RESET_MAIL_SUBJECT,
      ...resetMail(link),
    });
  }

  return {
    async register(
      rawEmail: string,
      password: string,
    ): Promise<{ user: PublicUser; verificationSent: boolean }> {
      const email = rawEmail.trim().toLowerCase();

      if (!EMAIL_PATTERN.test(email)) {
        throw new AuthError("邮箱格式不正确", 400);
      }
      assertPasswordValid(password);

      // 先查一次给出友好的 409。仍有并发下同时通过检查的可能，
      // 所以下面的 create 撞唯一约束时也要翻译成 409 而不是 500
      if (await userRepo.findByEmail(email)) {
        throw new AuthError("该邮箱已注册", 409);
      }

      const passwordHash = await hashPassword(password);
      const role = shouldBeAdmin(email) ? "admin" : "user";

      let user: PublicUser;
      try {
        // 验证开关关闭时直接建出已验证用户：不发邮件、注册即可登录（内网演示）
        user = await userRepo.create({
          email,
          passwordHash,
          role,
          emailVerifiedAt: env.emailVerificationEnabled ? null : new Date(),
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthError("该邮箱已注册", 409);
        }
        throw error;
      }

      if (!env.emailVerificationEnabled) {
        return { user, verificationSent: false };
      }

      // 注册即发验证邮件。邮件发送失败**不**让注册失败：
      // 用户已建出，返回 201 + verificationSent=false，前端据此提示重发验证邮件
      // （/api/auth/resend-verification）。
      try {
        await sendVerificationEmail(user);
        return { user, verificationSent: true };
      } catch (error) {
        logger.warn({ err: error, email }, "验证邮件发送失败，注册仍成功（客户端可重发）");
        return { user, verificationSent: false };
      }
    },

    async login(rawEmail: string, password: string): Promise<PublicUser> {
      const email = rawEmail.trim().toLowerCase();
      const now = Date.now();
      pruneExpired(now);

      // 到阈值就直接拒，不再验密码。
      // 反过来（照常验密码、对了就放行）能避免被拿来锁别人的账号，
      // 但会让攻击者无限触发 scrypt——每次 64MB 内存，并发一拉就是内存耗尽，
      // 那是比短时锁号更严重的问题。
      if (isLockedOut(email, now)) {
        throw new AuthError(LOGIN_FAILED_MESSAGE, 429);
      }

      const found = await userRepo.findByEmail(email);

      // 账号不存在时也要走一次哈希校验，让两条路径的耗时接近，
      // 否则响应时间本身就泄漏了「这个邮箱是否注册过」
      const passwordOk = found
        ? await verifyPassword(password, found.passwordHash)
        : await verifyPassword(password, "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");

      if (!found || !passwordOk) {
        recordFailure(email, now);
        throw new AuthError(LOGIN_FAILED_MESSAGE, 401);
      }

      // 这句文案与上面的统一文案不同，但不构成账号枚举：
      // 它排在密码校验之后，只有已经知道正确密码的人才看得到。
      // 顺序不能调换——先查 disabled 再验密码，就等于告诉任何人这个邮箱存在
      if (found.disabled) {
        throw new AuthError("账号已被禁用", 401);
      }

      // 与 disabled 同位置：排在密码校验之后，只有知道正确密码的人才看得到，
      // 不构成账号枚举。未验证就放行等于邮箱验证形同虚设。
      // EMAIL_VERIFICATION_ENABLED=false（开发/内网演示）时跳过这道闸
      if (env.emailVerificationEnabled && !found.emailVerifiedAt) {
        throw new AuthError("邮箱尚未验证，请先查收验证邮件", 403);
      }

      failures.delete(email);

      // 名单里的既有用户在这里提权，不做反向降级：
      // 误编辑 .env 不应该一次性清空管理权限
      if (shouldBeAdmin(email) && found.role !== "admin") {
        await userRepo.setRole(found.id, "admin");
        return { ...toPublic(found), role: "admin" };
      }

      return toPublic(found);
    },

    /**
     * 验证邮箱。幂等：已验证的账号再带 token 访问也返回成功——
     * token 哈希保留不删（见 users.ts setEmailVerified 的注释），
     * 重复点击链接不会变成「链接无效」。token 无效或过期走 400。
     */
    async verifyEmail(rawToken: string): Promise<PublicUser> {
      const user = await userRepo.findByEmailVerifyToken(hashToken(rawToken.trim()));
      if (!user) {
        throw new AuthError("验证链接无效或已过期", 400);
      }
      if (user.emailVerifiedAt) {
        return toPublic(user);
      }
      if (!user.emailVerifyTokenExpiresAt || Date.now() > user.emailVerifyTokenExpiresAt.getTime()) {
        throw new AuthError("验证链接无效或已过期", 400);
      }
      const verifiedAt = new Date();
      await userRepo.setEmailVerified(user.id, verifiedAt);
      return toPublic({ ...user, emailVerifiedAt: verifiedAt });
    },

    /**
     * 重发验证邮件。恒成功（账号不存在或已验证时静默 no-op）——防枚举；
     * 限流按邮箱，避免拿它轰炸收件箱。
     */
    async resendVerification(rawEmail: string): Promise<void> {
      const email = rawEmail.trim().toLowerCase();
      if (!emailSendLimiter.hit(email)) {
        throw new AuthError("请求过于频繁，请稍后再试", 429);
      }
      const user = await userRepo.findByEmail(email);
      if (!user || user.emailVerifiedAt) return;
      await sendVerificationEmail(user);
    },

    /**
     * 申请密码重置。恒 200（不泄露账号是否存在）；账号存在时生成重置 token 并发邮件。
     */
    async forgotPassword(rawEmail: string): Promise<void> {
      const email = rawEmail.trim().toLowerCase();
      if (!emailSendLimiter.hit(email)) {
        throw new AuthError("请求过于频繁，请稍后再试", 429);
      }
      const user = await userRepo.findByEmail(email);
      if (!user) return;
      await sendPasswordResetEmail(user);
    },

    /** 重置页打开时校验链接，无效直接给错误页，省得用户填完新密码才被告知 */
    async isResetTokenValid(rawToken: string): Promise<boolean> {
      const user = await userRepo.findByPasswordResetToken(hashToken(rawToken.trim()));
      if (!user) return false;
      return Boolean(
        user.passwordResetTokenExpiresAt && Date.now() <= user.passwordResetTokenExpiresAt.getTime(),
      );
    },

    /**
     * 用重置 token 设置新密码。成功后清空重置 token，并把邮箱顺带标记为已验证
     * （见 repository.resetPassword 的注释）。不使其他设备的旧 JWT 失效——
     * 需要 tokenVersion，属已记录的后续项。
     */
    async resetPassword(rawToken: string, newPassword: string): Promise<void> {
      assertPasswordValid(newPassword);
      const user = await userRepo.findByPasswordResetToken(hashToken(rawToken.trim()));
      if (!user?.passwordResetTokenExpiresAt) {
        throw new AuthError("重置链接无效或已过期", 400);
      }
      if (Date.now() > user.passwordResetTokenExpiresAt.getTime()) {
        throw new AuthError("重置链接无效或已过期", 400);
      }
      await userRepo.resetPassword(user.id, await hashPassword(newPassword), new Date());
      // 解除登录失败锁定：用户刚用重置邮件证明过身份，不该继续吃「尝试次数过多」
      failures.delete(user.email);
    },

    /**
     * 改密码。调用方必须已通过 requireAuth，user 是库里查出来的当前用户。
     *
     * 注意本方法不会失效其他设备上的旧 token——JWT 无状态，7 天内仍然有效。
     * 彻底解决要给 users 加 tokenVersion 并让 requireAuth 比对，见 CLAUDE.md「尚未实现」。
     */
    async changePassword(user: PublicUser, currentPassword: string, newPassword: string): Promise<void> {
      const email = user.email;
      const now = Date.now();
      pruneExpired(now);

      // 与 login 共用同一个 failures：这个端点同样能无限触发 scrypt（每次 64MB），
      // 不限流的话并发一拉就是内存耗尽。共用的副作用是改密码连错 5 次也会锁住
      // 登录 15 分钟——有意的取舍，人已经在登录态里，锁住的只是重新登录
      if (isLockedOut(email, now)) {
        throw new AuthError(TOO_MANY_ATTEMPTS_MESSAGE, 429);
      }

      // 长度校验排在验旧密码之前：新密码不合规时不该先白跑一次 scrypt，
      // 也不该把这种输入错误计进失败次数
      if (newPassword.length < PASSWORD_MIN_LENGTH) {
        throw new AuthError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`, 400);
      }
      if (newPassword.length > PASSWORD_MAX_LENGTH) {
        throw new AuthError(`密码不能超过 ${PASSWORD_MAX_LENGTH} 位`, 400);
      }

      // findById 只返回 PublicUser，拿不到哈希，所以按 email 查
      const found = await userRepo.findByEmail(email);
      // requireAuth 刚确认过这个用户存在，查不到只能是并发删号
      if (!found) {
        throw new AuthError(CHANGE_PASSWORD_FAILED_MESSAGE, 401);
      }

      if (!(await verifyPassword(currentPassword, found.passwordHash))) {
        recordFailure(email, now);
        // 401 留给 requireAuth 表示登录态失效；这里用户已经通过会话认证，
        // 只是没有提供正确的当前密码，用 403 让前端能可靠地区分两种情况。
        throw new AuthError(CHANGE_PASSWORD_FAILED_MESSAGE, 403);
      }

      failures.delete(email);
      await userRepo.setPasswordHash(found.id, await hashPassword(newPassword));
    },
  };
}

function toPublic(user: PublicUser & { passwordHash: string }): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

/**
 * 全应用共用一个实例。
 *
 * 失败计数存在实例内部（上面的 failures），两个路由各建一个实例就是两套计数器：
 * 改密码那边打满 5 次，登录这边毫无察觉——而它挡的正是「无限触发 scrypt
 * 导致内存耗尽」，绕过去就没有意义了。
 *
 * 惰性初始化保留「只导入 app 不连接数据库」的测试能力：getDb() 会建连接池，
 * 在模块顶层调用会让校验类用例也必须有一个真数据库。
 */
let instance: ReturnType<typeof createAuthService> | undefined;

export function getAuthService(): ReturnType<typeof createAuthService> {
  instance ??= createAuthService(getDb());
  return instance;
}

/**
 * 测试专用：丢弃单例，让下一个 getAuthService() 拿到全新的限流计数。
 * 路由测试的 beforeEach 会调它，否则同文件里跨用例的 IP/邮箱计数会串。
 */
export function __resetAuthLimits(): void {
  instance = undefined;
}

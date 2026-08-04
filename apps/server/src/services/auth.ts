import { env } from "@petrel/config";
import { createUserRepository, type Database, type PublicUser } from "@petrel/database";
import { isUniqueViolation } from "./db-errors.ts";
import { hashPassword, verifyPassword } from "./password.ts";

/** 带 HTTP 状态码的业务错误。route 层把它翻译成 HTTPException */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 | 429,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;

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

export function createAuthService(db: Database) {
  const userRepo = createUserRepository(db);

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

  return {
    async register(rawEmail: string, password: string): Promise<PublicUser> {
      const email = rawEmail.trim().toLowerCase();

      if (!EMAIL_PATTERN.test(email)) {
        throw new AuthError("邮箱格式不正确", 400);
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        throw new AuthError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`, 400);
      }
      if (password.length > PASSWORD_MAX_LENGTH) {
        throw new AuthError(`密码不能超过 ${PASSWORD_MAX_LENGTH} 位`, 400);
      }

      // 先查一次给出友好的 409。仍有并发下同时通过检查的可能，
      // 所以下面的 create 撞唯一约束时也要翻译成 409 而不是 500
      if (await userRepo.findByEmail(email)) {
        throw new AuthError("该邮箱已注册", 409);
      }

      const passwordHash = await hashPassword(password);
      const role = shouldBeAdmin(email) ? "admin" : "user";

      try {
        return await userRepo.create({ email, passwordHash, role });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthError("该邮箱已注册", 409);
        }
        throw error;
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

      failures.delete(email);

      // 名单里的既有用户在这里提权，不做反向降级：
      // 误编辑 .env 不应该一次性清空管理权限
      if (shouldBeAdmin(email) && found.role !== "admin") {
        await userRepo.setRole(found.id, "admin");
        return { ...toPublic(found), role: "admin" };
      }

      return toPublic(found);
    },
  };
}

function toPublic(user: PublicUser & { passwordHash: string }): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
  };
}

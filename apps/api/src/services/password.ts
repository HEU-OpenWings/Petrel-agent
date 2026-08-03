import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify<string, Buffer, number, object, Buffer>(scrypt);

/**
 * scrypt 参数。OWASP 推荐的量级，N 越大越抗离线爆破，代价是每次登录的 CPU 与内存。
 *
 * maxmem 必须显式给：Node 的默认上限是 32MB，而 N=65536、r=8 需要
 * 128 * N * r = 64MB，不调高会直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS，
 * 且报错信息不指向根因。
 */
const SCRYPT_OPTIONS = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const ALGORITHM = "scrypt";

/** 存储格式 scrypt$<salt_base64>$<hash_base64> */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(plain, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${ALGORITHM}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * 任何格式异常一律返回 false，不抛错。
 *
 * 库里存着格式不合法的哈希是正常状态——默认用户的占位值就是 "!"，
 * 表示「这个账号不可登录」。让它抛错会把一次正常的登录失败变成 500。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;

  const [, saltStr, hashStr] = parts;
  const salt = Buffer.from(saltStr, "base64");
  const expected = Buffer.from(hashStr, "base64");
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  const derived = await scryptAsync(plain, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  // timingSafeEqual 要求两边等长，长度已在上面校验过
  return timingSafeEqual(derived, expected);
}

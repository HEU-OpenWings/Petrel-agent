import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * HEU-54 R1 用户 provider 凭据的 AES-256-GCM 加解密（HEU-54 R1）。
 *
 * 明文 API key 只在两个边界短暂存在：用户输入 → encrypt → 写库；读库 → decrypt → 喂给 pi。
 * DB 只存密文 envelope（nonce / ciphertext / authTag 分列）。本模块是全仓唯一的加解密点。
 *
 * 安全设计：
 * - AES-256-GCM：每次加密用随机 12 字节 nonce（GCM 的 nonce 重用会破坏安全性），
 *   16 字节 auth tag 防篡改。
 * - AAD（additional authenticated data）绑定 envelope 上下文
 *   `["petrel-provider-credential", 1, userId, providerId, keyId]`：即使密文被复制到
 *   另一个 (userId, providerId) 或用另一个 master key 的行，解密会失败——
 *   防止 DB 行被调换/跨用户挪用。
 * - keyId = base64url(SHA-256(masterKey) 前 16 字节)：标识用哪个 master key 加密，
 *   不是密钥本身。为将来密钥轮换留接口（按 keyId 分批重加密）；当前只有一个 active key。
 * - master key 字节在工厂里复制一份，调用方拿到的是独立 Uint8Array。
 * - 错误一律是固定泛化文案的安全 domain error，绝不携带原始 crypto message、
 *   ciphertext、AAD 或 key 片段——pi 会把 store error 的 detail 拼进 ModelsError，
 *   所以这里抛出的 message 就是最终可能进入日志/响应的全部内容。
 */

/** envelope 格式版本。当前固定 1，与 DB 的 format_version CHECK 对齐 */
export const ENVELOPE_FORMAT_VERSION = 1;

/** 加密后的 envelope（分列存 DB，不塞 jsonb 以绕过 NOT NULL/字符集 CHECK） */
export interface ProviderCredentialEnvelope {
  formatVersion: number;
  /** 标识加密用的 master key：base64url(SHA-256(masterKey) 前 16 字节)，22 字符 */
  keyId: string;
  /** 12 字节 nonce 的 base64url，16 字符 */
  nonce: string;
  /** 密文的 base64url */
  ciphertext: string;
  /** 16 字节 GCM auth tag 的 base64url，22 字符 */
  authTag: string;
}

/** 加密入口（构造 envelope）与解密入口（验 envelope）共用的最小接口 */
export interface ProviderCredentialCipher {
  /** 加密明文 key → envelope。同一明文两次加密的 nonce/ciphertext 必不同 */
  encrypt(plaintext: { userId: string; providerId: string; apiKey: string }): ProviderCredentialEnvelope;
  /** 解密 envelope → 明文 key。AAD 或密文不匹配、keyId 不认识一律抛安全 domain error */
  decrypt(envelope: { userId: string; providerId: string; envelope: ProviderCredentialEnvelope }): string;
  /** 当前 active key 的 keyId（用于加密时写入、校验已存行的 keyId） */
  readonly activeKeyId: string;
}

/** base64url 编码（无 padding），与 DB 的字符集 CHECK（^[A-Za-z0-9_-]+$）对齐 */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url 解码。非法字符/格式抛安全错误 */
function fromBase64Url(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProviderCredentialCryptoError(`decrypt_failed`, `${label} 字符集非法（应为 base64url）`);
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/**
 * 安全 domain error：固定 kind + 泛化 message。
 * kind 用于日志分类（不记录 key/ciphertext），message 不含任何敏感细节。
 * 刻意不挂 cause——pi 会把 cause 拼进 ModelsError 的 message，导致 crypto 细节泄露。
 */
export class ProviderCredentialCryptoError extends Error {
  constructor(
    public readonly kind: "unknown_key_id" | "invalid_envelope" | "decrypt_failed",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialCryptoError";
  }
}

/**
 * AAD 的稳定编码。必须与解密侧逐字节一致——所以用确定的分隔符，不依赖 JSON.stringify
 * （键顺序/转义在不同引擎下可能不同）。固定结构：
 * `petrel-provider-credential\x00<formatVersion>\x00<userId>\x00<providerId>\x00<keyId>`
 *
 * 不放 revision / hint / 时间戳：它们会变，且 revision 没有外部单调锚不能真正防重放，
 * 放进 AAD 只会增加更新耦合（每次 revision 变都要重加密）。
 */
function aadBytes(parts: {
  formatVersion: number;
  userId: string;
  providerId: string;
  keyId: string;
}): Buffer {
  const { formatVersion, userId, providerId, keyId } = parts;
  return Buffer.from(
    `petrel-provider-credential\x00${formatVersion}\x00${userId}\x00${providerId}\x00${keyId}`,
    "utf8",
  );
}

/**
 * 构造一个 cipher。masterKey 来自 config（已校验为 32 字节）。
 * 复制一份字节，防止调用方修改原 Uint8Array 影响后续加解密。
 */
export function createProviderCredentialCipher(masterKey: Uint8Array): ProviderCredentialCipher {
  if (masterKey.length !== 32) {
    // config 已校验，这里再防御一次：万一被绕过传错长度，绝不静默用错 key
    throw new ProviderCredentialCryptoError("invalid_envelope", "加密密钥长度不合法");
  }
  // 复制一份，隔离外部修改
  const keyBytes = new Uint8Array(masterKey);
  // keyId = base64url(SHA-256(masterKey) 前 16 字节) → 22 字符
  const keyId = toBase64Url(createHash("sha256").update(keyBytes).digest().subarray(0, 16));

  return {
    activeKeyId: keyId,
    encrypt({ userId, providerId, apiKey }) {
      // 每次随机 nonce（GCM nonce 重用 = 安全性失效，必须每次新）
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
      const aad = aadBytes({ formatVersion: ENVELOPE_FORMAT_VERSION, userId, providerId, keyId });
      cipher.setAAD(aad);
      const plaintext = Buffer.from(apiKey, "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return {
        formatVersion: ENVELOPE_FORMAT_VERSION,
        keyId,
        nonce: toBase64Url(nonce),
        ciphertext: toBase64Url(ciphertext),
        authTag: toBase64Url(authTag),
      };
    },
    decrypt({ userId, providerId, envelope }) {
      // keyId 必须是当前 active key（当前单 key；将来多 key 时这里查 keyring）
      if (envelope.keyId !== keyId) {
        throw new ProviderCredentialCryptoError("unknown_key_id", "凭据加密密钥不匹配");
      }
      if (envelope.formatVersion !== ENVELOPE_FORMAT_VERSION) {
        throw new ProviderCredentialCryptoError(
          "invalid_envelope",
          `不支持的 envelope 格式版本：${envelope.formatVersion}`,
        );
      }
      let nonce: Uint8Array;
      let ciphertext: Uint8Array;
      let authTag: Uint8Array;
      try {
        nonce = fromBase64Url(envelope.nonce, "nonce");
        ciphertext = fromBase64Url(envelope.ciphertext, "ciphertext");
        authTag = fromBase64Url(envelope.authTag, "authTag");
      } catch (err) {
        // fromBase64Url 已抛安全 error；这里兜底其他异常
        if (err instanceof ProviderCredentialCryptoError) throw err;
        throw new ProviderCredentialCryptoError("invalid_envelope", "envelope 字段解码失败");
      }
      // aes-256-gcm 的 nonce 必须 12 字节、auth tag 16 字节
      if (nonce.length !== 12 || authTag.length !== 16) {
        throw new ProviderCredentialCryptoError("invalid_envelope", "envelope 字段长度不合法");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
        decipher.setAAD(aadBytes({ formatVersion: envelope.formatVersion, userId, providerId, keyId }));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        // 解密失败（AAD 不匹配/密文篡改/key 错）一律泛化，不暴露 crypto 原因
        throw new ProviderCredentialCryptoError("decrypt_failed", "凭据解密或完整性校验失败");
      }
    },
  };
}

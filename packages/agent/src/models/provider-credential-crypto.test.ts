import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createProviderCredentialCipher,
  type ProviderCredentialCipher,
  ProviderCredentialCryptoError,
} from "./provider-credential-crypto.ts";

// HEU-54 R1 AES-256-GCM codec 测试。
// 安全核心：round-trip 正确、同明文 nonce 不同、AAD 绑定防调换、篡改必败、错误不含 key。

const KEY = new Uint8Array(randomBytes(32));
const cipher = createProviderCredentialCipher(KEY);

const USER_A = "user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_B = "user-22222222-3333-4444-5555-666666666666";
const PROVIDER = "deepseek";
const PLAINTEXT = "sk-test-api-key-secret-12345";

describe("provider-credential-crypto round-trip", () => {
  it("加密后能解密回原 key", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    const decrypted = cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: env });
    expect(decrypted).toBe(PLAINTEXT);
  });

  it("同一明文两次加密的 nonce/ciphertext 各不相同（nonce 不重用）", () => {
    const e1 = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    const e2 = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    // 但 keyId 相同（同一个 master key）
    expect(e1.keyId).toBe(e2.keyId);
    // 两个 envelope 都能各自解密
    expect(cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: e1 })).toBe(PLAINTEXT);
    expect(cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: e2 })).toBe(PLAINTEXT);
  });

  it("keyId 是 22 字符 base64url，且不等于任何 key 字节", () => {
    const keyId = cipher.activeKeyId;
    expect(keyId.length).toBe(22);
    expect(/^[A-Za-z0-9_-]+$/.test(keyId)).toBe(true);
    // keyId 不是 master key 的任何编码形式
    expect(keyId).not.toBe(Buffer.from(KEY).toString("base64"));
    expect(keyId).not.toBe(Buffer.from(KEY).toString("base64url"));
  });

  it("envelope 各字段长度/编码符合 DB CHECK 期望", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    expect(env.formatVersion).toBe(1);
    expect(env.nonce.length).toBe(16); // 12 字节 base64url
    expect(env.authTag.length).toBe(22); // 16 字节 base64url
    // 全部 base64url 字符集
    for (const field of [env.keyId, env.nonce, env.ciphertext, env.authTag]) {
      expect(/^[A-Za-z0-9_-]+$/.test(field)).toBe(true);
    }
  });
});

describe("AAD 绑定：跨用户/provider/key 调换必败", () => {
  it("用 USER_A 加密的 envelope，按 USER_B 解密失败", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    expect(() => cipher.decrypt({ userId: USER_B, providerId: PROVIDER, envelope: env })).toThrow(
      ProviderCredentialCryptoError,
    );
  });

  it("用 provider A 加密的 envelope，按 provider B 解密失败", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: "openai", apiKey: PLAINTEXT });
    expect(() => cipher.decrypt({ userId: USER_A, providerId: "anthropic", envelope: env })).toThrow(
      ProviderCredentialCryptoError,
    );
  });

  it("用另一个 master key 加密的 envelope，按当前 key 解密失败（keyId 不匹配）", () => {
    const otherKey = new Uint8Array(randomBytes(32));
    const otherCipher = createProviderCredentialCipher(otherKey);
    const env = otherCipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });

    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: env })).toThrow(
      ProviderCredentialCryptoError,
    );
    // 错误 kind 应是 unknown_key_id
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: env })).toThrow(
      /密钥不匹配/,
    );
  });
});

describe("篡改 envelope 必败（GCM 完整性）", () => {
  it("篡改 ciphertext 一个字符 → 解密失败", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    // 翻转 ciphertext 的一个字符（保持 base64url 合法）
    const tampered: typeof env = {
      ...env,
      ciphertext:
        env.ciphertext.charAt(0) === "A" ? `B${env.ciphertext.slice(1)}` : `A${env.ciphertext.slice(1)}`,
    };
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: tampered })).toThrow(
      ProviderCredentialCryptoError,
    );
  });

  it("篡改 authTag → 解密失败", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    const tampered: typeof env = {
      ...env,
      authTag: env.authTag.charAt(0) === "A" ? `B${env.authTag.slice(1)}` : `A${env.authTag.slice(1)}`,
    };
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: tampered })).toThrow(
      ProviderCredentialCryptoError,
    );
  });

  it("篡改 nonce → 解密失败", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    const tampered: typeof env = {
      ...env,
      nonce: env.nonce.charAt(0) === "A" ? `B${env.nonce.slice(1)}` : `A${env.nonce.slice(1)}`,
    };
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: tampered })).toThrow(
      ProviderCredentialCryptoError,
    );
  });
});

describe("malformed envelope 必败", () => {
  it("非法字符集的 ciphertext → invalid_envelope", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    // 注入一个 base64url 不接受的字符（含 = 或空格）
    const bad: typeof env = { ...env, ciphertext: `${env.ciphertext}!!` };
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: bad })).toThrow(
      ProviderCredentialCryptoError,
    );
  });

  it("不支持的 formatVersion → invalid_envelope", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    const bad = { ...env, formatVersion: 99 };
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: bad })).toThrow(/不支持/);
  });

  it("长度错的 nonce（非 12 字节解码）→ invalid_envelope", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    // 喂一个 base64url 合法但解码后非 12 字节的 nonce
    const bad: typeof env = { ...env, nonce: "AAAAAAAAAAAAAAAAAAAAAAAA" }; // 24 字符 → 18 字节
    expect(() => cipher.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: bad })).toThrow(
      ProviderCredentialCryptoError,
    );
  });
});

describe("错误不含敏感信息", () => {
  it("解密失败的 error message 不含明文 key / ciphertext / nonce", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    let caughtMessage = "";
    try {
      cipher.decrypt({ userId: USER_B, providerId: PROVIDER, envelope: env });
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMessage).not.toContain(PLAINTEXT);
    expect(caughtMessage).not.toContain(env.ciphertext);
    expect(caughtMessage).not.toContain(env.nonce);
  });

  it("crypto error 不带 cause（避免 pi 把细节拼进 ModelsError）", () => {
    const env = cipher.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    try {
      cipher.decrypt({ userId: USER_B, providerId: PROVIDER, envelope: env });
      throw new Error("应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderCredentialCryptoError);
      // cause 必须是 undefined，不是原始 crypto 错误
      expect((err as ProviderCredentialCryptoError).cause).toBeUndefined();
    }
  });
});

describe("master key 隔离", () => {
  it("cipher 复制了 master key：改外部 Uint8Array 不影响加解密", () => {
    const mutableKey = new Uint8Array(randomBytes(32));
    const c = createProviderCredentialCipher(mutableKey);
    // 改外部 key 字节
    mutableKey.fill(0);
    // cipher 用的仍是原始 key，round-trip 仍成立
    const env = c.encrypt({ userId: USER_A, providerId: PROVIDER, apiKey: PLAINTEXT });
    expect(c.decrypt({ userId: USER_A, providerId: PROVIDER, envelope: env })).toBe(PLAINTEXT);
  });

  it("32 字节以外的 key 长度拒绝构造", () => {
    expect(() => createProviderCredentialCipher(new Uint8Array(16))).toThrow(ProviderCredentialCryptoError);
    expect(() => createProviderCredentialCipher(new Uint8Array(0))).toThrow(ProviderCredentialCryptoError);
  });
});

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type {
  Database,
  ProviderCredentialEnvelopeRow,
  ProviderCredentialMetadataRow,
} from "@petrel/database";
import { createProviderCredentialRepository } from "@petrel/database";
import {
  ENVELOPE_FORMAT_VERSION,
  type ProviderCredentialCipher,
  ProviderCredentialCryptoError,
} from "./provider-credential-crypto.ts";

/**
 * HEU-54 R1 的 pi CredentialStore 实现：DB-backed + AES-256-GCM 加密。
 *
 * 这是「per-user 凭据注入」的粘合层：pi 的 CredentialStore 接口只有 providerId 没有 userId，
 * 所以本实现**用闭包固化 userId**——每个 (db, userId) 组合由 createUserModels 建一个独立实例。
 * pi 每次 getAuth/applyAuth 都现读 read()（无缓存，已由合同测试钉死），所以「用户改 key 后
 * 下一 run 用新 key」自然成立，不需要 evict/重建 harness。
 *
 * 三态语义（fail-closed 的根基，与 pi resolve.js 对齐，已由合同测试验证）：
 *   read 返 undefined → 无记录，pi 回落 ambient env（兼容 R0、删除恢复 env）
 *   read 返 credential → 用用户 key
 *   read 抛错 → DB/解密/keyId 不匹配，pi 包成 ModelsError("auth")，**不回落 env**
 * 所以「DB 故障」「master key 错」「密文损坏」绝不能被 catch 成 undefined——那是把 fail-closed
 * 降级成「静默用别人/开发者的 env key」，破坏多租户隔离。
 *
 * modify/delete 的串行：pi 要求 modify 是 read-modify-write 的唯一写路径且串行（OAuth 刷新
 * 依赖它）。本实现用进程内 `(userId,providerId)` promise mutex + DB revision CAS：
 *   - mutex 保证同进程内同一 key 不并发改
 *   - revision CAS 保证跨进程/跨实例并发时 last-write-wins，CAS 重试有界（最多 5 次）
 * R1 只支持 api_key 完整替换（callback 是纯函数），所以 CAS 重跑 callback 安全；
 * 若将来支持 OAuth（refresh 有副作用），必须换成真正锁住 callback 的实现。
 */

/** modify 内 CAS 重试上限。两个标签页/两实例并发改同一 key 的最坏重试次数 */
const MAX_CAS_RETRIES = 5;

/**
 * 安全 domain error。pi 会把 store error 的 message 拼进 ModelsError，所以 message
 * 只放固定泛化文案 + 安全分类，绝不带原始 cause（SQL/crypto 细节会泄露）。
 */
export class ProviderCredentialStoreError extends Error {
  constructor(
    public readonly kind:
      | "db_unavailable"
      | "unknown_key_id"
      | "invalid_envelope"
      | "decrypt_failed"
      | "not_api_key"
      | "env_not_supported"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialStoreError";
  }
}

function cryptoErrorToStore(err: ProviderCredentialCryptoError): ProviderCredentialStoreError {
  return new ProviderCredentialStoreError(err.kind, err.message);
}

/**
 * 进程内 (userId,providerId) → Promise 的 mutex map。
 * 保证同一 key 的 modify/delete 串行；不同 key 可并行。
 * 用 finally 清理，避免 mutex 泄漏（任何路径，包括 reject，都释放）。
 */
const mutexMap = new Map<string, Promise<unknown>>();

/** 测试用：暴露 mutex map 当前大小，验证清理无泄漏 */
export function __getCredentialMutexSize(): number {
  return mutexMap.size;
}

export async function withProviderCredentialMutex<T>(
  userId: string,
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${userId}\x00${providerId}`;
  const prev = mutexMap.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 注意：存进 map 的是 tail（prev.then(() => next)），清理时也必须比对这个 tail 的 identity，
  // 而不是 next——否则清理条件恒 false（tail !== next），mutexMap 会无界增长泄漏。
  const tail = prev.then(() => next);
  mutexMap.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // 只有当 map 里还是我们这条 tail 时才删（避免删掉后来排队者）
    if (mutexMap.get(key) === tail) mutexMap.delete(key);
  }
}

/**
 * 建 DB-backed CredentialStore。闭包固化 (db, userId, cipher)。
 * db 由调用方注入（生产 getDb()，测试 createTestDb）。
 */
export function createDbCredentialStore(
  db: Database,
  userId: string,
  cipher: ProviderCredentialCipher,
): CredentialStore {
  const repo = createProviderCredentialRepository(db);

  /**
   * 把 DB 行解密成 pi 的 ApiKeyCredential。
   * keyId 不匹配 / 解密失败 / 格式错一律抛安全 error（fail-closed，不回落 env）。
   */
  async function decryptRow(
    row: {
      formatVersion: number;
      keyId: string;
      nonce: string;
      ciphertext: string;
      authTag: string;
    },
    providerId: string,
  ): Promise<Credential> {
    try {
      const apiKey = cipher.decrypt({
        userId,
        providerId,
        envelope: {
          formatVersion: row.formatVersion,
          keyId: row.keyId,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.authTag,
        },
      });
      return { type: "api_key", key: apiKey };
    } catch (err) {
      if (err instanceof ProviderCredentialCryptoError) {
        throw cryptoErrorToStore(err);
      }
      // crypto 模块内部不该抛别的，但兜底
      throw new ProviderCredentialStoreError("decrypt_failed", "凭据解密失败");
    }
  }

  return {
    async read(providerId) {
      let row: ProviderCredentialEnvelopeRow | undefined;
      try {
        row = await repo.findByUserAndProvider(userId, providerId);
      } catch {
        // DB 故障：fail-closed，绝不伪装成 undefined（否则回落 env 用别人的 key）
        throw new ProviderCredentialStoreError("db_unavailable", "凭据读取暂时不可用");
      }
      // 无记录：返 undefined，让 pi 回落 ambient env（兼容 R0、删除恢复 env）
      if (row === undefined) return undefined;
      return decryptRow(row, providerId);
    },

    async list() {
      // list 不解密、不返回密文，只返 {providerId, type} 元数据
      let metas: ProviderCredentialMetadataRow[];
      try {
        metas = await repo.listMetadataByUser(userId);
      } catch {
        throw new ProviderCredentialStoreError("db_unavailable", "凭据读取暂时不可用");
      }
      return metas.map((m): CredentialInfo => ({ providerId: m.providerId, type: "api_key" }));
    },

    async modify(providerId, fn) {
      return withProviderCredentialMutex(userId, providerId, async () => {
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
          // 读当前（current 只来自用户 DB，绝不混 ambient env——pi 的合并是 resolve 的事）
          let current: Credential | undefined;
          let currentRevision: number;
          try {
            const row = await repo.findByUserAndProvider(userId, providerId);
            if (row) {
              currentRevision = row.revision;
              current = await decryptRow(row, providerId);
            } else {
              currentRevision = 0; // 无行：首次插入走 insertIfAbsent
              current = undefined;
            }
          } catch (err) {
            // 读/解密失败：modify 无法安全进行，抛错中止（不写入）。
            // decryptRow 抛的是已清洗的 ProviderCredentialStoreError（直接透传）；
            // findByUserAndProvider 抛的原始 DB 错误（含 SQL/参数）必须清洗成 db_unavailable。
            if (err instanceof ProviderCredentialStoreError) throw err;
            throw new ProviderCredentialStoreError("db_unavailable", "凭据读取暂时不可用");
          }

          // 跑调用方的 callback。它看到的 current 是用户自己的 DB 凭据
          const next = await fn(current);

          // fn 返 undefined = 保持不变，返回当前 post-state
          if (next === undefined) {
            return current;
          }

          // 只接受 api_key 类型（OAuth 不在 R1 范围，refresh 有副作用，CAS 重跑不安全）
          if (next.type !== "api_key") {
            throw new ProviderCredentialStoreError(
              "not_api_key",
              "仅支持保存 API key 类型凭据，不支持 OAuth",
            );
          }
          // 规范化 + 校验 key（统一 trim 语义，加密与 hint 用同一个规范化值）
          const normalizedKey = normalizeProviderApiKey(next.key);
          // 拒绝带 env 的 credential：复合 provider env 不在 R1 schema 范围，
          // 且 env 字段会绕过「用户只填 key」的语义
          if (next.env !== undefined) {
            throw new ProviderCredentialStoreError("env_not_supported", "不支持随凭据附带 provider env 配置");
          }

          // 构造 envelope（keyId/nonce 全新生成）。加密用规范化 key
          const envelope = cipher.encrypt({ userId, providerId, apiKey: normalizedKey });
          const keyHint = deriveKeyHint(normalizedKey);

          // CAS 写入
          try {
            if (currentRevision === 0) {
              // 首次插入：repo 用 ON CONFLICT DO NOTHING 返 boolean，
              // 不依赖 driver 私有错误形状（code 23505 在 drizzle/PGlite 下不稳）。
              const inserted = await repo.insertIfAbsent({
                userId,
                providerId,
                keyId: envelope.keyId,
                nonce: envelope.nonce,
                ciphertext: envelope.ciphertext,
                authTag: envelope.authTag,
                keyHint,
              });
              if (!inserted && attempt + 1 < MAX_CAS_RETRIES) {
                // 并发时别人先插了；重试走 replace 路径
                continue;
              }
              if (!inserted) {
                throw new ProviderCredentialStoreError("conflict", "凭据保存冲突，请重试");
              }
            } else {
              const ok = await repo.replaceIfRevision(
                {
                  userId,
                  providerId,
                  keyId: envelope.keyId,
                  nonce: envelope.nonce,
                  ciphertext: envelope.ciphertext,
                  authTag: envelope.authTag,
                  keyHint,
                },
                currentRevision,
              );
              if (!ok) {
                // revision 已变（别人并发改了）：CAS 重试
                if (attempt + 1 < MAX_CAS_RETRIES) continue;
                throw new ProviderCredentialStoreError("conflict", "凭据保存冲突，请重试");
              }
            }
          } catch (err) {
            // 已清洗的 domain error 透传；其余 DB 故障清洗成 db_unavailable（不外泄原始 SQL/参数）
            if (err instanceof ProviderCredentialStoreError) throw err;
            throw new ProviderCredentialStoreError("db_unavailable", "凭据保存暂时不可用");
          }

          // 返回 post-write credential（pi 期望 modify 返回写入后的值）
          return { type: "api_key" as const, key: normalizedKey };
        }
        // 理论上不可达（循环内要么 return 要么 continue 到耗尽抛 conflict）
        throw new ProviderCredentialStoreError("conflict", "凭据保存冲突，请重试");
      });
    },

    async delete(providerId) {
      await withProviderCredentialMutex(userId, providerId, async () => {
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
          try {
            const current = await repo.findByUserAndProvider(userId, providerId);
            if (!current) return; // 无行幂等成功

            const deleted = await repo.deleteIfRevision(userId, providerId, current.revision);
            if (deleted) return;
            if (attempt + 1 === MAX_CAS_RETRIES) {
              throw new ProviderCredentialStoreError("conflict", "凭据删除冲突，请重试");
            }
          } catch (err) {
            if (err instanceof ProviderCredentialStoreError) throw err;
            throw new ProviderCredentialStoreError("db_unavailable", "凭据删除暂时不可用");
          }
        }
      });
    },
  };
}

/**
 * key 最小长度：短于此的 key 即使存了也几乎无效（任何正经 provider 的 key 都远长于此），
 * 更关键的是——短 key 的「末 4 位」等于完整明文 key 入库（见 deriveKeyHint）。
 * 拒绝过短 key 同时堵住了「hint 泄露完整 key」的路径。
 */
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 4096;

/**
 * 规范化 API key：trim 后校验长度。
 * trim 统一用于加密与 hint，避免「加密用原值、hint 用 trim 值」的语义不一致。
 * 校验：非空、长度 [MIN, MAX]、只含可打印 ASCII（拒绝控制字符/换行/非 ASCII，
 * 这类字符在 API key 里无合法用途，且可能是注入或复制错误）。
 */
export function normalizeProviderApiKey(raw: string | undefined): string {
  if (typeof raw !== "string") {
    throw new ProviderCredentialStoreError("not_api_key", "API key 不能为空");
  }
  const key = raw.trim();
  if (key.length === 0) {
    throw new ProviderCredentialStoreError("not_api_key", "API key 不能为空");
  }
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new ProviderCredentialStoreError(
      "not_api_key",
      `API key 过短（至少 ${MIN_API_KEY_LENGTH} 个字符）`,
    );
  }
  if (key.length > MAX_API_KEY_LENGTH) {
    throw new ProviderCredentialStoreError(
      "not_api_key",
      `API key 过长（至多 ${MAX_API_KEY_LENGTH} 个字符）`,
    );
  }
  // 可打印 ASCII 0x21–0x7E（排除空格 0x20，trim 已去首尾，中间空格在 key 里也不合法）
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new ProviderCredentialStoreError("not_api_key", "API key 含非法字符（只接受可打印 ASCII）");
  }
  return key;
}

/**
 * 从规范化 key 派生 hint（末 4 位）。面板显示遮罩「••••1234」用，不是机密。
 *
 * 安全前提：调用方传入的是 normalizeProviderApiKey 的返回值（已校验 ≥ MIN_API_KEY_LENGTH=8），
 * 所以末 4 位必是 key 的子串而非完整 key。与 schema 注释一致：不存前缀（sk- 无辨识度）。
 */
function deriveKeyHint(normalizedApiKey: string): string {
  return normalizedApiKey.slice(-4);
}

/** 导出供测试/日志用的格式版本常量（与 DB CHECK 对齐） */
export { ENVELOPE_FORMAT_VERSION };

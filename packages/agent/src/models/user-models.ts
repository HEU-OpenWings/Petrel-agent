import { type AuthContext, type CredentialStore, createModels, type Models } from "@earendil-works/pi-ai";
import { env } from "@petrel/config";
import type { Database } from "@petrel/database";
import { createDbCredentialStore } from "./db-credential-store.ts";
import {
  createProviderCredentialCipher,
  type ProviderCredentialCipher,
} from "./provider-credential-crypto.ts";
import { PROVIDERS } from "./providers.ts";

/**
 * HEU-54 R1 per-user Models 工厂。
 *
 * pi 的 CredentialStore 接口只有 providerId 没有 userId，而 Models 单例被全部 harness 共用——
 * 要实现「按当前请求用户解析凭据」，必须给每个会话绑一个独立 Models，其 CredentialStore 用
 * 闭包固化 userId。这就是 per-session Models（等价 per-user，因为一个 session 永属一个 user，
 * upsert 已守归属校验）。
 *
 * 本工厂做的事：
 * 1. 建 DB-backed credential store（闭包固化 db/userId/cipher）；
 * 2. createModels({ credentials }) —— pi 内置 provider 的 auth 解析会优先用 stored credential
 *    且无缓存（合同测试已钉），所以用户改 key 后下一次 getAuth 立即用新值；
 * 3. 注册与 global Models 相同的 PROVIDERS（provider 对象引用共享，见下方门禁）。
 *
 * provider 对象共享：当前 11 个 provider 都是静态的（无 refreshModels/fetchModels，catalog
 * 不可变），共享引用安全且有内存收益。门禁：一旦将来加入动态 provider，测试会失败，强制
 * 改成 per-Models 的 provider factory——不能静默在用户间共享可变 catalog。
 */

/** 加密 cipher 的 lazy singleton：所有 user Models 共用同一个 cipher（同一个 master key） */
let cachedCipher: ProviderCredentialCipher | undefined;

export function getProviderCredentialCipher(): ProviderCredentialCipher {
  if (cachedCipher) return cachedCipher;
  const key = env.providerCredentials.encryptionKey;
  if (key === undefined) {
    // config 已保证：任一开关开时 key 必存在。走到这里说明调用链出错（stored off 却建了 user Models）
    throw new Error("provider 凭据功能未启用，无法构造用户 Models");
  }
  cachedCipher = createProviderCredentialCipher(key);
  return cachedCipher;
}

/** 测试用：重置 cipher 缓存（让每个测试用独立的 master key） */
export function __resetUserModelsCipherCache(): void {
  cachedCipher = undefined;
}

/**
 * 构造一个 per-user Models。
 *
 * @param db 数据库（生产 getDb()，测试 createTestDb）
 * @param userId 当前用户（闭包固化进 credential store）
 * @param options.cipher 可选注入 cipher（测试用，默认从 config 的 encryptionKey 构造）
 * @param options.authContext 可选注入 AuthContext（测试用，默认 undefined 保留 pi 的 ambient env fallback）
 */
export function createUserModels(
  db: Database,
  userId: string,
  options?: {
    cipher?: ProviderCredentialCipher;
    authContext?: AuthContext;
  },
): Models {
  const cipher = options?.cipher ?? getProviderCredentialCipher();
  const store: CredentialStore = createDbCredentialStore(db, userId, cipher);

  const models = createModels(
    options?.authContext ? { credentials: store, authContext: options.authContext } : { credentials: store },
  );
  for (const provider of PROVIDERS) {
    models.setProvider(provider);
  }
  return models;
}

/**
 * 门禁：所有共享 provider 必须是静态的（无 refreshModels）。
 * 动态 provider 的 catalog 可变，在用户间共享引用不安全。
 * 这个函数给 user-models.test.ts 断言用，也是给将来维护者的契约文档。
 */
export function assertAllProvidersStatic(): void {
  const dynamic = PROVIDERS.filter((p) => p.refreshModels !== undefined).map((p) => p.id);
  if (dynamic.length > 0) {
    throw new Error(
      `动态 provider 不能跨用户共享 catalog，请把 createUserModels 改成 per-Models provider factory：${dynamic.join(", ")}`,
    );
  }
}

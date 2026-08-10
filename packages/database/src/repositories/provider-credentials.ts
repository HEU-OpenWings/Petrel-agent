import { and, eq, sql } from "drizzle-orm";
import { userPreferences, userProviderCredentials } from "../schema.ts";
import type { Database } from "./sessions.ts";

/**
 * 用户 provider 凭据的密文存储 CRUD（HEU-54 R1）。
 *
 * **这一层只搬密文 envelope，不碰明文 key**。加解密在 packages/agent 的
 * provider-credential-crypto.ts；reason 是：明文只在「用户输入 → 加密 → 写库」与
 * 「读库 → 解密 → 喂给 pi」两个边界短暂存在，把它收敛在 agent 层能确保明文不
 * 跨包传播。repository 返回的 EnvelopeRow 带的是 nonce/ciphertext/authTag，
 * 调用方拿到后自行解密。
 *
 * revision 做乐观锁：并发改同一 (user, provider)（两个标签页）时 last-write-wins，
 * revision 递增。replaceIfRevision/deleteIfRevision 在 revision 不匹配时返回 false，
 * 让 CredentialStore 的 modify 走 CAS 重试。
 *
 * 与 schema.ts 注释一致：provider_id 不做外键（catalog 是运行时内存注册表），
 * 只有 user_id 级联（删用户清空其凭据）。
 */

/** 加密 envelope 的一行（含密文），供 CredentialStore 解密。 */
export interface ProviderCredentialEnvelopeRow {
  userId: string;
  providerId: string;
  formatVersion: number;
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  keyHint: string;
  revision: number;
  updatedAt: Date;
}

/** 面板/状态展示用的非敏感元数据（不含密文）。listMetadataByUser 返回它。 */
export interface ProviderCredentialMetadataRow {
  providerId: string;
  keyHint: string;
  revision: number;
  updatedAt: Date;
}

/** 写入一份凭据所需的密文 envelope（由 crypto 模块构造）。 */
export interface ProviderCredentialEnvelopeInput {
  userId: string;
  providerId: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  keyHint: string;
}

const envelopeColumns = {
  userId: userProviderCredentials.userId,
  providerId: userProviderCredentials.providerId,
  formatVersion: userProviderCredentials.formatVersion,
  keyId: userProviderCredentials.keyId,
  nonce: userProviderCredentials.nonce,
  ciphertext: userProviderCredentials.ciphertext,
  authTag: userProviderCredentials.authTag,
  keyHint: userProviderCredentials.keyHint,
  revision: userProviderCredentials.revision,
  updatedAt: userProviderCredentials.updatedAt,
} as const;

export function createProviderCredentialRepository(db: Database) {
  return {
    /**
     * 读一份凭据的完整 envelope（含密文）。无行返回 undefined。
     * CredentialStore.read 用它：undefined → pi 回落 env；解密失败 → 抛错（fail-closed）。
     */
    async findByUserAndProvider(
      userId: string,
      providerId: string,
    ): Promise<ProviderCredentialEnvelopeRow | undefined> {
      const rows = await db
        .select(envelopeColumns)
        .from(userProviderCredentials)
        .where(
          and(eq(userProviderCredentials.userId, userId), eq(userProviderCredentials.providerId, providerId)),
        )
        .limit(1);
      return rows[0];
    },

    /**
     * 列某用户的全部凭据元数据。**不查 ciphertext/nonce/authTag**——面板与状态展示
     * 只需要 providerId + keyHint（显示遮罩），密文带出来既无必要又增加泄露面。
     */
    async listMetadataByUser(userId: string): Promise<ProviderCredentialMetadataRow[]> {
      const rows = await db
        .select({
          providerId: userProviderCredentials.providerId,
          keyHint: userProviderCredentials.keyHint,
          revision: userProviderCredentials.revision,
          updatedAt: userProviderCredentials.updatedAt,
        })
        .from(userProviderCredentials)
        .where(eq(userProviderCredentials.userId, userId));
      return rows;
    },

    /** 查询单个 provider 的展示元数据，不把密文 envelope 带过 agent/service 边界。 */
    async findMetadataByUserAndProvider(
      userId: string,
      providerId: string,
    ): Promise<ProviderCredentialMetadataRow | undefined> {
      const rows = await db
        .select({
          providerId: userProviderCredentials.providerId,
          keyHint: userProviderCredentials.keyHint,
          revision: userProviderCredentials.revision,
          updatedAt: userProviderCredentials.updatedAt,
        })
        .from(userProviderCredentials)
        .where(
          and(eq(userProviderCredentials.userId, userId), eq(userProviderCredentials.providerId, providerId)),
        )
        .limit(1);
      return rows[0];
    },

    /**
     * 首次插入一份凭据（revision=1）。已存在 (user, provider) 时**不抛错**，
     * 用 ON CONFLICT DO NOTHING 静默跳过并返回 false——这样调用方的 CAS 重试不依赖
     * driver 私有错误形状（node-postgres 的 code 23505 在 drizzle/PGlite 下的位置不稳）。
     * 返回 true=本次真的插入；false=已存在，调用方应改走 replaceIfRevision 覆盖。
     */
    async insertIfAbsent(input: ProviderCredentialEnvelopeInput): Promise<boolean> {
      const inserted = await db
        .insert(userProviderCredentials)
        .values({
          userId: input.userId,
          providerId: input.providerId,
          keyId: input.keyId,
          nonce: input.nonce,
          ciphertext: input.ciphertext,
          authTag: input.authTag,
          keyHint: input.keyHint,
          // formatVersion / revision 走 schema 默认（1）
        })
        .onConflictDoNothing({
          target: [userProviderCredentials.userId, userProviderCredentials.providerId],
        })
        .returning();
      return inserted.length > 0;
    },

    /**
     * 乐观锁覆盖更新：仅当当前 revision === expectedRevision 时写入新 envelope 并 revision+1。
     * 返回是否真的更新了一行；false 表示并发改写（revision 已变），调用方按 CAS 重试。
     */
    async replaceIfRevision(
      input: ProviderCredentialEnvelopeInput,
      expectedRevision: number,
    ): Promise<boolean> {
      const result = await db
        .update(userProviderCredentials)
        .set({
          keyId: input.keyId,
          nonce: input.nonce,
          ciphertext: input.ciphertext,
          authTag: input.authTag,
          keyHint: input.keyHint,
          revision: sql`${userProviderCredentials.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(userProviderCredentials.userId, input.userId),
            eq(userProviderCredentials.providerId, input.providerId),
            eq(userProviderCredentials.revision, expectedRevision),
          ),
        )
        .returning();
      return result.length > 0;
    },

    /**
     * 乐观锁删除：仅当 revision 匹配时删。返回是否真删了一行。
     * 给 CredentialStore.modify/delete 的 CAS 用——避免基于过期 current 做的删除覆盖
     * 了别人更新的新值。
     */
    async deleteIfRevision(userId: string, providerId: string, expectedRevision: number): Promise<boolean> {
      const result = await db
        .delete(userProviderCredentials)
        .where(
          and(
            eq(userProviderCredentials.userId, userId),
            eq(userProviderCredentials.providerId, providerId),
            eq(userProviderCredentials.revision, expectedRevision),
          ),
        )
        .returning();
      return result.length > 0;
    },
  };
}

/** 跨实例 CAS 多次冲突；message 固定，不携带 SQL 或行内容。 */
export class ProviderCredentialRevisionConflictError extends Error {
  constructor() {
    super("provider 凭据并发更新冲突");
    this.name = "ProviderCredentialRevisionConflictError";
  }
}

export interface DeleteProviderCredentialAndNormalizeInput {
  userId: string;
  providerId: string;
  /** 仅当当前 default_model 仍等于该值时清为 null；undefined 表示无需清理。 */
  expectedDefaultModel?: string;
}

export interface DeleteProviderCredentialAndNormalizeResult {
  deleted: boolean;
  defaultModelReset: boolean;
}

const DELETE_CAS_RETRIES = 5;

type TransactionRunner = {
  transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
};

/**
 * 在同一事务里删除个人凭据并条件归一默认模型。
 *
 * `Database` 是 node-postgres / PGlite 的联合类型，两种实现的 transaction callback
 * 参数名义类型不同，但都提供同一套 Drizzle 查询构造 API。这里把这一个已知差异收敛在
 * 边界断言里，事务内部继续复用正常 repository，不把 driver 类型泄漏到上层。
 */
export async function deleteProviderCredentialAndNormalizeDefaultModel(
  db: Database,
  input: DeleteProviderCredentialAndNormalizeInput,
): Promise<DeleteProviderCredentialAndNormalizeResult> {
  const runner = db as unknown as TransactionRunner;
  return runner.transaction(async (rawTx) => {
    const tx = rawTx as Database;
    const credentials = createProviderCredentialRepository(tx);

    let deleted = false;
    for (let attempt = 0; attempt < DELETE_CAS_RETRIES; attempt++) {
      const current = await credentials.findByUserAndProvider(input.userId, input.providerId);
      if (!current) break;

      if (await credentials.deleteIfRevision(input.userId, input.providerId, current.revision)) {
        deleted = true;
        break;
      }
      if (attempt + 1 === DELETE_CAS_RETRIES) {
        throw new ProviderCredentialRevisionConflictError();
      }
    }

    let defaultModelReset = false;
    if (input.expectedDefaultModel !== undefined) {
      const updated = await tx
        .update(userPreferences)
        .set({ defaultModel: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(userPreferences.userId, input.userId),
            eq(userPreferences.defaultModel, input.expectedDefaultModel),
          ),
        )
        .returning();
      defaultModelReset = updated.length > 0;
    }

    return { deleted, defaultModelReset };
  });
}

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userProviderCredentials, users } from "../schema.ts";
import { createTestDb, TEST_USER_ID, type TestDb } from "../testing.ts";
import { createProviderCredentialRepository } from "./provider-credentials.ts";

// HEU-54 R1 凭据 repository 测试。关键不变式：
// 1. 复合主键 (user, provider) 唯一——同用户同 provider 插两次撞主键
// 2. revision 乐观锁——CAS 更新/删除
// 3. 用户隔离——A 的凭据 B 查不到
// 4. 级联删除——删用户清空凭据
// 5. listMetadataByUser 不返回密文
// 6. raw row 不含明文 key（DB 层只存密文）

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const PROVIDER_A = "deepseek";
const PROVIDER_B = "openai";

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});

beforeEach(async () => {
  await reset();
  // reset 只 seed TEST_USER_ID；用到第二个用户的用例需要显式建它
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, email: "other@example.com", passwordHash: "!" })
    .onConflictDoNothing();
});

afterAll(() => close?.());

/** 造一份最小 envelope 输入（密文内容任意，repository 不解密，只搬数据） */
function envelope(
  userId: string,
  providerId: string,
  suffix: string,
  keyHint = "1234",
): {
  userId: string;
  providerId: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  keyHint: string;
} {
  return {
    userId,
    providerId,
    keyId: `keyid_${suffix}`,
    nonce: `nonce_${suffix}`,
    ciphertext: `cipher_${suffix}`,
    authTag: `tag_${suffix}`,
    keyHint,
  };
}

describe("provider-credentials repository", () => {
  it("insertIfAbsent 后 findByUserAndProvider 能读回完整 envelope", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    const row = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(row).toBeDefined();
    expect(row?.revision).toBe(1);
    expect(row?.formatVersion).toBe(1);
    expect(row?.keyId).toBe("keyid_v1");
    expect(row?.ciphertext).toBe("cipher_v1");
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it("复合主键：同用户同 provider 再插返 false（ON CONFLICT DO NOTHING，不抛错）", async () => {
    // CAS 重试依赖返回值而非 driver 私有错误形状（code 23505 在 drizzle/PGlite 下位置不稳）
    const repo = createProviderCredentialRepository(db);
    const first = await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));
    expect(first).toBe(true);

    const second = await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v2"));
    expect(second).toBe(false); // 已存在，静默跳过

    // 且 DB 里仍是第一次的值（没被覆盖）
    const row = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(row?.ciphertext).toBe("cipher_v1");
  });

  it("无行时 findByUserAndProvider 返回 undefined（让 pi 回落 env）", async () => {
    const repo = createProviderCredentialRepository(db);
    const row = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(row).toBeUndefined();
  });

  it("用户隔离：A 的凭据 B 查不到", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "a"));
    await repo.insertIfAbsent(envelope(OTHER_USER_ID, PROVIDER_A, "b"));

    // 同一 provider，两个用户各一份，互不串
    const aRow = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    const bRow = await repo.findByUserAndProvider(OTHER_USER_ID, PROVIDER_A);
    expect(aRow?.keyId).toBe("keyid_a");
    expect(bRow?.keyId).toBe("keyid_b");
  });

  it("同用户不同 provider 各一份（复合主键允许）", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "a"));
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_B, "b"));

    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A)).toBeDefined();
    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_B)).toBeDefined();
  });
});

describe("listMetadataByUser", () => {
  it("返回 providerId/keyHint/revision，不含 ciphertext/nonce/authTag/keyId", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "a", "abcd"));
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_B, "b", "wxyz"));

    const metas = await repo.listMetadataByUser(TEST_USER_ID);
    expect(metas).toHaveLength(2);
    const json = JSON.stringify(metas);
    // 不含任何密文字段
    expect(json).not.toContain("cipher_");
    expect(json).not.toContain("nonce_");
    expect(json).not.toContain("tag_");
    expect(json).not.toContain("keyid_");
    // 含 providerId 与 keyHint
    const providers = metas.map((m) => m.providerId).sort();
    expect(providers).toEqual([PROVIDER_A, PROVIDER_B]);
    expect(metas.every((m) => typeof m.keyHint === "string")).toBe(true);
  });

  it("只列指定用户的，不串用户", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "a"));
    await repo.insertIfAbsent(envelope(OTHER_USER_ID, PROVIDER_B, "b"));

    expect((await repo.listMetadataByUser(TEST_USER_ID)).map((m) => m.providerId)).toEqual([PROVIDER_A]);
    expect((await repo.listMetadataByUser(OTHER_USER_ID)).map((m) => m.providerId)).toEqual([PROVIDER_B]);
  });
});

describe("replaceIfRevision（乐观锁更新）", () => {
  it("revision 匹配时更新成功并 revision+1", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    const ok = await repo.replaceIfRevision(envelope(TEST_USER_ID, PROVIDER_A, "v2"), 1);
    expect(ok).toBe(true);

    const row = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(row?.revision).toBe(2);
    expect(row?.ciphertext).toBe("cipher_v2");
  });

  it("revision 不匹配（并发改写）时返回 false，不更新", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    // 传一个过期的 expectedRevision
    const ok = await repo.replaceIfRevision(envelope(TEST_USER_ID, PROVIDER_A, "stale"), 999);
    expect(ok).toBe(false);

    const row = await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(row?.revision).toBe(1);
    expect(row?.ciphertext).toBe("cipher_v1"); // 未被改动
  });
});

describe("deleteIfRevision（乐观锁删除）", () => {
  it("revision 匹配时删除成功", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    const ok = await repo.deleteIfRevision(TEST_USER_ID, PROVIDER_A, 1);
    expect(ok).toBe(true);
    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A)).toBeUndefined();
  });

  it("revision 不匹配时返回 false，不删", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    const ok = await repo.deleteIfRevision(TEST_USER_ID, PROVIDER_A, 999);
    expect(ok).toBe(false);
    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A)).toBeDefined();
  });
});

describe("deleteByUserAndProvider（用户显式删除）", () => {
  it("无行时幂等成功（不抛错）", async () => {
    const repo = createProviderCredentialRepository(db);
    await expect(repo.deleteByUserAndProvider(TEST_USER_ID, PROVIDER_A)).resolves.toBeUndefined();
  });

  it("有行时删除", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    await repo.deleteByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A)).toBeUndefined();
  });

  it("错误 master key 下仍可删除（不解密， CredentialStore 删损坏行后重存）", async () => {
    // repository 本身从不解密，所以这里只验证「有任意密文行也能直接删」
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "corrupt"));
    await repo.deleteByUserAndProvider(TEST_USER_ID, PROVIDER_A);
    expect(await repo.findByUserAndProvider(TEST_USER_ID, PROVIDER_A)).toBeUndefined();
  });
});

describe("级联删除", () => {
  it("删除用户会级联删掉它的凭据", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "a"));
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_B, "b"));

    // 删夹具用户
    await db.delete(users).where(eq(users.id, TEST_USER_ID));

    expect(await repo.listMetadataByUser(TEST_USER_ID)).toHaveLength(0);
  });
});

describe("DB 层不存明文 key", () => {
  it("raw row 不含明文 API key（只存密文 envelope）", async () => {
    const repo = createProviderCredentialRepository(db);
    await repo.insertIfAbsent(envelope(TEST_USER_ID, PROVIDER_A, "v1"));

    // 直接查整表，确认没有任何列存明文 key
    const rawRows = await db.select().from(userProviderCredentials);
    const json = JSON.stringify(rawRows);
    // repository 写入的就是密文占位，这里验证「明文 key 的典型形态」不在 row 里
    expect(json).not.toContain("sk-");
    expect(json).not.toMatch(/"key"\s*:/); // 没有 key 列
  });
});

import { randomBytes } from "node:crypto";
import { userProviderCredentials, users } from "@petrel/database";
import { createTestDb, TEST_USER_ID, type TestDb } from "@petrel/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbCredentialStore, ProviderCredentialStoreError } from "./db-credential-store.ts";
import { createProviderCredentialCipher } from "./provider-credential-crypto.ts";

// HEU-54 R1 DB-backed CredentialStore 测试。
// 关键不变式（planner Gate 5）：
// - read 无行返 undefined（让 pi 回落 env）、有行解密、DB/解密失败抛错不回落 env
// - list 不解密、只返 {providerId,type}
// - modify 只接受 api_key+key、拒绝 OAuth/env、CAS 并发
// - delete 幂等
// - A/B 用户隔离
// - raw DB row 无明文 key

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const PROVIDER = "deepseek";
const KEY_BYTES = new Uint8Array(randomBytes(32));
const cipher = createProviderCredentialCipher(KEY_BYTES);

let db: TestDb;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, reset, close } = await createTestDb());
});

beforeEach(async () => {
  await reset();
  await db
    .insert(users)
    .values({ id: OTHER_USER_ID, email: "other@example.com", passwordHash: "!" })
    .onConflictDoNothing();
});

afterAll(() => close?.());

describe("read 三态", () => {
  it("无记录返回 undefined（让 pi 回落 env）", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    expect(await store.read(PROVIDER)).toBeUndefined();
  });

  it("modify 后 read 能读回明文 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-my-secret-key" }));

    const cred = await store.read(PROVIDER);
    expect(cred?.type).toBe("api_key");
    expect((cred as { key?: string })?.key).toBe("sk-my-secret-key");
  });

  it("用错误 master key 的 store 读旧 key → 抛 decrypt_failed，不回落 undefined", async () => {
    // 先用 cipher 存一个 key
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await storeA.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-original" }));

    // 换一个不同 master key 的 store
    const wrongCipher = createProviderCredentialCipher(new Uint8Array(randomBytes(32)));
    const storeB = createDbCredentialStore(db, TEST_USER_ID, wrongCipher);
    await expect(storeB.read(PROVIDER)).rejects.toThrow(ProviderCredentialStoreError);
    // 核心断言：抛的是 decrypt/unknown_key 类，不是返 undefined
    try {
      await storeB.read(PROVIDER);
    } catch (err) {
      const kind = (err as ProviderCredentialStoreError).kind;
      expect(["decrypt_failed", "unknown_key_id", "invalid_envelope"]).toContain(kind);
    }
  });
});

describe("list 不解密", () => {
  it("modify 后 list 返回 {providerId, type}，不含 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-secret-abc" }));

    const infos = await store.list();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({ providerId: PROVIDER, type: "api_key" });
    const json = JSON.stringify(infos);
    expect(json).not.toContain("sk-secret-abc");
  });
});

describe("modify 校验", () => {
  it("拒绝 OAuth 类型", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(
      store.modify(PROVIDER, async () => ({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 0,
      })),
    ).rejects.toThrow(ProviderCredentialStoreError);
  });

  it("拒绝空 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(store.modify(PROVIDER, async () => ({ type: "api_key", key: "" }))).rejects.toThrow(
      ProviderCredentialStoreError,
    );
  });

  it("拒绝带 env 的 credential", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(
      store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-test-xxxx", env: { FOO: "bar" } })),
    ).rejects.toThrow(ProviderCredentialStoreError);
  });

  it("fn 返回 undefined = 保持不变", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-first" }));
    // 第二次 modify 但 fn 返 undefined
    const result = await store.modify(PROVIDER, async (current) => {
      expect((current as { key?: string })?.key).toBe("sk-first");
      return undefined;
    });
    expect((result as { key?: string })?.key).toBe("sk-first");
    // DB 里仍是第一个 key
    const cred = await store.read(PROVIDER);
    expect((cred as { key?: string })?.key).toBe("sk-first");
  });

  it("覆盖更新：第二次 modify 换 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-version-1-aaaa" }));
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-version-2-bbbb" }));
    expect(((await store.read(PROVIDER)) as { key?: string })?.key).toBe("sk-version-2-bbbb");
  });

  it("fn 抛错时不写入", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-original" }));
    await expect(
      store.modify(PROVIDER, async () => {
        throw new Error("callback boom");
      }),
    ).rejects.toThrow("callback boom");
    // 原 key 未变
    expect(((await store.read(PROVIDER)) as { key?: string })?.key).toBe("sk-original");
  });
});

describe("delete 幂等", () => {
  it("无记录删除不抛错", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(store.delete(PROVIDER)).resolves.toBeUndefined();
  });

  it("有记录删除后再 read 返 undefined（回落 env）", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-test-xxxx" }));
    await store.delete(PROVIDER);
    expect(await store.read(PROVIDER)).toBeUndefined();
  });

  it("删除后 DB 里确实没了", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-test-xxxx" }));
    await store.delete(PROVIDER);
    const rows = await db.select().from(userProviderCredentials);
    expect(rows).toHaveLength(0);
  });
});

describe("用户隔离", () => {
  it("A 的 key B 读不到（B 看到的是 undefined，回落各自 env）", async () => {
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    const storeB = createDbCredentialStore(db, OTHER_USER_ID, cipher);
    await storeA.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-user-A-aaaa" }));

    expect(((await storeA.read(PROVIDER)) as { key?: string })?.key).toBe("sk-user-A-aaaa");
    expect(await storeB.read(PROVIDER)).toBeUndefined();

    // B 存自己的，互不串
    await storeB.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-user-B-bbbb" }));
    expect(((await storeA.read(PROVIDER)) as { key?: string })?.key).toBe("sk-user-A-aaaa");
    expect(((await storeB.read(PROVIDER)) as { key?: string })?.key).toBe("sk-user-B-bbbb");
  });

  it("A 删除不影响 B", async () => {
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    const storeB = createDbCredentialStore(db, OTHER_USER_ID, cipher);
    await storeA.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-user-A-aaaa" }));
    await storeB.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-user-B-bbbb" }));

    await storeA.delete(PROVIDER);
    expect(await storeA.read(PROVIDER)).toBeUndefined();
    expect(((await storeB.read(PROVIDER)) as { key?: string })?.key).toBe("sk-user-B-bbbb");
  });
});

describe("fail-closed 错误安全", () => {
  // read 三态已验证「keyId 不匹配抛错不回落 env」。这里补充错误对象的安全性：
  // store 抛出的 ProviderCredentialStoreError 不带 cause（避免 pi 把细节拼进 ModelsError），
  // message 不含明文 key / ciphertext。

  it("解密失败的 error 不含明文 key / ciphertext", async () => {
    const storeA = createDbCredentialStore(db, TEST_USER_ID, cipher);
    const SECRET = "sk-leak-check-xyz";
    await storeA.modify(PROVIDER, async () => ({ type: "api_key", key: SECRET }));

    const wrongCipher = createProviderCredentialCipher(new Uint8Array(randomBytes(32)));
    const storeB = createDbCredentialStore(db, TEST_USER_ID, wrongCipher);
    let msg = "";
    try {
      await storeB.read(PROVIDER);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
      // cause 必须为空（pi 会拼 cause 进 ModelsError）
      expect((err as ProviderCredentialStoreError).cause).toBeUndefined();
    }
    expect(msg).not.toContain(SECRET);
  });
});

describe("raw DB row 不含明文 key", () => {
  it("modify 后直接查表，不含明文 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    const SECRET = "sk-plaintext-must-not-leak-99999";
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: SECRET }));

    const rows = await db.select().from(userProviderCredentials);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(SECRET);
    // ciphertext 列不是明文
    const row = rows[0];
    expect(row?.ciphertext).not.toBe(SECRET);
    expect(row?.ciphertext.length).toBeGreaterThan(0);
    // keyHint 只是末 4 位
    expect(row?.keyHint).toBe(SECRET.slice(-4));
  });
});

describe("keyHint", () => {
  it("存的是 key 末 4 位", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-abcdefgh1234" }));
    const rows = await db.select().from(userProviderCredentials);
    const mine = rows.find((r) => r.userId === TEST_USER_ID);
    expect(mine?.keyHint).toBe("1234");
  });
});

// B3 回归：短 key / 规范化 / hint 不泄露完整 key
describe("key 规范化与短 key 防护（B3）", () => {
  it("拒绝过短 key（< 8 字符）——短 key 的末4位会等于完整明文", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(store.modify(PROVIDER, async () => ({ type: "api_key", key: "short" }))).rejects.toThrow(
      ProviderCredentialStoreError,
    );
    // DB 里没写入
    const rows = await db.select().from(userProviderCredentials);
    expect(rows).toHaveLength(0);
  });

  it("拒绝空 key 与全空白 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(store.modify(PROVIDER, async () => ({ type: "api_key", key: "" }))).rejects.toThrow(
      ProviderCredentialStoreError,
    );
    await expect(store.modify(PROVIDER, async () => ({ type: "api_key", key: "    " }))).rejects.toThrow(
      ProviderCredentialStoreError,
    );
  });

  it("拒绝非 ASCII / 控制字符 key", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(
      store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-中文-key-1234" })),
    ).rejects.toThrow(ProviderCredentialStoreError);
    await expect(
      store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-with-\n-newline-12" })),
    ).rejects.toThrow(ProviderCredentialStoreError);
  });

  it("trim 后加密：带首尾空白的 key 存的是 trim 值，读回无空白", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "  sk-trimmed-1234  " }));
    expect(((await store.read(PROVIDER)) as { key?: string })?.key).toBe("sk-trimmed-1234");
  });

  it("keyHint 永远是 key 的子串，不是完整 key（≥8 字符 key 的末4位）", async () => {
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    const KEY = "sk-never-fullkey-leak-5678";
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: KEY }));
    const rows = await db.select().from(userProviderCredentials);
    const mine = rows.find((r) => r.userId === TEST_USER_ID);
    expect(mine?.keyHint).toBe("5678");
    expect(mine?.keyHint).not.toBe(KEY);
    expect(mine?.keyHint.length).toBeLessThan(KEY.length);
    // raw row 里完整 key 不出现
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });
});

// B6 回归：mutex map 清理无泄漏
describe("mutex map 清理（B6）", () => {
  it("单次 modify 后 mutex map 回到 0", async () => {
    const { __getCredentialMutexSize } = await import("./db-credential-store.ts");
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-cleanup-test-1" }));
    expect(__getCredentialMutexSize()).toBe(0);
  });

  it("modify 抛错后 mutex map 也回到 0（finally 释放）", async () => {
    const { __getCredentialMutexSize } = await import("./db-credential-store.ts");
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await expect(store.modify(PROVIDER, async () => ({ type: "api_key", key: "short" }))).rejects.toThrow();
    expect(__getCredentialMutexSize()).toBe(0);
  });

  it("delete 后 mutex map 回到 0", async () => {
    const { __getCredentialMutexSize } = await import("./db-credential-store.ts");
    const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
    await store.modify(PROVIDER, async () => ({ type: "api_key", key: "sk-delete-cleanup-1" }));
    await store.delete(PROVIDER);
    expect(__getCredentialMutexSize()).toBe(0);
  });

  it("多个不同 (user,provider) 操作后 mutex map 仍回到 0（无单调增长）", async () => {
    const { __getCredentialMutexSize } = await import("./db-credential-store.ts");
    for (const provider of ["deepseek", "openai", "anthropic", "google"]) {
      const store = createDbCredentialStore(db, TEST_USER_ID, cipher);
      await store.modify(provider, async () => ({ type: "api_key", key: `sk-multi-${provider}-1234` }));
    }
    expect(__getCredentialMutexSize()).toBe(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../testing.ts";
import { createUserRepository } from "./users.ts";

let db: TestDb;
let repo: ReturnType<typeof createUserRepository>;
let reset: () => Promise<void>;
let close: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  reset = testDb.reset;
  close = testDb.close;
  repo = createUserRepository(db);
});

beforeEach(() => reset());
afterAll(() => close?.());

describe("create", () => {
  it("建出来的用户默认是 user 角色且未禁用", async () => {
    const user = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    expect(user.email).toBe("a@x.io");
    expect(user.role).toBe("user");
    expect(user.disabled).toBe(false);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("返回值里没有 passwordHash", async () => {
    const user = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    expect(user).not.toHaveProperty("passwordHash");
  });

  it("可以指定角色", async () => {
    const user = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b", role: "admin" });

    expect(user.role).toBe("admin");
  });

  it("邮箱重复时抛唯一约束错误", async () => {
    await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    await expect(repo.create({ email: "a@x.io", passwordHash: "scrypt$c$d" })).rejects.toThrow();
  });
});

describe("findByEmail", () => {
  it("找得到时连 passwordHash 一起返回", async () => {
    await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    const found = await repo.findByEmail("a@x.io");

    expect(found?.passwordHash).toBe("scrypt$a$b");
  });

  it("找不到返回 undefined", async () => {
    await expect(repo.findByEmail("nobody@x.io")).resolves.toBeUndefined();
  });
});

describe("findById", () => {
  it("返回不含 passwordHash 的公开字段", async () => {
    const created = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    const found = await repo.findById(created.id);

    expect(found).toEqual({
      id: created.id,
      email: "a@x.io",
      role: "user",
      disabled: false,
      createdAt: expect.any(Date),
    });
  });

  it("找不到返回 undefined", async () => {
    await expect(repo.findById("00000000-0000-0000-0000-0000000000ff")).resolves.toBeUndefined();
  });
});

describe("setDisabled", () => {
  it("禁用后 findById 能读到", async () => {
    const created = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    await expect(repo.setDisabled(created.id, true)).resolves.toBe(true);
    expect((await repo.findById(created.id))?.disabled).toBe(true);
  });

  it("用户不存在返回 false", async () => {
    await expect(repo.setDisabled("00000000-0000-0000-0000-0000000000ff", true)).resolves.toBe(false);
  });
});

describe("setRole", () => {
  it("提权后 findById 能读到", async () => {
    const created = await repo.create({ email: "a@x.io", passwordHash: "scrypt$a$b" });

    await repo.setRole(created.id, "admin");

    expect((await repo.findById(created.id))?.role).toBe("admin");
  });
});

describe("listAll", () => {
  it("按创建时间倒序，不含 passwordHash", async () => {
    await repo.create({ email: "first@x.io", passwordHash: "scrypt$a$b" });
    // PGlite 的 now() 只有毫秒分辨率，同一毫秒内插入的两行 createdAt 会完全相同，
    // 此时 ORDER BY created_at DESC 的顺序不定（同 sessions.test.ts 的处理）
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repo.create({ email: "second@x.io", passwordHash: "scrypt$c$d" });

    const list = await repo.listAll();

    // 夹具用户也在表里，所以按邮箱过滤后再断言顺序
    const emails = list.map((user) => user.email).filter((email) => email.endsWith("@x.io"));
    expect(emails).toEqual(["second@x.io", "first@x.io"]);
    expect(list[0]).not.toHaveProperty("passwordHash");
  });
});

describe("setPasswordHash", () => {
  it("换掉哈希", async () => {
    const user = await repo.create({ email: "a@x.io", passwordHash: "old" });

    await expect(repo.setPasswordHash(user.id, "new")).resolves.toBe(true);

    const found = await repo.findByEmail("a@x.io");
    expect(found?.passwordHash).toBe("new");
  });

  it("用户不存在时返回 false", async () => {
    await expect(repo.setPasswordHash("00000000-0000-0000-0000-0000000000ff", "new")).resolves.toBe(false);
  });
});

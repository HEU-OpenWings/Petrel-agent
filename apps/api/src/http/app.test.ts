import { describe, expect, it } from "vitest";
import { app } from "./app.ts";

describe("system routes", () => {
  it("returns the service health", async () => {
    const response = await app.request("/api/system/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });
});

describe("chat routes", () => {
  it("rejects an empty message before touching the model", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "  " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "message 不能为空" } });
  });
});

const ABSENT_SESSION_ID = "11111111-1111-1111-1111-111111111111";

describe("session routes", () => {
  // 这两个用例无条件跑：路由在取 getDb() 之前就把请求挡掉了，不碰数据库
  it("非法 UUID 直接 400，不进数据库", async () => {
    const response = await app.request("/api/sessions/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新名" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "会话 id 必须是 UUID" },
    });
  });

  it("重命名时标题为空返回 400", async () => {
    const response = await app.request(`/api/sessions/${ABSENT_SESSION_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "title 不能为空" } });
  });

  /**
   * 下面两个用例必须连真实 Postgres：它们要走到 service 层的查询/删除，
   * 而 getDb() 读的是 @petrel/config 的 databaseUrl（node-postgres 连接池），
   * 没法像数据层测试那样换成进程内的 PGlite。
   *
   * 本地跑法：
   *   docker compose up -d db
   *   cd packages/database && npx drizzle-kit migrate   # 首次建表
   *   DATABASE_URL=postgres://petrel:petrel@localhost:5432/petrel pnpm vitest run apps/api/src/http/app.test.ts
   *
   * 不设 DATABASE_URL 时整块跳过——config 的默认值虽然也指向本地库，
   * 但 CI 没有这个库，让它连接失败会把整个测试文件拖红。
   */
  describe.skipIf(!process.env.DATABASE_URL)("需要真实 Postgres", () => {
    it("列表接口返回数组", async () => {
      const response = await app.request("/api/sessions");

      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty("sessions");
    });

    it("删除不存在的会话返回 404", async () => {
      const response = await app.request(`/api/sessions/${ABSENT_SESSION_ID}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(404);
    });
  });
});

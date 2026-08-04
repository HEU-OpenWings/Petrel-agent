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
  it("rejects an unauthenticated request", async () => {
    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "  " }),
    });

    expect(response.status).toBe(401);
  });
});

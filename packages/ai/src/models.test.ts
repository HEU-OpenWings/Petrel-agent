import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, findModel, listModels } from "./index.ts";

describe("listModels", () => {
  it("列出所有已注册的模型", () => {
    const ids = listModels().map((model) => model.id);

    expect(ids).toContain(DEFAULT_MODEL_ID);
    expect(ids).toContain("deepseek-ai/DeepSeek-V3");
  });

  it("每一项都带展示用的名字与 provider", () => {
    const model = listModels().find((item) => item.id === DEFAULT_MODEL_ID);

    expect(model).toMatchObject({
      id: DEFAULT_MODEL_ID,
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      providerName: "DeepSeek",
    });
  });

  // 前端靠这个标记显示「跟随系统默认」时到底用的哪个模型，
  // 否则偏好为 null 时输入框旁只能显示空
  it("恰好一个模型标着 isDefault，且是 DEFAULT_MODEL_ID", () => {
    const defaults = listModels().filter((model) => model.isDefault);

    expect(defaults.map((model) => model.id)).toEqual([DEFAULT_MODEL_ID]);
  });

  // 摘要是给 HTTP 响应用的，不该把 baseUrl / cost / 内部开关吐给前端
  it("摘要里没有 baseUrl 与 cost", () => {
    expect(JSON.stringify(listModels())).not.toContain("baseUrl");
    expect(JSON.stringify(listModels())).not.toContain("cost");
  });
});

describe("findModel", () => {
  it("按 id 查得到已注册的模型", () => {
    expect(findModel(DEFAULT_MODEL_ID)?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("未注册的 id 返回 undefined", () => {
    expect(findModel("gpt-does-not-exist")).toBeUndefined();
  });

  // listModels 与 findModel 必须同源，否则会出现「清单里有但查不到」的模型
  it("清单里的每一个 id 都查得到", () => {
    for (const summary of listModels()) {
      expect(findModel(summary.id)?.id).toBe(summary.id);
    }
  });
});

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@petrel/agent": fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
      "@petrel/ai": fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
      "@petrel/config": fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
      "@petrel/database/testing": fileURLToPath(
        new URL("./packages/database/src/testing.ts", import.meta.url),
      ),
      "@petrel/database": fileURLToPath(new URL("./packages/database/src/index.ts", import.meta.url)),
      "@petrel/logger": fileURLToPath(new URL("./packages/logger/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    exclude: ["**/dist/**", "**/node_modules/**"],
    // PGlite 是 WASM，实例化空载就要约 1 秒，CPU 被打满时会超线性劣化到十几秒，
    // 默认 10 秒的 hookTimeout 挡不住。数据层测试每个文件在 beforeAll 里建一次实例。
    //
    // 这跟之前每个 beforeEach 上挂 30_000 的补丁性质不同：那时是用超时掩盖
    // 「每个用例建一个实例」的设计缺陷（实例数与用例数同阶），治法是减少实例数；
    // 现在实例数已降到每文件一个，剩下的就是一次性昂贵操作，给它一个诚实的预算。
    hookTimeout: 30_000,
  },
});

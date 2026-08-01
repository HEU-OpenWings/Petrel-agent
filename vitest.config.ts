import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@petrel/agent-core": fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
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
  },
});

import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["src/main/test-support/alo-fixture.ts"],
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
    },
  },
});

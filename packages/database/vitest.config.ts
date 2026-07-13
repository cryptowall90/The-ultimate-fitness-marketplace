import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB tests share one database; run files sequentially.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

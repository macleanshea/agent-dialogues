import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30_000,
    // No secrets and no network in tests.
    env: { DATABASE_URL: "", ANTHROPIC_API_KEY: "" },
  },
});

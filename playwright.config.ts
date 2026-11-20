import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// Runs against a production build (`npm run build` first) with a fresh local
// database. No secrets, no network.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .pglite-e2e && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PGLITE_DIR: ".pglite-e2e", DATABASE_URL: "", ANTHROPIC_API_KEY: "" },
  },
});

import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// Runs against a production build (`npm run build` first) with a fresh local
// database and a fresh local Workflow store, so runs go through the real
// workflow code. No secrets, no network.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .pglite-e2e .workflow-data-e2e && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PGLITE_DIR: ".pglite-e2e",
      DATABASE_URL: "",
      ANTHROPIC_API_KEY: "",
      // CI has no API key, so the click-through tests use the Mock model, which deployments do not offer.
      MOCK_MODEL: "on",
      PORT: String(PORT),
      WORKFLOW_LOCAL_DATA_DIR: ".workflow-data-e2e",
    },
  },
});

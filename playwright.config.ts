import { defineConfig } from "@playwright/test";
import path from "path";

const testDbPath = path.resolve(process.cwd(), "output/playwright/test.db");
const testEnv = `DATABASE_URL=file:${testDbPath} TRIAGE_ENABLED=false`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `${testEnv} npm run dev:servers`,
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

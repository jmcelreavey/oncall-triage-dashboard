import { test, expect } from "@playwright/test";
import { mkdir, copyFile } from "fs/promises";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { execSync } from "child_process";
import { existsSync } from "fs";

type SeededRuns = {
  runId: string;
  codexRunId: string;
};

let seeded: SeededRuns = { runId: "", codexRunId: "" };

async function ensureTestDb(dbPath: string) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const devDb = path.resolve(process.cwd(), "apps/api/dev.db");
  if (existsSync(devDb)) {
    await copyFile(devDb, dbPath);
    return;
  }
  execSync(
    "npx prisma db push --schema apps/api/prisma/schema.prisma --skip-generate",
    {
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "ignore",
    },
  );
}

async function seedReports(): Promise<SeededRuns> {
  const dbPath = path.resolve(process.cwd(), "output/playwright/test.db");
  await ensureTestDb(dbPath);
  const url = `file:${dbPath}`;
  process.env.DATABASE_URL = url;
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url }),
  });

  await prisma.triageRun.deleteMany();
  await prisma.alertEvent.deleteMany();

  const alert = await prisma.alertEvent.create({
    data: {
      monitorId: "mon-123",
      monitorName: "Sample Alert: PDB Not Respected",
      monitorState: "Alert",
      monitorUrl: "https://app.datadoghq.com/monitors/123",
      monitorMessage: "Service capi-core PDB not respected",
      service: "capi-core",
      environment: "prd",
      overallStateModified: new Date(),
    },
  });

  const run = await prisma.triageRun.create({
    data: {
      alertId: alert.id,
      status: "complete",
      provider: "opencode",
      reportMarkdown: "Triage report placeholder.",
      sessionUrl: "http://127.0.0.1:4096/session/example",
      evidenceTimeline: [
        {
          id: "repo-status",
          title: "Repo status & recent commits",
          status: "ok",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summary: "Captured last commits.",
        },
      ],
      fixSuggestions: [
        {
          title: "PDB minReplicas conflict",
          summary: "Increase minReplicas to satisfy PDB.",
          confidence: 0.72,
          diff: "--- a/k8s/hpa.yaml\\n+++ b/k8s/hpa.yaml\\n@@\\n-minReplicas: 0\\n+minReplicas: 1",
          files: [{ path: "k8s/hpa.yaml", line: 12, text: "minReplicas: 0" }],
        },
      ],
    },
  });

  const codexRun = await prisma.triageRun.create({
    data: {
      alertId: alert.id,
      status: "complete",
      provider: "codex",
      reportMarkdown: "Codex triage report placeholder.",
      sessionId: "ses_test_123",
    },
  });

  await prisma.$disconnect();
  return { runId: run.id, codexRunId: codexRun.id };
}

test.beforeAll(async () => {
  seeded = await seedReports();
});

test("dashboard loads and shows key sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Oncall Triage Dashboard")).toBeVisible();
  await expect(page.getByText("Latest Reports")).toBeVisible();
  await expect(page.getByTestId("open-connection-wizard")).toBeVisible();
  await expect(page.getByTestId("scheduler-title")).toBeVisible();
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({
    path: "output/playwright/dashboard.png",
    fullPage: true,
  });
});

test("report actions and connection wizard respond", async ({ page }) => {
  await page.route("**/triage/run", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ queued: true }),
    }),
  );
  await page.route(`**/triage/continue/${seeded.runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ queued: true, runId: "queued-continue" }),
    }),
  );
  await page.route(`**/triage/rerun/${seeded.runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ queued: true, runId: "queued-rerun" }),
    }),
  );
  await page.route(`**/triage/suggest-branch/${seeded.runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        branchName: "codex/fix-pdb",
        commands: ["git checkout -b codex/fix-pdb"],
        files: ["k8s/capi-core/hpa.yaml"],
      }),
    }),
  );
  await page.route(`**/triage/open-codex/${seeded.codexRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("**/triage/clear-running", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, cleared: 1 }),
    }),
  );
  await page.route("**/integrations/configure", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );
  await page.route("**/integrations/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        datadogApiKey: "dd-api-key",
        datadogAppKey: "dd-app-key",
        datadogSite: "datadoghq.com",
        alertTeam: "dad",
        githubToken: "",
        confluenceBaseUrl: "",
        confluenceUser: "",
        confluenceToken: "",
        provider: "opencode",
        repoRoot: "/Users/jmcelreavey/Developer",
        opencodeWebUrl: "http://127.0.0.1:4096",
        codexBin: "/Applications/Codex.app/Contents/Resources/codex",
        codexModel: "gpt-5.2-codex",
        enrichGithub: true,
        enrichConfluence: true,
      }),
    }),
  );

  await page.goto("/");

  await page.getByTestId("trigger-run").click();
  await expect(
    page.getByText("Queued. Check Latest Reports in a moment."),
  ).toBeVisible();

  await page.getByTestId(`suggest-branch-${seeded.runId}`).click();
  await expect(page.getByText("codex/fix-pdb", { exact: true })).toBeVisible();

  await page.getByTestId(`rerun-run-${seeded.runId}`).click();
  await expect(
    page.getByText("Queued. Check Latest Reports in a moment."),
  ).toBeVisible();

  await page.getByTestId(`continue-run-${seeded.runId}`).click();
  await expect(
    page.getByText("Queued. Check Latest Reports in a moment."),
  ).toBeVisible();

  await page.getByTestId(`open-codex-${seeded.codexRunId}`).click();
  await expect(page.getByText("Opened Codex session.")).toBeVisible();

  await expect(page.getByText("Triage Timeline")).toBeVisible();
  await page.getByText("Draft Fix Suggestions").click();
  await expect(page.getByText("PDB minReplicas conflict")).toBeVisible();
  await expect(page.getByText("Open File").first()).toBeVisible();
  await expect(page.getByText("Copy Patch")).toBeVisible();

  await page.getByTestId("open-connection-wizard").click();
  await expect(page.getByTestId("connection-wizard-modal")).toBeVisible();
  await page.getByPlaceholder("DATADOG_API_KEY").fill("dd-api-key");
  await page.getByTestId("connection-wizard-save").click();
  await expect(
    page.getByText("Saved. You may need to restart the API for full effect."),
  ).toBeVisible();
});

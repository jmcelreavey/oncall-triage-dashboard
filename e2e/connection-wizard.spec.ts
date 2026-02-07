import { test, expect } from "@playwright/test";

test("Connection Wizard shows consolidated Atlassian section", async ({
  page,
}) => {
  await page.route("**/integrations/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        datadogApiKey: "dd-key",
        datadogAppKey: "dd-app",
        datadogSite: "datadoghq.com",
        alertTeam: "dad",
        githubToken: "",
        confluenceBaseUrl: "https://example.atlassian.net/wiki",
        confluenceUser: "user@example.com",
        confluenceToken: "token123",
        provider: "opencode",
      }),
    }),
  );

  await page.goto("/");
  await page.getByTestId("open-connection-wizard").click();
  await expect(page.getByTestId("connection-wizard-modal")).toBeVisible();

  // Layout is vertical stacked sections, not side-by-side
  await expect(page.getByText("Atlassian (Confluence & JIRA)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Datadog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "GitHub" })).toBeVisible();

  // No separate JIRA section or JIRA_BASE_URL field
  await expect(page.getByText("JIRA (optional)")).not.toBeVisible();

  // Atlassian fields present
  await expect(
    page.getByPlaceholder("https://yourcompany.atlassian.net"),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Email address")).toBeVisible();
  await expect(page.getByPlaceholder("API Token")).toBeVisible();

  // Token link present
  await expect(page.getByText("id.atlassian.com")).toBeVisible();

  await page.screenshot({
    path: "output/playwright/connection-wizard.png",
    fullPage: true,
  });
});

test("Report card renders readable summary, not raw JSON", async ({ page }) => {
  // Mock reports endpoint with a completed report
  await page.route("**/reports", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "test-run-1",
          createdAt: new Date().toISOString(),
          status: "complete",
          provider: "opencode",
          sessionUrl: "http://127.0.0.1:4096/session/test123",
          reportMarkdown:
            "## Summary\nThe FluxCD alert was triggered due to a failing GitRepository resource.\n\n## Root Cause\nThe git credentials expired for the repository.\n\n## Recommended Actions\n- Rotate the git credentials\n- Verify the GitRepository resource status",
          evidenceTimeline: [
            {
              id: "k8s-state",
              title: "Kubernetes live state",
              status: "ok",
              startedAt: new Date().toISOString(),
              summary: "Captured cluster state.",
              artifacts: ["k8s_state"],
            },
            {
              id: "datadog-logs",
              title: "Datadog logs (recent)",
              status: "ok",
              startedAt: new Date().toISOString(),
              summary: "Fetched 5 logs.",
              artifacts: ["datadog_logs"],
            },
          ],
          alert: {
            monitorName: "Dad Team FluxCD Errors Alert",
            monitorState: "Alert",
            priority: 2,
            monitorUrl: "https://app.datadoghq.com/monitors/123",
            service: "capi-core",
            environment: "prd",
            overallStateModified: new Date().toISOString(),
          },
        },
      ]),
    }),
  );

  await page.goto("/");

  // Summary should be rendered as readable text, not raw JSON
  await expect(
    page
      .getByText(
        "The FluxCD alert was triggered due to a failing GitRepository resource.",
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText("Root Cause").first()).toBeVisible();

  // Open in OpenCode button should be visible
  await expect(page.getByText("Open in OpenCode").first()).toBeVisible();

  // Datadog button should be visible (use role to be specific)
  await expect(page.getByRole("link", { name: "DataDog" })).toBeVisible();

  await page.screenshot({
    path: "output/playwright/report-card.png",
    fullPage: true,
  });
});

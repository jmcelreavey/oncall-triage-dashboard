"use client";

import { useEffect, useState } from "react";
import { ConnectionWizard } from "@/components/connection-wizard";
import { ThemeToggle } from "@/components/theme-toggle";
import { ReportsList } from "@/components/reports-list";
import {
  fetchConfig,
  fetchHealth,
  fetchIntegrations,
  fetchPermissions,
  fixPermissions,
} from "@/lib/api";

type Integration = {
  name: string;
  configured: boolean;
  ok: boolean | null;
  message?: string;
  checkedAt?: string;
};

type HealthStatus = {
  scheduler?: {
    lastRunAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    intervalMs?: number;
    staleThresholdMs?: number;
    stale?: boolean;
  };
};

type Config = {
  provider?: string;
  datadogApiKey?: string;
  datadogAppKey?: string;
  confluenceBaseUrl?: string;
  confluenceUser?: string;
  confluenceToken?: string;
};

type PermissionCheck = {
  provider: string;
  ok: boolean;
  issues: Array<{ key: string; message: string; severity: "error" | "warn" }>;
  fixAvailable: boolean;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatMaybeDate(value?: string | null) {
  if (!value) return "—";
  return formatDate(value);
}

function schedulerPill(stale?: boolean) {
  if (stale === undefined)
    return "border-dashed border-[var(--border)] text-[var(--ink-muted)]";
  return stale
    ? "border-[var(--accent)] text-[var(--accent)]"
    : "border-[var(--accent-3)] text-[var(--accent-3)]";
}

function excerpt(text?: string, max = 200) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

export default function Home() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runningCount, setRunningCount] = useState(0);
  const [permCheck, setPermCheck] = useState<PermissionCheck | null>(null);
  const [fixingPerms, setFixingPerms] = useState(false);
  const [permDismissed, setPermDismissed] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const [integrationsData, healthData, configData, permData] =
          await Promise.all([
            fetchIntegrations(),
            fetchHealth(),
            fetchConfig(),
            fetchPermissions(),
          ]);
        setIntegrations(integrationsData as Integration[]);
        setHealth(healthData as HealthStatus | null);
        setConfig(configData as Config | null);
        setPermCheck(permData as PermissionCheck | null);
      } catch (error) {
        console.error("[Home] Failed to load data:", error);
      }
    }
    loadData();

    // Poll health every 10 seconds to keep scheduler status fresh
    const interval = setInterval(() => {
      fetchHealth()
        .then((data) => setHealth(data as HealthStatus | null))
        .catch(console.error);
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  const scheduler = health?.scheduler;
  const schedulerError = scheduler?.lastError
    ? excerpt(scheduler.lastError, 120)
    : null;
  const providerName = config?.provider ?? "opencode";
  const providerStatus = integrations.find(
    (integration) => integration.name === providerName,
  );
  const datadogOk = Boolean(config?.datadogApiKey && config?.datadogAppKey);
  const confluenceOk = Boolean(
    config?.confluenceBaseUrl &&
    config?.confluenceUser &&
    config?.confluenceToken,
  );
  const providerOk = providerStatus?.ok === true;
  const missing: string[] = [];
  if (!datadogOk) missing.push("Datadog");
  if (!confluenceOk) missing.push("Confluence");
  if (!providerOk) missing.push("Provider");
  const configureStatus =
    missing.length === 0 ? "Ready" : `Needs ${missing.join(" + ")}`;
  const configureTone = missing.length === 0 ? "ok" : "warn";

  async function handleFixPermissions() {
    setFixingPerms(true);
    try {
      const result = await fixPermissions();
      if (result?.ok) {
        // Re-check permissions after fix
        const updated = await fetchPermissions();
        setPermCheck(updated as PermissionCheck | null);
      }
    } catch (error) {
      console.error("[Home] Failed to fix permissions:", error);
    } finally {
      setFixingPerms(false);
    }
  }

  const showPermWarning = permCheck && !permCheck.ok && !permDismissed;

  return (
    <div className="min-h-screen px-6 py-10">
      {isRunning && (
        <div className="fixed top-4 right-4 z-50 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-pulse">
          <div className="w-2 h-2 bg-white rounded-full animate-ping" />
          <span className="text-sm font-medium">
            Running triage ({runningCount})
          </span>
        </div>
      )}

      {showPermWarning && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-2xl w-full mx-auto">
          <div className="glass border border-[var(--accent)] rounded-xl px-5 py-4 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="chip border-[var(--accent)] text-[var(--accent)]">
                    Permission Issue
                  </span>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {permCheck.provider}
                  </span>
                </div>
                <p className="text-sm text-[var(--ink-muted)] mt-1">
                  {permCheck.provider === "opencode"
                    ? "OpenCode headless permissions are not configured. Triage runs will fail because the agent cannot execute tools without approval prompts."
                    : (permCheck.issues[0]?.message ??
                      "Provider permission issue detected.")}
                </p>
                {permCheck.issues.map((issue) => (
                  <p
                    key={issue.key}
                    className="text-xs text-[var(--ink-muted)] mt-1 font-mono opacity-70"
                  >
                    {issue.message}
                  </p>
                ))}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                {permCheck.fixAvailable && (
                  <button
                    onClick={handleFixPermissions}
                    disabled={fixingPerms}
                    className="chip border-[var(--accent-3)] text-[var(--accent-3)] hover:bg-[var(--accent-3)] hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {fixingPerms ? "Fixing..." : "Fix Now"}
                  </button>
                )}
                <button
                  onClick={() => setPermDismissed(true)}
                  className="chip border-[var(--border)] text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="chip text-[var(--ink-muted)]">Local / Self-hosted</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--ink)]">
              Oncall Triage Dashboard
            </h1>
            <p className="mt-2 max-w-2xl text-base text-[var(--ink-muted)]">
              Automated Datadog triage that leans on agent tooling (git,
              kubectl, GitHub, Confluence) to provide an evidence-driven fix
              plan.
            </p>
          </div>
          <div className="w-full max-w-xs">
            <div className="glass flex flex-col gap-4 rounded-2xl px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span
                    className="text-sm text-[var(--ink-muted)]"
                    data-testid="scheduler-title"
                  >
                    Scheduler
                  </span>
                  <p className="text-xs text-[var(--ink-muted)]">
                    Every 1 minute
                  </p>
                  <p className="mt-1 text-[0.7rem] text-[var(--ink-muted)]">
                    Last tick: {formatMaybeDate(scheduler?.lastRunAt)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`chip ${schedulerPill(scheduler?.stale)}`}>
                    {scheduler?.stale === undefined
                      ? "Unknown"
                      : scheduler?.stale
                        ? "Stale"
                        : "Healthy"}
                  </span>
                  <span className="text-[0.65rem] text-[var(--ink-muted)]">
                    Last success: {formatMaybeDate(scheduler?.lastSuccessAt)}
                  </span>
                  {schedulerError && (
                    <span className="text-[0.65rem] text-[var(--accent)]">
                      Last error: {schedulerError}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <ThemeToggle className="w-full" />
              </div>
              <div className="flex flex-col gap-2">
                <ConnectionWizard
                  statusLabel={configureStatus}
                  statusTone={configureTone}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        </header>

        <ReportsList
          onRunningChange={(running, count) => {
            setIsRunning(running);
            setRunningCount(count);
          }}
        />
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { BranchSuggestionButton } from "@/components/branch-suggestion-button";
import { ContinueRunButton } from "@/components/continue-run-button";
import { OpenCodexButton } from "@/components/open-codex-button";
import { TriggerRunButton } from "@/components/trigger-run-button";
import { OpenFileButton } from "@/components/open-file-button";
import { CopyButton } from "@/components/copy-button";
import { ClearDataButton } from "@/components/clear-data-button";
import { RerunButton } from "@/components/rerun-button";
import { ReportSummary } from "@/components/report-summary";
import { fetchReports } from "@/lib/api";

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

type Report = {
  id: string;
  createdAt: string;
  status?: "running" | "complete" | "failed";
  error?: string | null;
  finishedAt?: string | null;
  reportMarkdown?: string;
  sessionUrl?: string;
  sessionId?: string;
  provider?: string;
  evidenceTimeline?: EvidenceStep[];
  fixSuggestions?: FixSuggestion[];
  similarIncidents?: SimilarIncident[];
  alert?: {
    monitorName?: string;
    monitorState?: string;
    priority?: number | null;
    monitorUrl?: string;
    service?: string;
    environment?: string;
    repoPath?: string;
    overallStateModified?: string;
  };
};

type EvidenceStep = {
  id: string;
  title: string;
  status: "ok" | "error" | "skipped";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  artifacts?: string[];
};

type FixSuggestion = {
  title: string;
  summary: string;
  confidence: number;
  diff?: string;
  files?: { path: string; line?: number; text?: string }[];
};

type SimilarIncident = {
  id: string;
  createdAt: string;
  summary: string;
  confidence: number;
  service?: string;
  monitorName?: string;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function timeAgo(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function monitorStatePill(state?: string) {
  if (!state)
    return "border-dashed border-[var(--border)] text-[var(--ink-muted)]";
  const normalized = state.toLowerCase();
  if (normalized.includes("alert"))
    return "border-[var(--accent)] text-[var(--accent)]";
  if (normalized.includes("warn"))
    return "border-[var(--accent-2)] text-[var(--accent-2)]";
  if (normalized.includes("no_data"))
    return "border-[var(--accent-3)] text-[var(--accent-3)]";
  return "border-[var(--border)] text-[var(--ink-muted)]";
}

function cardAccent(state?: string) {
  if (!state) return "border-[var(--border)]";
  const normalized = state.toLowerCase();
  if (normalized.includes("alert")) return "border-[var(--accent)]";
  if (normalized.includes("warn")) return "border-[var(--accent-2)]";
  if (normalized.includes("no_data")) return "border-[var(--accent-3)]";
  return "border-[var(--border)]";
}

function alertPriority(state?: string) {
  if (!state) return 0;
  const normalized = state.toLowerCase();
  if (normalized.includes("alert")) return 3;
  if (normalized.includes("warn")) return 2;
  if (normalized.includes("no_data")) return 1;
  return 0;
}

function priorityRank(priority?: number | null) {
  if (!priority) return 99;
  return priority;
}

function priorityPill(priority?: number | null) {
  if (!priority) return "border-[var(--border)] text-[var(--ink-muted)]";
  if (priority <= 2) return "border-[var(--accent)] text-[var(--accent)]";
  if (priority === 3) return "border-[var(--accent-2)] text-[var(--accent-2)]";
  return "border-[var(--accent-3)] text-[var(--accent-3)]";
}

function runStatusPriority(status?: string) {
  if (status === "running") return 2;
  if (status === "failed") return 1;
  return 0;
}

function runStatusPill(status?: string) {
  if (status === "running")
    return "border-[var(--accent-2)] text-[var(--accent-2)]";
  if (status === "failed") return "border-[var(--accent)] text-[var(--accent)]";
  return "border-[var(--border)] text-[var(--ink-muted)]";
}

function excerpt(text?: string, max = 200) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

function extractSlackMessage(text?: string) {
  if (!text) return null;
  const lines = text.split("\n");
  const idx = lines.findIndex((line) =>
    line.toLowerCase().includes("slack-ready message"),
  );
  if (idx === -1) return null;
  const snippet = lines
    .slice(idx + 1)
    .join("\n")
    .trim();
  if (!snippet) return null;
  const nextSectionIndex = snippet.search(/\n\s*\n/);
  if (nextSectionIndex > 0) {
    return snippet.slice(0, nextSectionIndex).trim();
  }
  return snippet;
}

function evidenceStats(steps?: EvidenceStep[]) {
  if (!steps || steps.length === 0) return null;
  const ok = steps.filter((s) => s.status === "ok").length;
  const error = steps.filter((s) => s.status === "error").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  return { ok, error, skipped };
}

export function ReportsList({
  onRunningChange,
}: {
  onRunningChange: (isRunning: boolean, count: number) => void;
}) {
  const [reports, setReports] = useState<Report[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

    async function loadReports() {
      try {
        const data = await fetchReports();
        setReports(data as Report[]);
      } catch (error) {
        console.error("[ReportsList] Failed to load reports:", error);
      }
    }

    loadReports();

    const eventSourceUrl = `${API_URL}/events/stream`;
    console.log("[ReportsList] Connecting to SSE:", eventSourceUrl);
    eventSource = new EventSource(eventSourceUrl);

    eventSource.onopen = () => {
      console.log("[ReportsList] SSE connection opened");
      setConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "initial" || data.type === "update") {
          const newReports = data.reports || [];
          console.log(
            "[ReportsList] Received update, reports count:",
            newReports.length,
          );
          setReports(newReports);
          const runningReports = newReports.filter(
            (r: { status?: string }) => r.status === "running",
          );
          onRunningChange(runningReports.length > 0, runningReports.length);
        }
      } catch (error) {
        console.error("[ReportsList] Failed to parse SSE event:", error);
      }
    };

    eventSource.onerror = (error) => {
      console.error("[ReportsList] SSE connection error:", error);
      setConnected(false);
      eventSource?.close();
    };

    return () => {
      console.log("[ReportsList] Cleaning up SSE connection");
      eventSource?.close();
    };
  }, [onRunningChange]);

  const sortedReports = reports.slice().sort((a, b) => {
    const statusDiff =
      runStatusPriority(b.status) - runStatusPriority(a.status);
    if (statusDiff !== 0) return statusDiff;
    const priorityDiff =
      priorityRank(a.alert?.priority) - priorityRank(b.alert?.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const stateDiff =
      alertPriority(b.alert?.monitorState) -
      alertPriority(a.alert?.monitorState);
    if (stateDiff !== 0) return stateDiff;
    const aTime = a.alert?.overallStateModified
      ? new Date(a.alert.overallStateModified).getTime()
      : new Date(a.createdAt).getTime();
    const bTime = b.alert?.overallStateModified
      ? new Date(b.alert.overallStateModified).getTime()
      : new Date(b.createdAt).getTime();
    return bTime - aTime;
  });

  return (
    <>
      <div
        data-connected={connected ? "true" : "false"}
        className={`fixed bottom-4 right-4 z-50 px-2 py-1 rounded text-xs ${
          connected ? "bg-green-500" : "bg-red-500"
        } text-white`}
      >
        SSE: {connected ? "Connected" : "Disconnected"}
      </div>
      <section className="glass rounded-3xl p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-[var(--ink)]">
              Latest Reports
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">
              Most recent completed triage runs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TriggerRunButton />
            <ClearDataButton />
          </div>
        </div>

        <div className="mt-6 grid gap-4">
          {reports.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--border)] p-6 text-sm text-[var(--ink-muted)]">
              No reports yet. Run a manual triage or wait for the scheduler.
            </div>
          )}
          {sortedReports.map((report) => {
            const stats = evidenceStats(report.evidenceTimeline);
            const slackMessage =
              report.status === "complete"
                ? extractSlackMessage(report.reportMarkdown)
                : null;
            const isComplete = report.status === "complete";
            const isRunning = report.status === "running";
            const isFailed = report.status === "failed";
            return (
              <div
                key={report.id}
                className={`rounded-2xl p-5 panel ${cardAccent(report.alert?.monitorState)}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-[var(--ink-muted)]">
                      {formatDate(
                        report.alert?.overallStateModified ?? report.createdAt,
                      )}{" "}
                      ·{" "}
                      {timeAgo(
                        report.alert?.overallStateModified ?? report.createdAt,
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-[var(--ink)]">
                        {report.alert?.monitorName ?? "Unknown monitor"}
                      </h3>
                      <span
                        className={`chip ${monitorStatePill(report.alert?.monitorState)}`}
                      >
                        {report.alert?.monitorState ?? "unknown"}
                      </span>
                      {report.alert?.priority ? (
                        <span
                          className={`chip ${priorityPill(report.alert.priority)}`}
                        >
                          P{report.alert.priority}
                        </span>
                      ) : null}
                      {report.status && report.status !== "complete" && (
                        <span
                          className={`chip ${runStatusPill(report.status)}`}
                        >
                          {report.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {report.alert?.service ?? "unknown-service"} ·{" "}
                      {report.alert?.environment ?? "env?"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {report.provider && (
                        <span className="chip border-[var(--border)] text-[var(--ink-muted)]">
                          Provider {report.provider}
                        </span>
                      )}
                      {stats && (
                        <span className="chip border-[var(--border)] text-[var(--ink-muted)]">
                          Evidence {stats.ok} ok · {stats.error} err ·{" "}
                          {stats.skipped} skipped
                        </span>
                      )}
                      {report.fixSuggestions &&
                        report.fixSuggestions.length > 0 && (
                          <span className="chip border-[var(--accent-2)] text-[var(--accent-2)]">
                            Draft fixes {report.fixSuggestions.length}
                          </span>
                        )}
                      {report.similarIncidents &&
                        report.similarIncidents.length > 0 && (
                          <span className="chip border-[var(--accent-3)] text-[var(--accent-3)]">
                            Similar {report.similarIncidents.length}
                          </span>
                        )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {report.alert?.monitorUrl && (
                      <a
                        className="inline-flex items-center rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink-muted)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)]"
                        href={report.alert.monitorUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        DataDog
                      </a>
                    )}
                    {isComplete && report.sessionUrl && (
                      <a
                        className="inline-flex items-center rounded-full border border-[var(--accent-2)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--accent-2)] transition hover:bg-[var(--accent-2)] hover:text-white"
                        href={report.sessionUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {report.provider === "opencode"
                          ? "Open in OpenCode"
                          : "Open Session"}
                      </a>
                    )}
                    {isComplete && <BranchSuggestionButton runId={report.id} />}
                    {!isRunning && <RerunButton runId={report.id} />}
                    {false && <ContinueRunButton runId={report.id} />}
                    {slackMessage && (
                      <CopyButton text={slackMessage} label="Copy Slack" />
                    )}
                    {isComplete &&
                      report.provider === "codex" &&
                      report.sessionId && <OpenCodexButton runId={report.id} />}
                  </div>
                </div>
                {isRunning && (
                  <div className="mt-4 rounded-xl panel-muted p-4">
                    <p className="text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      Triage in progress
                    </p>
                    <p className="mt-2 text-sm text-[var(--ink)]">
                      Evidence collection and provider analysis are running.
                      This card will update automatically once complete.
                    </p>
                  </div>
                )}
                {isFailed && (
                  <div className="mt-4 rounded-xl panel-muted p-4">
                    <p className="text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      Triage failed
                    </p>
                    <p className="mt-2 text-sm text-[var(--ink)]">
                      {excerpt(report.error ?? "Unknown error", 240)}
                    </p>
                  </div>
                )}
                {isComplete && report.reportMarkdown && (
                  <div className="mt-4 rounded-xl panel-muted p-4 overflow-hidden">
                    <p className="text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      {slackMessage ? "Slack-ready message" : "Summary"}
                    </p>
                    {slackMessage ? (
                      <pre className="mt-2 whitespace-pre-wrap text-sm text-[var(--ink)]">
                        {slackMessage}
                      </pre>
                    ) : (
                      <div className="mt-2 prose prose-sm text-sm text-[var(--ink)] max-w-none">
                        <ReportSummary markdown={report.reportMarkdown} />
                      </div>
                    )}
                    <details className="mt-3 text-xs text-[var(--ink-muted)]">
                      <summary className="cursor-pointer text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                        Full report
                      </summary>
                      <pre className="code-block mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-xl p-4 text-xs">
                        {report.reportMarkdown}
                      </pre>
                    </details>
                  </div>
                )}
                {report.evidenceTimeline &&
                  report.evidenceTimeline.length > 0 && (
                    <details className="mt-4 rounded-2xl panel-muted p-4">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                        Triage Timeline · {report.evidenceTimeline.length} steps
                      </summary>
                      <div className="mt-3 grid gap-2">
                        {report.evidenceTimeline.map((step) => {
                          const isOk = step.status === "ok";
                          const isError = step.status === "error";
                          return (
                            <div
                              key={step.id}
                              className={`flex flex-wrap items-center justify-between rounded-xl border border-dashed px-3 py-2 text-xs ${
                                isError
                                  ? "border-[var(--accent)] bg-[var(--accent)]/5"
                                  : "border-[var(--border)]"
                              }`}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-[var(--ink)] truncate">
                                  {step.title}
                                </p>
                                <p
                                  className={`text-[0.7rem] ${
                                    isError
                                      ? "text-[var(--accent)]"
                                      : "text-[var(--ink-muted)]"
                                  }`}
                                >
                                  {step.summary}
                                </p>
                                {step.artifacts &&
                                  step.artifacts.length > 0 && (
                                    <p className="text-[0.65rem] text-[var(--ink-muted)] mt-1">
                                      Artifacts: {step.artifacts.join(", ")}
                                    </p>
                                  )}
                              </div>
                              <span
                                className={`chip ml-3 ${
                                  isError
                                    ? "border-[var(--accent)] text-[var(--accent)]"
                                    : isOk
                                      ? "border-[var(--accent-3)] text-[var(--accent-3)]"
                                      : "border-[var(--border)] text-[var(--ink-muted)]"
                                }`}
                              >
                                {step.status}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}

                {report.fixSuggestions && report.fixSuggestions.length > 0 && (
                  <details className="mt-4 rounded-2xl panel-muted p-4">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      Draft Fix Suggestions · {report.fixSuggestions.length}
                    </summary>
                    <div className="mt-3 grid gap-4">
                      {report.fixSuggestions.map((suggestion, idx) => (
                        <div
                          key={`${suggestion.title}-${idx}`}
                          className="rounded-xl border border-[var(--border)] p-3"
                        >
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-[var(--ink)]">
                              {suggestion.title}
                            </p>
                            <span className="chip border-[var(--accent-2)] text-[var(--accent-2)]">
                              {(suggestion.confidence * 100).toFixed(0)}%
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-[var(--ink-muted)]">
                            {suggestion.summary}
                          </p>
                          {suggestion.diff && (
                            <div className="mt-3">
                              <div className="mb-2 flex items-center justify-between">
                                <span className="text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                                  Patch
                                </span>
                                <CopyButton
                                  text={suggestion.diff}
                                  label="Copy Patch"
                                />
                              </div>
                              <pre className="code-block whitespace-pre-wrap rounded-xl p-3 text-[0.65rem]">
                                {suggestion.diff}
                              </pre>
                            </div>
                          )}
                          {suggestion.files && suggestion.files.length > 0 && (
                            <div className="mt-3 flex flex-wrap items-center gap-3">
                              {suggestion.files.slice(0, 3).map((file) => (
                                <div
                                  key={`${file.path}-${file.line}`}
                                  className="flex items-center gap-2"
                                >
                                  <span className="text-[0.65rem] text-[var(--ink-muted)]">
                                    {file.path}:{file.line ?? 1}
                                  </span>
                                  <OpenFileButton
                                    repoPath={report.alert?.repoPath}
                                    filePath={file.path}
                                    line={file.line}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {report.similarIncidents &&
                  report.similarIncidents.length > 0 && (
                    <details className="mt-4 rounded-2xl panel-muted p-4">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                        Similar Incidents · {report.similarIncidents.length}
                      </summary>
                      <div className="mt-3 grid gap-2 text-xs text-[var(--ink-muted)]">
                        {report.similarIncidents.map((incident) => (
                          <div
                            key={incident.id}
                            className="rounded-lg border border-dashed border-[var(--border)] p-2"
                          >
                            <p className="text-[0.7rem] text-[var(--ink-muted)]">
                              {formatDate(incident.createdAt)} ·{" "}
                              {incident.service ?? "service?"} ·{" "}
                              {(incident.confidence * 100).toFixed(0)}% match
                            </p>
                            <p className="text-sm text-[var(--ink)]">
                              {incident.summary}
                            </p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

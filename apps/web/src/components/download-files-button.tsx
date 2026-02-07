"use client";

import { useState, useTransition } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type RunInputs = {
  runId: string;
  runDir: string;
  prompt: string | null;
  alertContext: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  previousReport: string | null;
  files: Array<{ name: string; size: number }>;
  error?: string;
};

type TabId = "prompt" | "alert" | "evidence" | "previous";

export function DownloadFilesButton({ runId }: { runId: string }) {
  const [isPending, startTransition] = useTransition();
  const [data, setData] = useState<RunInputs | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("prompt");
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/reports/${runId}/inputs`);
        const json = await res.json();
        if (!res.ok || json.error) {
          setError(json.error ?? "Failed to fetch run inputs.");
          return;
        }
        setData(json);
        setShowModal(true);
        // Default to prompt tab, or alert if no prompt
        setActiveTab(json.prompt ? "prompt" : "alert");
      } catch {
        setError("Failed to fetch run inputs.");
      }
    });
  };

  const tabs: Array<{ id: TabId; label: string; available: boolean }> = [
    { id: "prompt", label: "Prompt", available: !!data?.prompt },
    { id: "alert", label: "Alert Context", available: !!data?.alertContext },
    { id: "evidence", label: "Evidence", available: !!data?.evidence },
    {
      id: "previous",
      label: "Previous Report",
      available: !!data?.previousReport,
    },
  ];

  const availableTabs = tabs.filter((t) => t.available);

  const renderTabContent = () => {
    if (!data) return null;

    switch (activeTab) {
      case "prompt":
        return (
          <pre className="whitespace-pre-wrap text-xs text-[var(--ink)] leading-relaxed">
            {data.prompt}
          </pre>
        );
      case "alert":
        return (
          <pre className="whitespace-pre-wrap text-xs text-[var(--ink)] leading-relaxed">
            {JSON.stringify(data.alertContext, null, 2)}
          </pre>
        );
      case "evidence": {
        const evidence = data.evidence as Record<string, unknown> | null;
        if (!evidence) return null;

        // Show a structured view of evidence
        const steps = (evidence.steps as Array<Record<string, unknown>>) ?? [];
        const artifacts = (evidence.artifacts as Record<string, string>) ?? {};
        const artifactKeys = Object.keys(artifacts);

        return (
          <div className="space-y-4">
            {/* Evidence steps summary */}
            {steps.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--ink-muted)] mb-2">
                  Evidence Steps ({steps.length})
                </h4>
                <div className="space-y-1">
                  {steps.map((step, idx) => (
                    <div
                      key={`${String(step.id)}-${idx}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          step.status === "ok"
                            ? "bg-green-500"
                            : step.status === "error"
                              ? "bg-red-500"
                              : "bg-gray-400"
                        }`}
                      />
                      <span className="text-[var(--ink)] font-medium">
                        {String(step.title)}
                      </span>
                      {step.summary ? (
                        <span className="text-[var(--ink-muted)] truncate">
                          {String(step.summary)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Artifact sections */}
            {artifactKeys.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--ink-muted)] mb-2">
                  Artifacts ({artifactKeys.length})
                </h4>
                <div className="space-y-3">
                  {artifactKeys.map((key) => (
                    <details key={key} className="group">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--ink)] hover:text-[var(--accent)] flex items-center gap-1">
                        <span className="text-[var(--ink-muted)] group-open:rotate-90 transition-transform inline-block">
                          &#9654;
                        </span>
                        {key}
                        <span className="text-[var(--ink-muted)] text-[0.6rem] ml-1">
                          ({artifacts[key].length.toLocaleString()} chars)
                        </span>
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap text-[0.65rem] text-[var(--ink)] leading-relaxed code-block rounded-lg p-3 max-h-[24rem] overflow-auto">
                        {artifacts[key]}
                      </pre>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* Full JSON fallback */}
            <details>
              <summary className="cursor-pointer text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]">
                Raw JSON
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-[0.6rem] text-[var(--ink)] code-block rounded-lg p-3 max-h-[24rem] overflow-auto">
                {JSON.stringify(evidence, null, 2)}
              </pre>
            </details>
          </div>
        );
      }
      case "previous":
        return (
          <pre className="whitespace-pre-wrap text-xs text-[var(--ink)] leading-relaxed">
            {data.previousReport}
          </pre>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className="rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
        data-testid={`download-files-${runId}`}
        title="View prompt and input files sent to the model"
      >
        {isPending ? "Loading" : "View Inputs"}
      </button>
      {error && (
        <span className="text-[0.65rem] text-[var(--ink-muted)]">{error}</span>
      )}
      {showModal && data && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="w-full max-w-5xl max-h-[85vh] flex flex-col rounded-2xl bg-[var(--surface)] border border-[var(--border)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                  Model Inputs
                </h2>
                <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                  Prompt and context files sent to the triage model
                </p>
              </div>
              <button
                className="text-sm text-[var(--ink-muted)] hover:text-[var(--ink)] px-2 py-1"
                onClick={() => setShowModal(false)}
              >
                Close
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-[var(--border)] px-6">
              {availableTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`px-4 py-2.5 text-xs font-medium tracking-wide transition-colors relative ${
                    activeTab === tab.id
                      ? "text-[var(--accent)]"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent)]" />
                  )}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6">{renderTabContent()}</div>

            {/* Footer with file listing */}
            {data.files.length > 0 && (
              <div className="border-t border-[var(--border)] px-6 py-3">
                <p className="text-[0.6rem] uppercase tracking-[0.15em] text-[var(--ink-muted)]">
                  Files in run directory:{" "}
                  {data.files.map((f) => f.name).join(", ")}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

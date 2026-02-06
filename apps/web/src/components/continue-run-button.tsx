"use client";

import { useState, useTransition } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function ContinueRunButton({ runId }: { runId: string }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/triage/continue/${runId}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(data.error ?? "Failed to continue run.");
          return;
        }
        if (data.queued) {
          setMessage("Queued. Check Latest Reports in a moment.");
        } else if (data.sessionUrl) {
          window.open(data.sessionUrl, "_blank", "noopener,noreferrer");
          setMessage("Opened session.");
        } else {
          setMessage("Run triggered.");
        }
      } catch {
        setMessage("Failed to continue run.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className="rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
        data-testid={`continue-run-${runId}`}
        title="Continue using the previous report (no new evidence)."
      >
        {isPending ? "Continuing" : "Follow-up"}
      </button>
      {message && <span className="text-[0.65rem] text-[var(--ink-muted)]">{message}</span>}
    </div>
  );
}

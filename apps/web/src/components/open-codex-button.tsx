"use client";

import { useState, useTransition } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function OpenCodexButton({ runId }: { runId: string }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/triage/open-codex/${runId}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(data.error ?? "Failed to open Codex session.");
          return;
        }
        if (data.command) {
          setMessage("Opened Codex session (or command ready).");
        } else {
          setMessage("Opened Codex session.");
        }
      } catch {
        setMessage("Failed to open Codex session.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className="rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
        data-testid={`open-codex-${runId}`}
      >
        {isPending ? "Opening" : "Open Codex"}
      </button>
      {message && <span className="text-[0.65rem] text-[var(--ink-muted)]">{message}</span>}
    </div>
  );
}

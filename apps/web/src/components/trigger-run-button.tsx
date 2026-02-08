"use client";

import { useState, useTransition } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

export function TriggerRunButton() {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/triage/run`, { method: "POST" });
        if (!res.ok) {
          setMessage("Failed to trigger run.");
          return;
        }
        const data = await res.json();
        if (data.queued) {
          setMessage("Queued. Check Latest Reports in a moment.");
        } else if (data.reason === "already_running") {
          setMessage("A triage run is already in progress.");
        } else if (data.reason === "disabled") {
          setMessage("Triage is disabled.");
        } else {
          setMessage("Triggered.");
        }
      } catch {
        setMessage("Failed to trigger run.");
      }
    });
  };

  const handleReprocessLastError = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/triage/reprocess-last-error`, {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(data.error ?? "Failed to reprocess last error.");
          return;
        }
        setMessage("Queued reprocess. Check Latest Reports in a moment.");
      } catch {
        setMessage("Failed to reprocess last error.");
      }
    });
  };

  const handleForceClearRunning = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/triage/clear-running`, {
          method: "POST",
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(
            data.error ?? data.message ?? "Failed to clear running runs.",
          );
          return;
        }
        if (data.cleared > 0) {
          setMessage(`Cleared ${data.cleared} running run(s).`);
        } else {
          setMessage(data.message ?? "No running runs to clear.");
        }
      } catch {
        setMessage("Failed to clear running runs.");
      }
    });
  };

  return (
    <div className="relative flex flex-col items-end gap-2">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
            onClick={handleClick}
            disabled={isPending}
            data-testid="trigger-run"
          >
            {isPending ? "Running..." : "Trigger Run"}
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[220px] rounded-2xl border border-[var(--border)] bg-[var(--paper)] p-2 shadow-lg">
            <ContextMenu.Item
              className="cursor-pointer rounded-xl px-3 py-2 text-left text-xs uppercase tracking-[0.2em] text-[var(--ink)] outline-none transition hover:bg-[var(--surface)] data-[highlighted]:bg-[var(--surface)]"
              onSelect={handleReprocessLastError}
            >
              Reprocess last error
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
            <ContextMenu.Item
              className="cursor-pointer rounded-xl px-3 py-2 text-left text-xs uppercase tracking-[0.2em] text-[var(--accent)] outline-none transition hover:bg-[var(--surface)] data-[highlighted]:bg-[var(--surface)]"
              onSelect={handleForceClearRunning}
            >
              Force clear running
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {message && (
        <span className="text-xs text-[var(--ink-muted)]">{message}</span>
      )}
    </div>
  );
}

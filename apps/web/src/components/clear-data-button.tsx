"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

export function ClearDataButton() {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isMounted] = useState(() => typeof window !== "undefined");
  const router = useRouter();

  const handleClick = () => {
    setMessage(null);
    setConfirmOpen(true);
  };

  const handleConfirm = () => {
    setConfirmOpen(false);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/reports/clear`, { method: "POST" });
        if (!res.ok) {
          setMessage("Failed to clear local data.");
          return;
        }
        setMessage("Cleared local data.");
        router.refresh();
      } catch {
        setMessage("Failed to clear local data.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
        data-testid="clear-data"
      >
        {isPending ? "Clearing..." : "Clear Data"}
      </button>
      {confirmOpen && isMounted
        ? createPortal(
            <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
              <div className="glass w-full max-w-md rounded-2xl p-5 shadow-xl">
                <h3 className="text-lg font-semibold text-[var(--ink)]">
                  Clear Local Data
                </h3>
                <p className="mt-2 text-sm text-[var(--ink-muted)]">
                  Clear all local triage runs and alerts? This cannot be undone.
                </p>
                <div className="mt-4 flex items-center justify-end gap-3">
                  <button
                    className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink)]"
                    onClick={() => setConfirmOpen(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-white transition hover:opacity-90"
                    onClick={handleConfirm}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {message && (
        <span className="text-xs text-[var(--ink-muted)]">{message}</span>
      )}
    </div>
  );
}

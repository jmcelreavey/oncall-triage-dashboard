"use client";

import { useState, useTransition } from "react";
import { API_URL } from "@/lib/api";

export function OpenFileButton({
  repoPath,
  filePath,
  line,
}: {
  repoPath?: string;
  filePath: string;
  line?: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/reports/open-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoPath, path: filePath, line }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(data.error ?? "Failed to open file.");
          return;
        }
        setMessage("Opened in editor.");
      } catch {
        setMessage("Failed to open file.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className="rounded-full border border-[var(--border)] px-2 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending ? "Opening" : "Open File"}
      </button>
      {message && (
        <span className="text-[0.6rem] text-[var(--ink-muted)]">{message}</span>
      )}
    </div>
  );
}

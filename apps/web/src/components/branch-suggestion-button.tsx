"use client";

import { useState, useTransition } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

type Suggestion = {
  branchName: string;
  repoPath?: string;
  files?: string[];
  commands?: string[];
  error?: string;
};

export function BranchSuggestionButton({ runId }: { runId: string }) {
  const [isPending, startTransition] = useTransition();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const handleClick = () => {
    startTransition(async () => {
      const res = await fetch(`${API_URL}/triage/suggest-branch/${runId}`, { method: "POST" });
      const data = await res.json();
      setSuggestion(data);
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        className="rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-3)] hover:text-[var(--accent-3)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
        data-testid={`suggest-branch-${runId}`}
      >
        {isPending ? "Suggesting" : "Suggest Branch"}
      </button>
      {suggestion?.error && (
        <span className="text-[0.65rem] text-[var(--accent)]">{suggestion.error}</span>
      )}
      {suggestion && !suggestion.error && (
        <div className="panel rounded-xl p-3 text-[0.7rem]">
          <p className="font-semibold text-[var(--ink)]">{suggestion.branchName}</p>
          {suggestion.commands && (
            <pre className="mt-2 whitespace-pre-wrap text-[0.65rem] text-[var(--ink-muted)]">
{suggestion.commands.join("\n")}
            </pre>
          )}
          {suggestion.files && suggestion.files.length > 0 && (
            <p className="mt-2 text-[0.65rem] text-[var(--ink-muted)]">
              Files: {suggestion.files.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function IntegrationTestButton({ name }: { name: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const router = useRouter();

  const handleClick = () => {
    setResult(null);
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/integrations/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setResult({ ok: false, message: data.error ?? "Test failed." });
          return;
        }
        setResult({ ok: Boolean(data.ok), message: data.message ?? "Test complete." });
        router.refresh();
      } catch {
        setResult({ ok: false, message: "Test failed." });
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className="rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending ? "Testing" : "Test"}
      </button>
      {result && (
        <span className={`text-[0.6rem] ${result.ok ? "text-[var(--accent-3)]" : "text-[var(--accent)]"}`}>
          {result.message}
        </span>
      )}
    </div>
  );
}

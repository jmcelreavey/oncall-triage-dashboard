"use client";

import { useState } from "react";

type CopyButtonProps = {
  text: string;
  label: string;
  className?: string;
};

export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      className={
        className ??
        "rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
      }
      onClick={handleCopy}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

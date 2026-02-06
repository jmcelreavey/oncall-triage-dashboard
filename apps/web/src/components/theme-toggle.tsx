"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "triage-theme";

function resolveTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === "light" || stored === "dark") return stored;
  const prefersDark = window.matchMedia?.(
    "(prefers-color-scheme: dark)",
  )?.matches;
  return prefersDark ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  // Start with light theme to match SSR
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const doInit = () => {
      setMounted(true);
      const resolved = resolveTheme();
      setTheme(resolved);
      applyTheme(resolved);
    };
    // Defer state updates to avoid rendering in effect body
    const timeout = setTimeout(doInit, 0);
    return () => clearTimeout(timeout);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  // Don't render until mounted to avoid hydration mismatch
  if (!mounted) {
    return (
      <button
        className={`inline-flex items-center justify-between rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] ${className ?? ""}`}
        disabled
        type="button"
      >
        Dark Mode
      </button>
    );
  }

  return (
    <button
      className={`inline-flex items-center justify-between rounded-full border border-[var(--border)] px-3 py-2 text-xs uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] ${className ?? ""}`}
      onClick={toggle}
      aria-pressed={theme === "dark"}
      type="button"
    >
      {theme === "dark" ? "Light Mode" : "Dark Mode"}
    </button>
  );
}

"use client";

import { CopyButton } from "@/components/copy-button";

type IntegrationName = "datadog" | "github" | "confluence" | "opencode";

const prompts: Record<IntegrationName, string> = {
  datadog:
    "Help me set up Datadog for oncall-triage-dashboard. I need DATADOG_API_KEY, DATADOG_APP_KEY, and DATADOG_SITE. Please walk me through creating them and where to paste them in the Configure screen.",
  github:
    "Help me set up GitHub access for oncall-triage-dashboard. I can use gh CLI or a GITHUB_TOKEN. Please walk me through the simplest way and where to paste it in the Configure screen.",
  confluence:
    "Help me set up Confluence access for oncall-triage-dashboard. I need CONFLUENCE_BASE_URL, CONFLUENCE_USER, and CONFLUENCE_TOKEN. Please walk me through generating a token and where to paste it in the Configure screen.",
  opencode:
    "Help me set up OpenCode for oncall-triage-dashboard. I need OPENCODE_BIN and OPENCODE_WEB_URL. Please walk me through checking that opencode is installed and where to paste the values.",
};

export function IntegrationHelp({
  name,
  showConfigureButton = true,
}: {
  name: IntegrationName;
  showConfigureButton?: boolean;
}) {
  const prompt = prompts[name] ?? prompts.confluence;

  const handleConfigure = () => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("open-connection-wizard"));
  };
  const openCodeUrl =
    process.env.NEXT_PUBLIC_OPENCODE_WEB_URL || "http://127.0.0.1:4096";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <CopyButton
        text={prompt}
        label="Copy Setup Prompt"
        className="rounded-full border border-[var(--border)] px-3 py-2 text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)]"
      />
      <a
        className="rounded-full border border-[var(--border)] px-3 py-2 text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)]"
        href={openCodeUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open OpenCode
      </a>
      {showConfigureButton && (
        <button
          className="rounded-full border border-[var(--border)] px-3 py-2 text-[0.7rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={handleConfigure}
          type="button"
        >
          Open Configure
        </button>
      )}
    </div>
  );
}

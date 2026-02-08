"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { IntegrationHelp } from "@/components/integration-help";
import { IntegrationTestButton } from "@/components/integration-test-button";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

export function ConnectionWizard({
  statusLabel,
  statusTone = "muted",
  className,
}: {
  statusLabel?: string;
  statusTone?: "ok" | "warn" | "muted";
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [datadogTest, setDatadogTest] = useState<{
    ok: boolean | null;
    message?: string;
  } | null>(null);
  const [confluenceTest, setConfluenceTest] = useState<{
    ok: boolean | null;
    message?: string;
  } | null>(null);
  const [githubTest, setGithubTest] = useState<{
    ok: boolean | null;
    message?: string;
  } | null>(null);
  const [isTestingDatadog, setIsTestingDatadog] = useState(false);
  const [isTestingConfluence, setIsTestingConfluence] = useState(false);
  const [isTestingGithub, setIsTestingGithub] = useState(false);
  const router = useRouter();

  const [form, setForm] = useState({
    datadogApiKey: "",
    datadogAppKey: "",
    datadogSite: "datadoghq.com",
    alertTeam: "",
    githubToken: "",
    confluenceBaseUrl: "",
    confluenceUser: "",
    confluenceToken: "",
    provider: "opencode",
  });

  const update = (key: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (!isOpen) return;
    setIsLoadingConfig(true);
    fetch(`${API_URL}/integrations/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setForm((prev) => ({
            ...prev,
            datadogApiKey: data.datadogApiKey ?? prev.datadogApiKey,
            datadogAppKey: data.datadogAppKey ?? prev.datadogAppKey,
            datadogSite: data.datadogSite ?? prev.datadogSite,
            alertTeam: data.alertTeam ?? prev.alertTeam,
            githubToken: data.githubToken ?? prev.githubToken,
            confluenceBaseUrl: data.confluenceBaseUrl ?? prev.confluenceBaseUrl,
            confluenceUser: data.confluenceUser ?? prev.confluenceUser,
            confluenceToken: data.confluenceToken ?? prev.confluenceToken,
            provider: data.provider ?? prev.provider,
          }));
        } else {
          setMessage("Failed to load current configuration.");
        }
      })
      .catch(() => setMessage("Failed to load current configuration."))
      .finally(() => setIsLoadingConfig(false));
  }, [isOpen]);

  useEffect(() => {
    const handleOpen = () => setIsOpen(true);
    if (typeof window !== "undefined") {
      window.addEventListener("open-connection-wizard", handleOpen);
      return () =>
        window.removeEventListener("open-connection-wizard", handleOpen);
    }
  }, []);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleSave = () => {
    setMessage(null);
    const payload: Record<string, string | boolean> = {
      datadogApiKey: form.datadogApiKey,
      datadogAppKey: form.datadogAppKey,
      datadogSite: form.datadogSite,
      alertTeam: form.alertTeam,
      confluenceBaseUrl: form.confluenceBaseUrl,
      confluenceUser: form.confluenceUser,
      confluenceToken: form.confluenceToken,
      provider: form.provider,
    };
    if (form.githubToken.trim()) {
      payload.githubToken = form.githubToken.trim();
    }
    startTransition(async () => {
      try {
        const res = await fetch(`${API_URL}/integrations/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMessage(data.error ?? "Failed to save configuration.");
          return;
        }
        setMessage("Saved. Configuration is now active.");
        router.refresh();
      } catch {
        setMessage("Failed to save configuration.");
      }
    });
  };

  const runTest = async (name: "datadog" | "confluence" | "github") => {
    const setPending =
      name === "datadog"
        ? setIsTestingDatadog
        : name === "confluence"
          ? setIsTestingConfluence
          : setIsTestingGithub;
    const setResult =
      name === "datadog"
        ? setDatadogTest
        : name === "confluence"
          ? setConfluenceTest
          : setGithubTest;
    setPending(true);
    try {
      const overrides =
        name === "datadog"
          ? {
              DATADOG_API_KEY: form.datadogApiKey,
              DATADOG_APP_KEY: form.datadogAppKey,
              DATADOG_SITE: form.datadogSite,
            }
          : name === "confluence"
            ? {
                ATLASSIAN_BASE_URL: form.confluenceBaseUrl,
                ATLASSIAN_USER: form.confluenceUser,
                ATLASSIAN_TOKEN: form.confluenceToken,
              }
            : {
                GITHUB_TOKEN: form.githubToken,
              };
      const res = await fetch(`${API_URL}/integrations/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, overrides }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setResult({ ok: false, message: data.error ?? "Test failed." });
      } else {
        setResult({
          ok: Boolean(data.ok),
          message: data.message ?? "Test complete.",
        });
      }
    } catch {
      setResult({ ok: false, message: "Test failed." });
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <button
        className={`flex items-center justify-between gap-2 rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] ${className ?? ""}`}
        onClick={() => setIsOpen(true)}
        data-testid="open-connection-wizard"
      >
        <span>Configure</span>
        {statusLabel && (
          <span
            className={`chip px-2 py-1 text-[0.6rem] uppercase tracking-[0.2em] ${
              statusTone === "ok"
                ? "border-[var(--accent-3)] text-[var(--accent-3)]"
                : statusTone === "warn"
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--ink-muted)]"
            }`}
          >
            {statusLabel}
          </span>
        )}
      </button>

      {isOpen && isMounted
        ? createPortal(
            <div
              className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/40 p-6 backdrop-blur-sm overflow-y-auto"
              data-testid="connection-wizard-modal"
            >
              <div className="glass w-full max-w-2xl rounded-3xl p-6 shadow-xl my-8">
                {/* Header */}
                <div className="mb-6">
                  <h3 className="text-2xl font-semibold text-[var(--ink)]">
                    Connection Wizard
                  </h3>
                  <p className="text-sm text-[var(--ink-muted)]">
                    Save keys locally in `.env` and test your integrations.
                  </p>
                  {isLoadingConfig && (
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      Loading current configuration…
                    </p>
                  )}
                </div>

                {/* Sections stacked vertically */}
                <div className="space-y-6">
                  {/* Datadog */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      Datadog
                    </h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="API Key"
                        value={form.datadogApiKey}
                        onChange={(e) =>
                          update("datadogApiKey", e.target.value)
                        }
                      />
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="App Key"
                        value={form.datadogAppKey}
                        onChange={(e) =>
                          update("datadogAppKey", e.target.value)
                        }
                      />
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="Site (datadoghq.com)"
                        value={form.datadogSite}
                        onChange={(e) => update("datadogSite", e.target.value)}
                      />
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="Team tag (e.g. dad)"
                        value={form.alertTeam}
                        onChange={(e) => update("alertTeam", e.target.value)}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[0.7rem] text-[var(--ink-muted)]">
                        Filters monitors to{" "}
                        <span className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[0.65rem] text-[var(--ink)]">
                          team:{form.alertTeam || "your-team"}
                        </span>
                      </p>
                      <button
                        className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
                        onClick={() => runTest("datadog")}
                        disabled={isTestingDatadog}
                        type="button"
                      >
                        {isTestingDatadog ? "Testing..." : "Test"}
                      </button>
                    </div>
                    {datadogTest && (
                      <p
                        className={`text-xs ${datadogTest.ok ? "text-[var(--accent-3)]" : "text-[var(--accent)]"}`}
                      >
                        {datadogTest.message ??
                          (datadogTest.ok ? "Connected" : "Test failed")}
                      </p>
                    )}
                    {datadogTest?.ok === false && (
                      <IntegrationHelp
                        name="datadog"
                        showConfigureButton={false}
                      />
                    )}
                  </div>

                  <hr className="border-[var(--border)]" />

                  {/* Atlassian */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                      Atlassian (Confluence & JIRA)
                    </h4>
                    <input
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                      placeholder="https://yourcompany.atlassian.net"
                      value={form.confluenceBaseUrl}
                      onChange={(e) =>
                        update("confluenceBaseUrl", e.target.value)
                      }
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="Email address"
                        value={form.confluenceUser}
                        onChange={(e) =>
                          update("confluenceUser", e.target.value)
                        }
                      />
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="API Token"
                        type="password"
                        value={form.confluenceToken}
                        onChange={(e) =>
                          update("confluenceToken", e.target.value)
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[0.7rem] text-[var(--ink-muted)]">
                        Generate token at{" "}
                        <a
                          href="https://id.atlassian.com/manage-profile/security/api-tokens"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent-2)] hover:underline"
                        >
                          id.atlassian.com
                        </a>
                      </p>
                      <button
                        className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
                        onClick={() => runTest("confluence")}
                        disabled={isTestingConfluence}
                        type="button"
                      >
                        {isTestingConfluence ? "Testing..." : "Test"}
                      </button>
                    </div>
                    {confluenceTest && (
                      <p
                        className={`text-xs ${confluenceTest.ok ? "text-[var(--accent-3)]" : "text-[var(--accent)]"}`}
                      >
                        {confluenceTest.message ??
                          (confluenceTest.ok ? "Connected" : "Test failed")}
                      </p>
                    )}
                    {confluenceTest?.ok === false && (
                      <IntegrationHelp
                        name="confluence"
                        showConfigureButton={false}
                      />
                    )}
                  </div>

                  <hr className="border-[var(--border)]" />

                  {/* Provider & GitHub side by side */}
                  <div className="grid gap-6 sm:grid-cols-2">
                    {/* Provider */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                        Provider
                      </h4>
                      <select
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        value={form.provider}
                        onChange={(e) => update("provider", e.target.value)}
                      >
                        <option value="opencode">OpenCode</option>
                        <option value="codex">Codex</option>
                      </select>
                      <div className="flex items-center justify-between">
                        <p className="text-[0.7rem] text-[var(--ink-muted)]">
                          Auto-detected from PATH
                        </p>
                        <IntegrationTestButton name={form.provider} />
                      </div>
                    </div>

                    {/* GitHub */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--ink-muted)]">
                        GitHub
                      </h4>
                      <input
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)]"
                        placeholder="Token (optional if using gh auth)"
                        value={form.githubToken}
                        onChange={(e) => update("githubToken", e.target.value)}
                      />
                      <div className="flex items-center justify-between">
                        <p className="text-[0.7rem] text-[var(--ink-muted)]">
                          Uses `gh auth` if no token
                        </p>
                        <button
                          className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[0.65rem] uppercase tracking-[0.2em] text-[var(--ink)] transition hover:border-[var(--accent-2)] hover:text-[var(--accent-2)] disabled:opacity-50"
                          onClick={() => runTest("github")}
                          disabled={isTestingGithub}
                          type="button"
                        >
                          {isTestingGithub ? "Testing..." : "Test"}
                        </button>
                      </div>
                      {githubTest && (
                        <p
                          className={`text-xs ${githubTest.ok ? "text-[var(--accent-3)]" : "text-[var(--accent)]"}`}
                        >
                          {githubTest.message ??
                            (githubTest.ok ? "Connected" : "Test failed")}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="mt-6 flex items-center justify-between border-t border-[var(--border)] pt-4">
                  <span className="text-xs text-[var(--ink-muted)]">
                    {message}
                  </span>
                  <div className="flex gap-3">
                    <button
                      className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--ink)]"
                      onClick={() => setIsOpen(false)}
                      data-testid="connection-wizard-cancel"
                    >
                      Cancel
                    </button>
                    <button
                      className="rounded-full bg-[var(--brand)] px-4 py-2 text-sm text-white transition hover:bg-[var(--brand-strong)] disabled:opacity-50"
                      onClick={handleSave}
                      disabled={isPending}
                      data-testid="connection-wizard-save"
                    >
                      {isPending ? "Saving" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureTriageServiceInitialized } =
      await import("./services/triage-manager");
    await ensureTriageServiceInitialized();
  }
}

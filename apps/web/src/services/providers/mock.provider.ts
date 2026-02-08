import { ProviderResult, TriageProvider } from "@/triage/types";

export class MockProvider implements TriageProvider {
  run(): Promise<ProviderResult> {
    return Promise.resolve({
      reportMarkdown:
        "Mock triage report. Configure OpenCode or Codex to get a real analysis. No actions were performed.",
    });
  }
}

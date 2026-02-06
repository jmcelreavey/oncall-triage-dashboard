import { ProviderResult, TriageProvider } from '../types';

export class MockProvider implements TriageProvider {
  async run(): Promise<ProviderResult> {
    return {
      reportMarkdown:
        'Mock triage report. Configure OpenCode or Codex to get a real analysis. No actions were performed.',
    };
  }
}

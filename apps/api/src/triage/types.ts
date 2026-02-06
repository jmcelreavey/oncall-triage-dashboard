export interface AlertContext {
  monitorId?: string;
  monitorName?: string;
  monitorState?: string;
  priority?: number | null;
  monitorUrl?: string;
  monitorMessage?: string;
  monitorQuery?: string;
  monitorTags?: string[];
  overallStateModified?: string;
  service?: string;
  environment?: string;
  sourceRepo?: string;
  repoHint?: string;
  repoUrl?: string;
  repoPath?: string;
  githubEnrichment?: any;
  confluenceEnrichment?: any;
}

export interface ProviderResult {
  reportMarkdown: string;
  sessionId?: string;
  sessionUrl?: string;
  rawOutput?: string;
}

export interface TriageProvider {
  run(params: {
    runId: string;
    prompt: string;
    alertContext: AlertContext;
    attachments: string[];
    workingDir: string;
  }): Promise<ProviderResult>;
}

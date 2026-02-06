import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import axios from 'axios';
import { AlertContext } from './types';

type EvidenceStatus = 'ok' | 'skipped' | 'error';

export type EvidenceStep = {
  id: string;
  title: string;
  status: EvidenceStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  artifacts?: string[];
};

export type RepoFileHit = {
  path: string;
  line: number;
  text: string;
};

export type FixSuggestion = {
  title: string;
  summary: string;
  confidence: number;
  files: RepoFileHit[];
  diff?: string;
};

export type SimilarIncident = {
  id: string;
  createdAt: string;
  summary: string;
  confidence: number;
  service?: string;
  monitorName?: string;
};

export type EvidenceBundle = {
  steps: EvidenceStep[];
  artifacts: Record<string, string>;
  repoFiles: RepoFileHit[];
  fixSuggestions: FixSuggestion[];
  similarIncidents: SimilarIncident[];
  evidenceMap: {
    steps: Array<{
      id: string;
      title: string;
      status: EvidenceStatus;
      summary?: string;
      artifacts?: string[];
    }>;
    topRepoFindings: RepoFileHit[];
    fixSuggestions: FixSuggestion[];
  };
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

type Recommendation = {
  summary: string;
  defaultMinReplicas?: number;
};

type HeuristicConfig = {
  version: number;
  defaults?: {
    scanCommits?: number;
    repoPatterns?: Array<{ name: string; rg: string; glob?: string }>;
  };
  services?: Record<
    string,
    {
      knownPatterns?: Array<{
        id: string;
        description: string;
        trigger: {
          monitorNameContains?: string[];
          repoSearch?: { rg: string; glob?: string };
        };
        recommendation: Recommendation;
      }>;
    }
  >;
  global?: Array<{
    id: string;
    description: string;
    trigger: {
      monitorNameContains?: string[];
      repoSearch?: { rg: string; glob?: string };
    };
    recommendation: Recommendation;
  }>;
};

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_OUTPUT = 12_000;

// Exported for unit tests and reuse across evidence steps.
export function truncate(value: string, max = MAX_OUTPUT) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 2_000_000,
      env: process.env,
    });
    return { stdout, stderr, exitCode: 0, timedOut: false };
  } catch (error: unknown) {
    const err = error as Partial<{
      stdout: string;
      stderr: string;
      message: string;
      code: number;
      killed: boolean;
    }>;
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      exitCode: typeof err.code === 'number' ? err.code : null,
      timedOut: Boolean(err.killed),
    };
  }
}

export function safeJsonParse(value: string, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function hasCommand(command: string) {
  const result = await runCommand('which', [command]);
  return result.exitCode === 0;
}

export function parseRgMatches(
  output: string,
  repoPath?: string,
): RepoFileHit[] {
  const hits: RepoFileHit[] = [];
  const lines = output.split('\n').filter(Boolean);
  for (const line of lines) {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first === -1 || second === -1) continue;
    const file = line.slice(0, first);
    const lineStr = line.slice(first + 1, second);
    const text = line.slice(second + 1).trim();
    const lineNum = Number(lineStr);
    if (!Number.isFinite(lineNum)) continue;
    const relative = repoPath ? path.relative(repoPath, file) : file;
    hits.push({ path: relative, line: lineNum, text });
  }
  return hits;
}

export function extractLogsQuery(query?: string) {
  if (!query) return undefined;
  const match = query.match(/logs\("([\s\S]+?)"\)/);
  if (match) return match[1];
  return query;
}

export function extractRunbookLinks(message?: string) {
  if (!message) return [];
  const regex = /(https?:\/\/[^\s)]+)/g;
  const matches = message.match(regex) ?? [];
  return matches.filter((link) => link.toLowerCase().includes('runbook'));
}

function loadHeuristics(repoRoot: string): HeuristicConfig | null {
  const heuristicPath = path.join(
    repoRoot,
    'apps',
    'api',
    'config',
    'heuristics.yaml',
  );
  if (!existsSync(heuristicPath)) return null;
  const raw = readFileSync(heuristicPath, 'utf-8');
  // Lazy import to keep dependencies light if unused.
  const yaml = require('yaml') as { parse: (value: string) => unknown };
  const parsed = yaml.parse(raw);
  return parsed as HeuristicConfig;
}

function normalizeService(value?: string) {
  return value?.trim().toLowerCase() ?? '';
}

export async function gatherEvidence(params: {
  alert: AlertContext;
  repoRoot: string;
  repoPath?: string;
  runId: string;
  datadogSite: string;
  datadogKeys?: { apiKey?: string; appKey?: string };
  confluence?: { baseUrl?: string; user?: string; token?: string };
  jira?: { baseUrl?: string; user?: string; token?: string };
  findSimilar: () => Promise<SimilarIncident[]>;
  scanCommits?: number;
  getRepoMapping?: (
    monitorId: string,
    monitorName: string,
    service?: string,
  ) => Promise<string | null>;
}): Promise<EvidenceBundle> {
  const steps: EvidenceStep[] = [];
  const artifacts: Record<string, string> = {};
  const repoFiles: RepoFileHit[] = [];
  const fixSuggestions: FixSuggestion[] = [];
  const recentConfigFiles: string[] = [];

  const recordStep = (step: EvidenceStep) => {
    steps.push(step);
    return step;
  };

  const updateStep = (step: EvidenceStep, patch: Partial<EvidenceStep>) => {
    Object.assign(step, patch);
  };

  const runStep = async (
    id: string,
    title: string,
    fn: () => Promise<{
      artifactKey?: string;
      summary?: string;
      output?: string;
      files?: RepoFileHit[];
    }>,
  ) => {
    const step = recordStep({
      id,
      title,
      status: 'skipped',
      startedAt: new Date().toISOString(),
    });
    const stepStartTime = Date.now();
    console.log(`[${params.runId}] Evidence step starting: ${id} - ${title}`);

    try {
      const result = await fn();
      const duration = ((Date.now() - stepStartTime) / 1000).toFixed(1);

      if (result.output && result.artifactKey) {
        artifacts[result.artifactKey] = truncate(result.output);
      }
      if (result.files && result.files.length > 0) {
        repoFiles.push(...result.files);
      }
      updateStep(step, {
        status: 'ok',
        finishedAt: new Date().toISOString(),
        summary: result.summary,
        artifacts: result.artifactKey ? [result.artifactKey] : undefined,
      });

      console.log(
        `[${params.runId}] Evidence step completed: ${id} in ${duration}s - ${result.summary || 'ok'}`,
      );
    } catch (error: unknown) {
      const duration = ((Date.now() - stepStartTime) / 1000).toFixed(1);
      const errMsg = errorMessage(error);

      updateStep(step, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        summary: errMsg,
      });

      console.log(
        `[${params.runId}] Evidence step failed: ${id} after ${duration}s - ${errMsg}`,
      );
    }
  };

  const service = normalizeService(params.alert.service);
  const monitorName = params.alert.monitorName ?? '';

  let repoPath =
    params.repoPath && existsSync(params.repoPath)
      ? params.repoPath
      : undefined;

  if (!repoPath && params.getRepoMapping) {
    try {
      const mappedRepo = await params.getRepoMapping(
        params.alert.monitorId ?? '',
        monitorName,
        params.alert.service,
      );
      if (mappedRepo && existsSync(mappedRepo)) {
        repoPath = mappedRepo;
      }
    } catch (error) {
      console.log(
        `[${params.runId}] Repo mapping lookup failed: ${errorMessage(error)}`,
      );
    }
  }

  if (!repoPath && params.alert.repoUrl) {
    await runStep('clone-repo', 'Clone repository from GitHub', async () => {
      const repoNameMatch = params.alert.repoUrl?.match(
        /github\.com\/([^/]+)\/([^/]+)/,
      );
      if (!repoNameMatch) {
        return { summary: 'Invalid GitHub URL; cannot clone.' };
      }
      const owner = repoNameMatch[1];
      const repo = repoNameMatch[2];
      const cloneTarget = path.join(params.repoRoot, repo);

      if (existsSync(cloneTarget)) {
        return { summary: `Repo already exists at ${cloneTarget}.` };
      }

      const cloneResult = await runCommand(
        'gh',
        ['repo', 'clone', `${owner}/${repo}`, cloneTarget],
        { timeoutMs: 60000 },
      );
      if (cloneResult.exitCode !== 0) {
        throw new Error(`Git clone failed: ${cloneResult.stderr}`);
      }

      repoPath = cloneTarget;
      return { summary: `Cloned ${owner}/${repo} to ${cloneTarget}.` };
    });
  }

  const scanCommits = params.scanCommits ?? 20;

  await runStep('repo-status', 'Repo status & recent commits', async () => {
    if (!repoPath) {
      const contextInfo = [
        service ? `service: ${service}` : null,
        monitorName ? `monitor: ${monitorName}` : null,
        params.alert.repoUrl ? `repo URL: ${params.alert.repoUrl}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return {
        summary: `Repo path not found; skipping git history. Context: ${contextInfo || 'none'}.`,
      };
    }
    const status = await runCommand('git', ['-C', repoPath, 'status', '-sb']);
    const log = await runCommand('git', [
      '-C',
      repoPath,
      'log',
      `-n`,
      String(scanCommits),
      '--date=short',
      '--pretty=format:%h %ad %s',
      '--name-status',
    ]);
    const output = `# git status\n${status.stdout}\n\n# git log\n${log.stdout}`;
    return {
      artifactKey: 'git_history',
      output,
      summary: `Captured last ${scanCommits} commits.`,
    };
  });

  await runStep(
    'repo-scan',
    'Repo config scan (HPA/PDB/Flux/Helm)',
    async () => {
      if (!repoPath) {
        return { summary: 'Repo path not found; skipping repo scan.' };
      }
      if (!(await hasCommand('rg'))) {
        return { summary: 'ripgrep (rg) not available; skipping repo scan.' };
      }
      const patterns = [
        'kind:\\s*(HorizontalPodAutoscaler|PodDisruptionBudget|Kustomization|HelmRelease|HelmRepository|GitRepository|ImagePolicy|ImageAutomation|ImageRepository)',
        '(minReplicas|maxReplicas|replicas)\\s*:\\s*\\d+',
      ];
      const hits: RepoFileHit[] = [];
      let combined = '';
      for (const pattern of patterns) {
        const res = await runCommand('rg', [
          '-n',
          '--glob',
          '**/*.{yaml,yml}',
          pattern,
          repoPath,
        ]);
        if (res.stdout) {
          combined += `# rg ${pattern}\n${res.stdout}\n\n`;
          hits.push(...parseRgMatches(res.stdout, repoPath));
        }
      }
      return {
        artifactKey: 'repo_scan',
        output: combined,
        files: hits,
        summary: `${hits.length} config hits.`,
      };
    },
  );

  await runStep('repo-diff', 'Recent config diffs', async () => {
    if (!repoPath) {
      return { summary: 'Repo path not found; skipping diff.' };
    }
    const diffList = await runCommand('git', [
      '-C',
      repoPath,
      'diff',
      `HEAD~${scanCommits}..HEAD`,
      '--name-only',
    ]);
    const files = diffList.stdout
      .split('\n')
      .filter((line) => line.match(/\.(ya?ml)$/))
      .filter((line) =>
        line.toLowerCase().match(/hpa|pdb|kustom|flux|helm|deployment|values/),
      )
      .slice(0, 8);
    recentConfigFiles.push(...files);
    if (files.length === 0) {
      return { summary: 'No recent config diffs detected.' };
    }
    let output = '';
    for (const file of files) {
      const diff = await runCommand('git', [
        '-C',
        repoPath,
        'diff',
        `HEAD~${scanCommits}..HEAD`,
        '--',
        file,
      ]);
      output += `# ${file}\n${diff.stdout}\n\n`;
    }
    return {
      artifactKey: 'repo_diff',
      output,
      summary: `Diffed ${files.length} files.`,
    };
  });

  await runStep('github-prs', 'GitHub PR context', async () => {
    if (!repoPath) {
      return { summary: 'Repo path not found; skipping PR context.' };
    }
    if (!(await hasCommand('gh'))) {
      return { summary: 'GitHub CLI not available; skipping PR context.' };
    }
    if (recentConfigFiles.length === 0) {
      return { summary: 'No recent config files to match PRs against.' };
    }
    const remote = await runCommand('git', [
      '-C',
      repoPath,
      'config',
      '--get',
      'remote.origin.url',
    ]);
    const repoMatch = remote.stdout
      .trim()
      .match(/github\.com[:/](.+?)\/(.+?)(\.git)?$/);
    if (!repoMatch) {
      return { summary: 'Unable to parse GitHub repo from git remote.' };
    }
    const owner = repoMatch[1];
    const repo = repoMatch[2];
    const prsResponse = await runCommand('gh', [
      'api',
      `repos/${owner}/${repo}/pulls`,
      '-f',
      'state=closed',
      '-f',
      'per_page=20',
    ]);
    if (prsResponse.exitCode !== 0) {
      return {
        summary: `gh api failed: ${prsResponse.stderr || prsResponse.stdout}`,
      };
    }
    const prs = safeJsonParse(prsResponse.stdout || '[]', []) as Array<{
      number: number;
      title: string;
      merged_at?: string;
      html_url?: string;
    }>;
    const merged = prs.filter((pr) => pr.merged_at);
    const matches: Array<{
      number: number;
      title: string;
      merged_at?: string;
      html_url?: string;
      files: string[];
    }> = [];
    for (const pr of merged.slice(0, 10)) {
      const filesResponse = await runCommand('gh', [
        'api',
        `repos/${owner}/${repo}/pulls/${pr.number}/files`,
        '-f',
        'per_page=100',
      ]);
      if (filesResponse.exitCode !== 0) continue;
      const files = safeJsonParse(filesResponse.stdout || '[]', []) as Array<{
        filename: string;
      }>;
      const matched = files
        .map((file) => file.filename)
        .filter((file) => recentConfigFiles.includes(file));
      if (matched.length > 0) {
        matches.push({
          number: pr.number,
          title: pr.title,
          merged_at: pr.merged_at,
          html_url: pr.html_url,
          files: matched,
        });
      }
      if (matches.length >= 3) break;
    }
    const output = JSON.stringify(matches, null, 2);
    return {
      artifactKey: 'github_prs',
      output,
      summary: `Matched ${matches.length} PRs.`,
    };
  });

  await runStep('k8s-state', 'Kubernetes live state', async () => {
    if (!(await hasCommand('kubectl'))) {
      return { summary: 'kubectl not available; skipping K8s live state.' };
    }
    const serviceToken = service || 'unknown-service';
    const deploys = await runCommand('kubectl', [
      'get',
      'deploy,hpa,pdb',
      '-A',
    ]);
    const pods = await runCommand('kubectl', ['get', 'pods', '-A']);
    const events = await runCommand('kubectl', [
      'get',
      'events',
      '-A',
      '--sort-by=.lastTimestamp',
    ]);
    const output = `# deploy/hpa/pdb (filtered)\n${deploys.stdout}\n\n# pods (filtered)\n${pods.stdout}\n\n# events (tail)\n${events.stdout
      .split('\n')
      .slice(-50)
      .join('\n')}`;
    const filtered = output
      .split('\n')
      .filter((line) => line.toLowerCase().includes(serviceToken))
      .join('\n');
    return {
      artifactKey: 'k8s_state',
      output: filtered || output,
      summary: 'Captured cluster state and recent events.',
    };
  });

  await runStep('k8s-rollout', 'Recent rollout history', async () => {
    if (!(await hasCommand('kubectl'))) {
      return { summary: 'kubectl not available; skipping rollout history.' };
    }
    if (!service) {
      return { summary: 'Service unknown; skipping rollout history.' };
    }
    const list = await runCommand('kubectl', ['get', 'deploy', '-A']);
    const lines = list.stdout
      .split('\n')
      .filter((line) => line.toLowerCase().includes(service));
    const targets = lines
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .slice(0, 3);
    if (targets.length === 0) {
      return { summary: 'No deployments matched service for rollout history.' };
    }
    let output = '';
    for (const [namespace, name] of targets) {
      const history = await runCommand('kubectl', [
        '-n',
        namespace,
        'rollout',
        'history',
        `deploy/${name}`,
      ]);
      output += `# ${namespace}/${name}\n${history.stdout}\n\n`;
    }
    return {
      artifactKey: 'k8s_rollout',
      output,
      summary: `Captured ${targets.length} rollout histories.`,
    };
  });

  await runStep(
    'k8s-graph',
    'K8s workload → HPA → PDB → pods/events graph',
    async () => {
      if (!(await hasCommand('kubectl'))) {
        return { summary: 'kubectl not available; skipping graph.' };
      }
      if (!service) {
        return { summary: 'Service unknown; skipping graph.' };
      }
      const [deploysRes, hpaRes, pdbRes, podsRes, eventsRes] =
        await Promise.all([
          runCommand('kubectl', ['get', 'deploy', '-A', '-o', 'json']),
          runCommand('kubectl', ['get', 'hpa', '-A', '-o', 'json']),
          runCommand('kubectl', ['get', 'pdb', '-A', '-o', 'json']),
          runCommand('kubectl', ['get', 'pods', '-A', '-o', 'json']),
          runCommand('kubectl', ['get', 'events', '-A', '-o', 'json']),
        ]);

      if (
        deploysRes.exitCode !== 0 ||
        hpaRes.exitCode !== 0 ||
        pdbRes.exitCode !== 0 ||
        podsRes.exitCode !== 0 ||
        eventsRes.exitCode !== 0
      ) {
        return { summary: 'kubectl error; skipping graph.' };
      }
      const deploys = safeJsonParse(deploysRes.stdout || '{"items": []}', {
        items: [],
      }).items as any[];
      const hpas = safeJsonParse(hpaRes.stdout || '{"items": []}', {
        items: [],
      }).items as any[];
      const pdbs = safeJsonParse(pdbRes.stdout || '{"items": []}', {
        items: [],
      }).items as any[];
      const pods = safeJsonParse(podsRes.stdout || '{"items": []}', {
        items: [],
      }).items as any[];
      const events = safeJsonParse(eventsRes.stdout || '{"items": []}', {
        items: [],
      }).items as any[];

      const serviceDeploys = deploys
        .filter((d) => d?.metadata?.name?.includes(service))
        .slice(0, 5);
      const lines: string[] = [
        'Workload | HPA | PDB | Pods Ready | Events',
        '--- | --- | --- | --- | ---',
      ];

      for (const deploy of serviceDeploys) {
        const namespace = deploy.metadata.namespace;
        const name = deploy.metadata.name;
        const hpa = hpas.find(
          (item) =>
            item?.metadata?.namespace === namespace &&
            item?.spec?.scaleTargetRef?.kind === 'Deployment' &&
            item?.spec?.scaleTargetRef?.name === name,
        );
        const deployLabels = deploy?.spec?.selector?.matchLabels ?? {};
        const pdb = pdbs.find((item) => {
          if (item?.metadata?.namespace !== namespace) return false;
          const selector = item?.spec?.selector?.matchLabels ?? {};
          return Object.keys(selector).every(
            (key) => deployLabels[key] === selector[key],
          );
        });
        const podList = pods.filter(
          (pod) =>
            pod?.metadata?.namespace === namespace &&
            pod?.metadata?.name?.includes(name),
        );
        const ready = podList.filter((pod) => {
          const conditions = pod?.status?.conditions ?? [];
          return conditions.some(
            (c: any) => c.type === 'Ready' && c.status === 'True',
          );
        }).length;
        const eventCount = events.filter(
          (event) =>
            event?.involvedObject?.namespace === namespace &&
            String(event?.involvedObject?.name || '').includes(name),
        ).length;
        lines.push(
          `${namespace}/${name} | ${hpa ? hpa.metadata.name : '—'} | ${pdb ? pdb.metadata.name : '—'} | ${ready}/${podList.length} | ${eventCount}`,
        );
      }

      return {
        artifactKey: 'k8s_graph',
        output: lines.join('\n'),
        summary: `Graph for ${serviceDeploys.length} workloads.`,
      };
    },
  );

  await runStep('datadog-logs', 'Datadog logs (recent)', async () => {
    const apiKey = params.datadogKeys?.apiKey;
    const appKey = params.datadogKeys?.appKey;
    if (!apiKey || !appKey) {
      return { summary: 'Datadog keys missing; skipping logs.' };
    }

    // Build a simple, safe query for logs search.
    // The monitor query often contains complex syntax (backslashes, wildcards,
    // nested booleans) that the logs search API rejects. Instead, build a
    // focused query from the service name and error status.
    const parts: string[] = [];
    if (service) parts.push(`service:${service}`);
    if (params.alert.environment) parts.push(`env:${params.alert.environment}`);
    parts.push('status:error');
    const query = parts.length > 0 ? parts.join(' ') : '*';

    const to = new Date();
    const from = new Date(to.getTime() - 30 * 60 * 1000);
    const url = `https://api.${params.datadogSite}/api/v2/logs/events/search`;
    try {
      const response = await axios.post(
        url,
        {
          filter: {
            query,
            from: from.toISOString(),
            to: to.toISOString(),
          },
          sort: '-timestamp',
          page: {
            limit: 5,
          },
        },
        {
          headers: {
            'DD-API-KEY': apiKey,
            'DD-APPLICATION-KEY': appKey,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
        },
      );
      const logs = response.data?.data ?? [];
      const output = JSON.stringify(logs.slice(0, 5), null, 2);
      return {
        artifactKey: 'datadog_logs',
        output,
        summary: `Fetched ${logs.length} recent error logs (query: ${query}).`,
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const statusText = error?.response?.statusText;
      const responseData = error?.response?.data;
      throw new Error(
        `Datadog logs failed (${status}): ${statusText} - ${JSON.stringify(responseData)}`,
      );
    }
  });

  await runStep('runbook', 'Runbook excerpts', async () => {
    const links = extractRunbookLinks(params.alert.monitorMessage);
    if (links.length === 0) {
      return { summary: 'No runbook links found in monitor message.' };
    }
    let output = '';
    for (const link of links.slice(0, 2)) {
      try {
        const res = await axios.get(link, { timeout: 8_000 });
        const text = String(res.data);
        output += `# ${link}\n${text.slice(0, 1000)}\n\n`;
      } catch (error: unknown) {
        output += `# ${link}\nFailed to fetch: ${errorMessage(error)}\n\n`;
      }
    }
    return {
      artifactKey: 'runbook',
      output,
      summary: `Fetched ${links.length} runbook links.`,
    };
  });

  await runStep('confluence', 'Confluence search snippets', async () => {
    const baseUrl = params.confluence?.baseUrl;
    const user = params.confluence?.user;
    const token = params.confluence?.token;
    if (!baseUrl || !user || !token) {
      return { summary: 'Confluence credentials missing; skipping.' };
    }
    const query = encodeURIComponent(`text ~ "${service || monitorName}"`);
    let url = baseUrl.replace(/\/$/, '');
    if (!url.includes('/rest/api/search')) {
      url = `${url}/rest/api/search?cql=${query}&limit=3`;
    } else {
      url = `${url}&cql=${query}&limit=3`;
    }
    try {
      const response = await axios.get(url, {
        auth: { username: user, password: token },
        timeout: 10_000,
      });
      type ConfluenceResult = {
        content?: { title?: string };
        _links?: { base?: string; webui?: string };
      };
      const results =
        (response.data?.results as ConfluenceResult[] | undefined) ?? [];
      const output = JSON.stringify(
        results.map((item) => ({
          title: item.content?.title,
          url: item._links?.base
            ? `${item._links.base}${item._links.webui ?? ''}`
            : item._links?.webui,
        })),
        null,
        2,
      );
      return {
        artifactKey: 'confluence',
        output,
        summary: `Found ${results.length} pages.`,
      };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404 || status === 400) {
        return {
          summary: `Confluence API returned ${status}. Check ATLASSIAN_BASE_URL is correct. For Atlassian Cloud, use https://your-domain.atlassian.net (with /wiki suffix). Skipping this step; MCP Jira/Confluence tools are available via OpenCode CLI.`,
        };
      }
      throw error;
    }
  });

  await runStep('jira', 'Jira search snippets', async () => {
    const rawBaseUrl = params.jira?.baseUrl;
    const user = params.jira?.user;
    const token = params.jira?.token;
    if (!rawBaseUrl || !user || !token) {
      return { summary: 'Jira credentials missing; skipping.' };
    }
    // Strip /wiki suffix that Confluence URLs have - JIRA API is at the root domain
    const baseUrl = rawBaseUrl.replace(/\/wiki\/?$/, '');
    const jql = encodeURIComponent(
      `text ~ "${service || monitorName}" ORDER BY updated DESC`,
    );
    // Try v3 first (Atlassian Cloud), fall back to v2 (Server/DC)
    const cleanBase = baseUrl.replace(/\/$/, '');
    let response: import('axios').AxiosResponse;
    let errorSummary = '';
    try {
      // For v3, use /rest/api/3/search/jql endpoint (newer API)
      response = await axios.get(
        `${cleanBase}/rest/api/3/search/jql?jql=${jql}&maxResults=3`,
        { auth: { username: user, password: token }, timeout: 10_000 },
      );
    } catch (error: any) {
      const status = error?.response?.status;
      const errorMsg = error?.message || 'Unknown error';
      errorSummary = `v3 failed with ${status}: ${errorMsg}`;

      // Special handling for 410 Gone errors - likely wrong URL
      if (status === 410) {
        return {
          summary: `Jira API returned 410 Gone. Check ATLASSIAN_BASE_URL points to a valid Jira instance (not Confluence). For Atlassian Cloud, use https://your-domain.atlassian.net (no /wiki suffix). Skipping; MCP Jira tools are available via OpenCode CLI.`,
        };
      }

      // Handle 404/400 gracefully - skip this step
      if (status === 404 || status === 400) {
        return {
          summary: `Jira API returned ${status}. Check ATLASSIAN_BASE_URL is correct. Skipping; MCP Jira tools are available via OpenCode CLI.`,
        };
      }

      try {
        response = await axios.get(
          `${cleanBase}/rest/api/2/search?jql=${jql}&maxResults=3`,
          { auth: { username: user, password: token }, timeout: 10_000 },
        );
      } catch (v2Error: any) {
        const v2Status = v2Error?.response?.status;
        const v2Message = v2Error?.message || 'Unknown error';

        // If v2 also returns 410, URL is wrong
        if (v2Status === 410) {
          return {
            summary: `Jira API returned 410 Gone for both v3 and v2. JIRA_BASE_URL (${cleanBase}) does not point to a valid Jira instance. Skipping; MCP Jira tools are available via OpenCode CLI.`,
          };
        }

        // Handle 404/400 gracefully
        if (v2Status === 404 || v2Status === 400) {
          return {
            summary: `Jira API returned ${v2Status}. Check ATLASSIAN_BASE_URL is correct. Skipping; MCP Jira tools are available via OpenCode CLI.`,
          };
        }

        return {
          summary: `Jira search failed: v3 (${status}), v2 (${v2Status}). ${errorSummary}; v2: ${v2Message}`,
        };
      }
    }
    type JiraIssue = {
      key?: string;
      fields?: { summary?: string; status?: { name?: string } };
    };
    const issues = (response.data?.issues as JiraIssue[] | undefined) ?? [];
    const output = JSON.stringify(
      issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields?.summary,
        status: issue.fields?.status?.name,
      })),
      null,
      2,
    );
    return {
      artifactKey: 'jira',
      output,
      summary: `Found ${issues.length} issues.`,
    };
  });

  const heuristics = loadHeuristics(params.repoRoot);
  if (heuristics) {
    const serviceConfig = heuristics.services?.[service];
    const patterns = [
      ...(serviceConfig?.knownPatterns ?? []),
      ...(heuristics.global ?? []),
    ];
    for (const pattern of patterns) {
      const nameMatches = pattern.trigger.monitorNameContains?.some((token) =>
        monitorName.toLowerCase().includes(token.toLowerCase()),
      );
      const repoSearch = pattern.trigger.repoSearch;
      if (!nameMatches || !repoSearch || !repoPath) continue;
      const rg = await runCommand('rg', [
        '-n',
        '--glob',
        repoSearch.glob ?? '**/*.{yaml,yml}',
        repoSearch.rg,
        repoPath,
      ]);
      const hits = parseRgMatches(rg.stdout, repoPath);
      if (hits.length === 0) continue;
      const target = hits[0];
      let diff: string | undefined;
      if (
        pattern.id === 'pdb-minreplicas-zero' &&
        pattern.recommendation?.defaultMinReplicas != null
      ) {
        const indentMatch = target.text.match(/^\\s*/)?.[0] ?? '';
        const newValue = pattern.recommendation.defaultMinReplicas;
        diff = [
          `--- a/${target.path}`,
          `+++ b/${target.path}`,
          `@@`,
          `-${target.text}`,
          `+${indentMatch}minReplicas: ${newValue}`,
        ].join('\n');
      }
      fixSuggestions.push({
        title: pattern.description,
        summary: pattern.recommendation.summary,
        confidence: 0.7,
        files: hits.slice(0, 3),
        diff,
      });
    }
  }

  const similarIncidents = await params.findSimilar();

  return {
    steps,
    artifacts,
    repoFiles,
    fixSuggestions,
    similarIncidents,
    evidenceMap: {
      steps: steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        summary: step.summary,
        artifacts: step.artifacts,
      })),
      topRepoFindings: repoFiles.slice(0, 5),
      fixSuggestions,
    },
  };
}

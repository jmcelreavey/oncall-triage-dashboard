import { existsSync } from 'fs';
import { join } from 'path';

export function parseAlertStates(value?: string) {
  if (!value) return ['alert', 'warn', 'no_data'];
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function parseTeamFilter(value?: string) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesTeam(tags: string[], teams: string[]) {
  if (teams.length === 0) return true;
  const normalized = tags.map((tag) => tag.toLowerCase());
  return normalized.some((tag) => {
    if (!tag.startsWith('team:')) return false;
    const team = tag.split(':')[1];
    return team ? teams.includes(team) : false;
  });
}

export function matchesNamespace(tags: string[], namespaces: string[]) {
  if (namespaces.length === 0) return true;
  const normalized = tags.map((tag) => tag.toLowerCase());
  return normalized.some((tag) => {
    if (!tag.startsWith('kube_namespace:')) return false;
    const namespace = tag.split(':')[1];
    return namespace ? namespaces.includes(namespace) : false;
  });
}

export function parseServiceRepoMap(value?: string): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string') out[key.toLowerCase()] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function guessServiceFromTags(tags: string[]) {
  const serviceTag = tags.find((tag) => tag.startsWith('service:'));
  if (serviceTag) return serviceTag.split(':')[1];
  return null;
}

export function guessServiceFromQuery(query?: string) {
  if (!query) return null;
  const match = query.match(/service:([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export function guessServiceFromMessage(message?: string) {
  if (!message) return null;
  const match = message.match(/service\s*[:=]\s*"?([a-zA-Z0-9_-]+)"?/i);
  if (match) return match[1];
  const match2 = message.match(/service\s+"([a-zA-Z0-9_-]+)"/i);
  return match2 ? match2[1] : null;
}

export function guessServiceFromName(name?: string) {
  if (!name) return null;
  const parts = Array.from(name.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1]);
  if (!parts.length) return null;
  const envTokens = new Set([
    'prd',
    'prod',
    'production',
    'stg',
    'stage',
    'staging',
    'dev',
    'test',
    'qa',
  ]);
  for (const part of parts) {
    const low = part.toLowerCase();
    if (envTokens.has(low)) continue;
    if (/^p\d$/.test(low)) continue;
    return part;
  }
  return parts[0];
}

export function extractPriority(value?: string) {
  if (!value) return null;
  const match = value.match(/\bP([1-5])\b/i) ?? value.match(/\[P([1-5])\]/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractRepoFromMessage(message?: string) {
  if (!message) return { repo: null, url: null };
  const urlMatch = message.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s)]+/i);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[).,]$/, '');
    const repo = url.split('/').pop() ?? null;
    return { repo, url };
  }
  const repoMatch = message.match(
    /\b(?:repo|repository)\s*[:=]\s*"?([a-zA-Z0-9_.-]+)"?/i,
  );
  if (repoMatch) return { repo: repoMatch[1], url: null };
  return { repo: null, url: null };
}

export function monitorUrl(site: string, id: string | number | undefined) {
  return id ? `https://app.${site}/monitors/${id}` : undefined;
}

export function matchesAlertFilter(
  message: string | undefined,
  filter: string | undefined,
) {
  if (!filter) return true;
  if (!message) return false;
  const normalized = filter.replace('#', '').toLowerCase();
  const variants = [
    normalized,
    `#${normalized}`,
    `@slack-${normalized}`,
    `slack-${normalized}`,
  ];
  const lower = message.toLowerCase();
  return variants.some((variant) => lower.includes(variant));
}

export function findRepoPath(
  service: string | null | undefined,
  repoHint: string | null | undefined,
  sourceRepo: string | null | undefined,
  repoRoot: string,
  repoMap: Record<string, string>,
) {
  const candidates = [service, sourceRepo, repoHint].filter(
    Boolean,
  ) as string[];
  for (const candidate of candidates) {
    const mapped = repoMap[candidate.toLowerCase()];
    if (mapped && existsSync(mapped)) return mapped;
  }
  for (const candidate of candidates) {
    const direct = join(repoRoot, candidate);
    if (existsSync(join(direct, '.git'))) return direct;
    const lower = join(repoRoot, candidate.toLowerCase());
    if (existsSync(join(lower, '.git'))) return lower;
  }
  return null;
}

export function extractRepoNameFromMonitorName(
  monitorName: string,
): string | null {
  if (!monitorName) return null;

  const patterns = [
    /\b([a-z][a-z0-9-]*(?:core|api|worker|service|service|dashboard|web|worker|agent))\b/i,
    /\b(syndication|capi|svapi|muse|fenrir|quicksilver|commerce|content|subscription|mobile|data|infra)\b/i,
    /\b(capi-[a-z][a-z0-9-]*)\b/i,
    /\b(svapi-[a-z][a-z0-9-]*)\b/i,
    /\b(muse-[a-z][a-z0-9-]*)\b/i,
  ];

  for (const pattern of patterns) {
    const match = monitorName.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  const words = monitorName
    .toLowerCase()
    .split(/[\s\-\[\]]+/)
    .filter(
      (w) =>
        w.length > 2 &&
        ![
          'prd',
          'prod',
          'stg',
          'dev',
          'test',
          'p1',
          'p2',
          'p3',
          'p4',
          'p5',
        ].includes(w),
    );

  return words[0] || null;
}

export function guessGitHubRepoPath(
  repoName: string,
  repoRoot: string,
): string | null {
  if (!repoName) return null;

  const defaultOrg = 'businessinsider';
  const candidates = [
    join(repoRoot, repoName),
    join(repoRoot, `${defaultOrg}-${repoName}`),
    join(repoRoot, defaultOrg, repoName),
    join(repoRoot, repoName.toLowerCase()),
    join(repoRoot, repoName.replace(/-/g, '')),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git'))) {
      return candidate;
    }
  }

  return null;
}

export function buildRepoUrlFromPath(
  repoPath: string,
  repoRoot: string,
): string | null {
  if (!repoPath || !repoRoot) return null;

  const relativePath = repoPath.replace(repoRoot, '').replace(/^\//, '');
  const parts = relativePath.split('/');

  const repoName = parts.pop();
  const org = parts.pop() || 'businessinsider';

  if (repoName) {
    return `https://github.com/${org}/${repoName}`;
  }

  return null;
}

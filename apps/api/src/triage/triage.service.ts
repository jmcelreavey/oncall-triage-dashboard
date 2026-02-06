import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { buildPrompt } from './prompt';
import { AlertContext, TriageProvider } from './types';
import path from 'path';
import {
  extractPriority,
  extractRepoFromMessage,
  findRepoPath,
  guessServiceFromMessage,
  guessServiceFromName,
  guessServiceFromQuery,
  guessServiceFromTags,
  matchesAlertFilter,
  matchesNamespace,
  matchesTeam,
  monitorUrl,
  parseAlertStates,
  parseTeamFilter,
  parseServiceRepoMap,
  extractRepoNameFromMonitorName,
  guessGitHubRepoPath,
} from './utils';
import { OpenCodeProvider } from './providers/opencode.provider';
import { MockProvider } from './providers/mock.provider';
import { CodexProvider } from './providers/codex.provider';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { env, envBool, envNumber } from '../config/env';
import { EvidenceBundle, gatherEvidence, SimilarIncident } from './evidence';
import { Prisma } from '@prisma/client';
import { MonitorRepoMappingService } from '../services/monitor-repo-mapping.service';

@Injectable()
export class TriageService implements OnModuleInit {
  private readonly logger = new Logger(TriageService.name);
  private isRunning = false;
  private readonly schedulerName = 'default';
  private readonly lockName = 'triage-scheduler';
  private readonly ownerId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  private readonly execFileAsync = promisify(execFile);

  constructor(
    private prisma: PrismaService,
    private repoMappingService: MonitorRepoMappingService,
  ) {}

  onModuleInit() {
    if (!envBool('TRIAGE_ENABLED', true)) return;
    void this.handleCron();
    void this.runRepoAutoDiscovery();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    if (!envBool('TRIAGE_ENABLED', true)) return;
    await this.updateSchedulerState({ lastRunAt: new Date() });
    const intervalMs = envNumber('TRIAGE_INTERVAL_MS', 60_000);
    if (intervalMs > 60_000) {
      const scheduler = await this.prisma.schedulerState.findUnique({
        where: { name: this.schedulerName },
      });
      const lastRunAt = scheduler?.lastRunAt?.getTime() ?? 0;
      if (Date.now() - lastRunAt < Math.max(intervalMs - 1_000, 0)) {
        return;
      }
    }
    const result = await this.runSchedulerTick();
    if (result?.skipped) {
      this.logger.warn(`Scheduler tick skipped: ${result.skipped}.`);
    }
  }

  async runSchedulerTick() {
    if (this.isRunning) {
      this.logger.warn('Scheduler tick skipped: already running.');
      return { processed: 0, skipped: 'already_running' };
    }
    this.isRunning = true;
    await this.failStaleRuns();
    const leaseMs = envNumber(
      'TRIAGE_LEASE_MS',
      envNumber('TRIAGE_INTERVAL_MS', 60_000) * 2,
    );
    const now = new Date();
    const acquired = await this.acquireLease(now, leaseMs);
    if (!acquired) {
      this.logger.warn('Scheduler tick skipped: lease not acquired.');
      this.isRunning = false;
      return { processed: 0, skipped: 'lease_not_acquired' };
    }
    const stopHeartbeat = this.startLeaseHeartbeat(leaseMs);
    try {
      const intervalMs = envNumber('TRIAGE_INTERVAL_MS', 60_000);
      const maxCatchup = envNumber('TRIAGE_MAX_CATCHUP', 5);
      const scheduler = await this.prisma.schedulerState.findUnique({
        where: { name: this.schedulerName },
      });
      const lastRunAt = scheduler?.lastRunAt?.getTime();
      const gap = lastRunAt ? now.getTime() - lastRunAt : 0;
      const backlog =
        lastRunAt && gap > intervalMs
          ? Math.min(maxCatchup, Math.ceil(gap / intervalMs))
          : 1;

      let processedTotal = 0;
      const runTimeoutMs = envNumber('TRIAGE_RUNONCE_TIMEOUT_MS', 180_000);
      for (let i = 0; i < backlog; i += 1) {
        const result = await this.withTimeout(
          this.runOnce(),
          runTimeoutMs,
          'Scheduler run timed out',
        );
        processedTotal += result.processed ?? 0;
      }
      if (backlog > 1) {
        this.logger.warn(`Scheduler catch-up ran ${backlog} cycles.`);
        if (backlog === maxCatchup && gap / intervalMs > maxCatchup) {
          this.logger.warn(`Scheduler backlog capped at ${maxCatchup} cycles.`);
        }
      }
      return { processed: processedTotal, backlog };
    } catch (error: any) {
      await this.updateSchedulerState({
        lastError: error?.message ?? 'Scheduler error',
      });
      this.logger.error(
        `Scheduler run failed: ${error?.message}`,
        error?.stack,
      );
      return { processed: 0, error: error?.message ?? 'Scheduler error' };
    } finally {
      stopHeartbeat();
      await this.releaseLease();
      this.isRunning = false;
    }
  }

  async runOnce() {
    const startedAt = Date.now();
    this.logger.log('Scheduler run started.');
    await this.updateSchedulerState({ lastRunAt: new Date(), lastError: null });
    try {
      const alerts = await this.collectAlerts();
      this.logger.log(`Scheduler collected ${alerts.length} alert(s).`);
      for (const alert of alerts) {
        await this.processAlert(alert);
      }
      await this.updateSchedulerState({ lastSuccessAt: new Date() });
      this.logger.log(
        `Scheduler run completed (${alerts.length} alerts, ${Date.now() - startedAt}ms).`,
      );
      return { processed: alerts.length };
    } catch (error: any) {
      await this.updateSchedulerState({
        lastError: error?.message ?? 'Scheduler error',
      });
      this.logger.error(
        `Scheduler run failed: ${error?.message}`,
        error?.stack,
      );
      this.logger.error(
        `Scheduler run failed after ${Date.now() - startedAt}ms.`,
      );
      return { processed: 0, error: error?.message ?? 'Scheduler error' };
    }
  }

  private async runRepoAutoDiscovery() {
    if (!envBool('AUTO_DISCOVER_REPOS', false)) {
      this.logger.log('Auto-discovery disabled, skipping.');
      return;
    }

    const intervalMs = envNumber('AUTO_DISCOVER_INTERVAL', 86400000);
    const scheduler = await this.prisma.schedulerState.findUnique({
      where: { name: 'repo-discovery' },
    });
    const lastRunAt = scheduler?.lastRunAt?.getTime() ?? 0;
    const now = Date.now();

    if (now - lastRunAt < intervalMs) {
      this.logger.log(
        `Repo auto-discovery skipped (last run: ${new Date(lastRunAt).toISOString()})`,
      );
      return;
    }

    this.logger.log('Running repo auto-discovery');
    const result = await this.repoMappingService.autoDiscoverMappings();

    await this.prisma.schedulerState.upsert({
      where: { name: 'repo-discovery' },
      create: {
        name: 'repo-discovery',
        lastRunAt: new Date(),
        lastSuccessAt: result.discovered > 0 ? new Date() : undefined,
        lastError:
          result.errors.length > 0 ? result.errors.join('; ') : undefined,
      },
      update: {
        lastRunAt: new Date(),
        lastSuccessAt: result.discovered > 0 ? new Date() : undefined,
        lastError:
          result.errors.length > 0 ? result.errors.join('; ') : undefined,
      },
    });

    this.logger.log(
      `Repo auto-discovery completed: ${result.discovered} new mappings`,
    );
  }

  private async updateSchedulerState(patch: {
    lastRunAt?: Date | null;
    lastSuccessAt?: Date | null;
    lastError?: string | null;
  }) {
    const createData: {
      name: string;
      lastRunAt?: Date | null;
      lastSuccessAt?: Date | null;
      lastError?: string | null;
    } = {
      name: this.schedulerName,
    };
    const updateData: {
      lastRunAt?: Date | null;
      lastSuccessAt?: Date | null;
      lastError?: string | null;
    } = {};

    if ('lastRunAt' in patch) {
      createData.lastRunAt = patch.lastRunAt;
      updateData.lastRunAt = patch.lastRunAt;
    }
    if ('lastSuccessAt' in patch) {
      createData.lastSuccessAt = patch.lastSuccessAt;
      updateData.lastSuccessAt = patch.lastSuccessAt;
    }
    if ('lastError' in patch) {
      createData.lastError = patch.lastError;
      updateData.lastError = patch.lastError;
    }

    await this.prisma.schedulerState.upsert({
      where: { name: this.schedulerName },
      create: createData,
      update: updateData,
    });
  }

  private async acquireLease(now: Date, leaseMs: number) {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const updated = await this.prisma.schedulerLock.updateMany({
      where: {
        name: this.lockName,
        OR: [{ leaseExpiresAt: { lt: now } }, { ownerId: this.ownerId }],
      },
      data: {
        ownerId: this.ownerId,
        leaseExpiresAt: expiresAt,
        heartbeatAt: now,
        acquiredAt: now,
      },
    });
    if (updated.count > 0) return true;

    const existing = await this.prisma.schedulerLock.findUnique({
      where: { name: this.lockName },
    });

    if (!existing) {
      try {
        await this.prisma.schedulerLock.create({
          data: {
            name: this.lockName,
            ownerId: this.ownerId,
            leaseExpiresAt: expiresAt,
            heartbeatAt: now,
            acquiredAt: now,
          },
        });
        return true;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return false;
        }
        this.logger.warn(
          `Failed to acquire scheduler lease: ${this.formatError(error)}`,
        );
        return false;
      }
    }

    if (existing.leaseExpiresAt < now) {
      const retry = await this.prisma.schedulerLock.updateMany({
        where: { name: this.lockName, leaseExpiresAt: { lt: now } },
        data: {
          ownerId: this.ownerId,
          leaseExpiresAt: expiresAt,
          heartbeatAt: now,
          acquiredAt: now,
        },
      });
      if (retry.count > 0) return true;
    }

    this.logger.warn(
      `Scheduler lease held by ${existing.ownerId} until ${existing.leaseExpiresAt.toISOString()}.`,
    );
    return false;
  }

  private startLeaseHeartbeat(leaseMs: number) {
    const interval = Math.max(5_000, Math.floor(leaseMs / 2));
    const timer = setInterval(() => {
      void this.refreshLease(new Date(), leaseMs);
    }, interval);
    return () => clearInterval(timer);
  }

  private async refreshLease(now: Date, leaseMs: number) {
    const expiresAt = new Date(now.getTime() + leaseMs);
    await this.prisma.schedulerLock.updateMany({
      where: { name: this.lockName, ownerId: this.ownerId },
      data: { leaseExpiresAt: expiresAt, heartbeatAt: now },
    });
  }

  private async releaseLease() {
    await this.prisma.schedulerLock.updateMany({
      where: { name: this.lockName, ownerId: this.ownerId },
      data: { leaseExpiresAt: new Date() },
    });
  }

  async triggerRun() {
    if (!envBool('TRIAGE_ENABLED', true)) {
      return { queued: false, reason: 'disabled' };
    }
    if (this.isRunning) {
      return { queued: false, reason: 'already_running' };
    }
    void this.runSchedulerTick().catch((error) => {
      this.logger.error(`Manual run failed: ${this.formatError(error)}`);
    });
    return { queued: true };
  }

  async continueRun(runId: string) {
    const previous = await this.prisma.triageRun.findUnique({
      where: { id: runId },
      include: { alert: true },
    });
    if (!previous || !previous.alert) {
      return { error: 'Run not found' };
    }

    const run = await this.prisma.triageRun.create({
      data: {
        alertId: previous.alert.id,
        status: 'running',
        provider: env('PROVIDER') ?? 'opencode',
        parentRunId: previous.id,
      },
    });

    const previousEvidence = this.asEvidenceBundle(previous.evidence);
    if (
      previousEvidence ||
      previous.evidenceTimeline ||
      previous.fixSuggestions ||
      previous.similarIncidents
    ) {
      await this.prisma.triageRun.update({
        where: { id: run.id },
        data: {
          evidence: previousEvidence ?? undefined,
          evidenceTimeline: previous.evidenceTimeline ?? undefined,
          fixSuggestions: previous.fixSuggestions ?? undefined,
          similarIncidents: previous.similarIncidents ?? undefined,
        },
      });
    }

    const alertContext: AlertContext = {
      monitorId: previous.alert.monitorId ?? undefined,
      monitorName: previous.alert.monitorName ?? undefined,
      monitorState: previous.alert.monitorState ?? undefined,
      priority: previous.alert.priority ?? undefined,
      monitorUrl: previous.alert.monitorUrl ?? undefined,
      monitorMessage: previous.alert.monitorMessage ?? undefined,
      monitorQuery: previous.alert.monitorQuery ?? undefined,
      monitorTags: (previous.alert.monitorTags as string[]) ?? undefined,
      overallStateModified: previous.alert.overallStateModified?.toISOString(),
      service: previous.alert.service ?? undefined,
      environment: previous.alert.environment ?? undefined,
      sourceRepo: previous.alert.sourceRepo ?? undefined,
      repoHint: previous.alert.repoHint ?? undefined,
      repoUrl: previous.alert.repoUrl ?? undefined,
      repoPath: previous.alert.repoPath ?? undefined,
      githubEnrichment: previous.alert.githubEnrichment ?? undefined,
      confluenceEnrichment: previous.alert.confluenceEnrichment ?? undefined,
    };

    void this.runTriage(run, alertContext, {
      previousReport: previous.reportMarkdown ?? '',
      evidence: previousEvidence ?? undefined,
      gatherEvidence: false,
    });
    return { queued: true, runId: run.id };
  }

  private resolveRepoRoot() {
    return env('REPO_ROOT') ?? path.resolve(__dirname, '../../../../..');
  }

  async rerunRun(runId: string) {
    this.logger.log(`Re-run requested for run ${runId}.`);
    const previous = await this.prisma.triageRun.findUnique({
      where: { id: runId },
      include: { alert: true },
    });
    if (!previous || !previous.alert) {
      this.logger.warn(`Re-run failed: run ${runId} not found.`);
      return { error: 'Run not found' };
    }

    const run = await this.prisma.triageRun.create({
      data: {
        alertId: previous.alert.id,
        status: 'running',
        provider: env('PROVIDER') ?? 'opencode',
        parentRunId: previous.id,
      },
    });
    this.logger.log(`Created rerun ${run.id} for alert ${previous.alert.id}.`);

    const alertContext: AlertContext = {
      monitorId: previous.alert.monitorId ?? undefined,
      monitorName: previous.alert.monitorName ?? undefined,
      monitorState: previous.alert.monitorState ?? undefined,
      priority: previous.alert.priority ?? undefined,
      monitorUrl: previous.alert.monitorUrl ?? undefined,
      monitorMessage: previous.alert.monitorMessage ?? undefined,
      monitorQuery: previous.alert.monitorQuery ?? undefined,
      monitorTags: (previous.alert.monitorTags as string[]) ?? undefined,
      overallStateModified: previous.alert.overallStateModified?.toISOString(),
      service: previous.alert.service ?? undefined,
      environment: previous.alert.environment ?? undefined,
      sourceRepo: previous.alert.sourceRepo ?? undefined,
      repoHint: previous.alert.repoHint ?? undefined,
      repoUrl: previous.alert.repoUrl ?? undefined,
      repoPath: previous.alert.repoPath ?? undefined,
      githubEnrichment: previous.alert.githubEnrichment ?? undefined,
      confluenceEnrichment: previous.alert.confluenceEnrichment ?? undefined,
    };

    void this.runTriage(run, alertContext, { gatherEvidence: true });
    return { queued: true, runId: run.id };
  }

  private async findExistingAlertEvent(
    monitorId: string,
    overallStateModified: Date,
  ): Promise<{ id: string } | null> {
    return this.prisma.alertEvent.findFirst({
      where: {
        monitorId,
        overallStateModified,
      },
      select: { id: true },
    });
  }

  async reprocessLastError() {
    this.logger.log('Reprocess last error requested.');
    const lastError = await this.fetchLastErrorFromDatadog();
    if (!lastError) {
      this.logger.warn(
        'Reprocess last error: no matching alerts found in Datadog.',
      );
      return { error: 'No matching alerts found in Datadog.' };
    }
    this.logger.log(
      `Reprocessing last error: ${lastError.monitorName} (${lastError.monitorId}).`,
    );
    try {
      this.logger.log('Calling processAlert()...');
      void this.processAlert(lastError, { allowReprocess: true }).catch(
        (error) => {
          this.logger.error(
            `Reprocess last error failed: ${this.formatError(error)}`,
          );
        },
      );
      this.logger.log(`Reprocess last error queued successfully.`);
    } catch (error: any) {
      this.logger.error(
        `Reprocess last error failed: ${this.formatError(error)}`,
      );
      return { error: this.formatError(error) };
    }
    return { queued: true, monitorId: lastError.monitorId };
  }

  private async fetchLastErrorFromDatadog(): Promise<AlertContext | null> {
    const apiKey = env('DATADOG_API_KEY') ?? '';
    const appKey = env('DATADOG_APP_KEY') ?? '';
    const site = env('DATADOG_SITE') ?? 'datadoghq.com';
    const timeoutMs = envNumber('DATADOG_TIMEOUT_MS', 20_000);
    const teamFilter = parseTeamFilter(env('ALERT_TEAM'));

    if (!apiKey || !appKey) {
      this.logger.warn('Missing Datadog keys for reprocess last error.');
      return null;
    }

    if (teamFilter.length === 0) {
      this.logger.warn('ALERT_TEAM not configured for reprocess last error.');
      return null;
    }

    try {
      this.logger.log('Fetching Datadog monitors for reprocess last error.');
      const response = await axios.get(
        `https://api.${site}/api/v1/monitor?with_downtimes=true`,
        {
          headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
          timeout: timeoutMs,
        },
      );
      const monitors = response.data ?? [];

      const alerts: AlertContext[] = [];
      const maxAgeHours = 24;

      for (const monitor of monitors) {
        const tags: string[] = monitor.tags ?? [];
        if (
          !matchesTeam(tags, teamFilter) &&
          !matchesNamespace(tags, teamFilter)
        )
          continue;

        const priority: number | null = (() => {
          if (typeof monitor.priority === 'number') return monitor.priority;
          if (typeof monitor.priority === 'string') {
            const parsed = Number.parseInt(monitor.priority, 10);
            return Number.isFinite(parsed) ? parsed : null;
          }
          return (
            extractPriority(monitor.name) ??
            extractPriority(monitor.message) ??
            null
          );
        })();

        if (priority !== 2 && priority !== 4) continue;

        const modified = monitor.overall_state_modified ?? monitor.modified;
        const modifiedDate = modified ? new Date(modified) : null;
        if (!modifiedDate || Number.isNaN(modifiedDate.valueOf())) continue;

        if (Date.now() - modifiedDate.valueOf() > maxAgeHours * 60 * 60 * 1000)
          continue;

        const service =
          guessServiceFromTags(tags) ||
          guessServiceFromQuery(monitor.query) ||
          guessServiceFromMessage(monitor.message) ||
          guessServiceFromName(monitor.name);
        const environment = tags
          .find((tag) => tag.startsWith('environment:'))
          ?.split(':')[1];
        const sourceRepo = tags
          .find((tag) => tag.startsWith('sourceRepo:'))
          ?.split(':')[1];
        const { repo: repoHint, url: repoUrl } = extractRepoFromMessage(
          monitor.message,
        );

        const repoRoot = this.resolveRepoRoot();
        const repoMap = parseServiceRepoMap(env('SERVICE_REPO_MAP'));
        let repoPath =
          findRepoPath(service, repoHint, sourceRepo, repoRoot, repoMap) ??
          undefined;

        if (!repoPath && monitor.name) {
          const guessedRepoName = extractRepoNameFromMonitorName(monitor.name);
          if (guessedRepoName) {
            repoPath =
              guessGitHubRepoPath(guessedRepoName, repoRoot) ?? undefined;
          }
        }

        alerts.push({
          monitorId: String(monitor.id),
          monitorName: monitor.name,
          monitorState: monitor.overall_state,
          priority,
          monitorUrl: monitorUrl(site, monitor.id),
          monitorMessage: monitor.message,
          monitorQuery: monitor.query,
          monitorTags: tags,
          overallStateModified: modifiedDate.toISOString(),
          service: service ?? undefined,
          environment,
          sourceRepo,
          repoHint: repoHint ?? undefined,
          repoUrl: repoUrl ?? undefined,
          repoPath,
        });
      }

      alerts.sort((a, b) => {
        const aTime = a.overallStateModified
          ? new Date(a.overallStateModified).getTime()
          : 0;
        const bTime = b.overallStateModified
          ? new Date(b.overallStateModified).getTime()
          : 0;
        return bTime - aTime;
      });

      return alerts.length > 0 ? alerts[0] : null;
    } catch (error: any) {
      this.logger.error(
        `Datadog fetch failed for reprocess last error: ${error?.message}`,
      );
      return null;
    }
  }

  async forceClearRunning() {
    const running = await this.prisma.triageRun.findMany({
      where: { status: 'running' },
      select: { id: true },
    });
    if (running.length === 0) {
      return {
        ok: false,
        cleared: 0,
        message: 'No running triage runs found.',
      };
    }
    const ids = running.map((run) => run.id);
    await this.prisma.triageRun.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'failed',
        error: 'Manually cleared',
        finishedAt: new Date(),
      },
    });
    await this.prisma.schedulerLock.updateMany({
      where: { name: this.lockName },
      data: { leaseExpiresAt: new Date(0) },
    });
    this.isRunning = false;
    this.logger.warn(`Force-cleared ${ids.length} running run(s).`);
    return { ok: true, cleared: ids.length };
  }

  async openCodexSession(runId: string) {
    const run = await this.prisma.triageRun.findUnique({
      where: { id: runId },
      include: { alert: true },
    });
    if (!run?.sessionId) {
      return { error: 'No Codex session available.' };
    }

    const codexBin =
      env('CODEX_BIN') ?? '/Applications/Codex.app/Contents/Resources/codex';
    const repoRoot = this.resolveRepoRoot();
    const cmd = `${codexBin} resume ${run.sessionId} -C ${repoRoot}`;

    if (process.platform === 'darwin') {
      const script =
        `tell application "Terminal"\n` +
        `activate\n` +
        `do script "cd ${repoRoot} && ${codexBin} resume ${run.sessionId}"\n` +
        `end tell`;
      try {
        const { spawn } = await import('child_process');
        spawn('osascript', ['-e', script], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        return { ok: true, command: cmd };
      } catch (error: any) {
        return {
          error: error?.message ?? 'Failed to open Codex session',
          command: cmd,
        };
      }
    }

    return { ok: true, command: cmd };
  }

  async suggestBranch(runId: string) {
    const run = await this.prisma.triageRun.findUnique({
      where: { id: runId },
      include: { alert: true },
    });
    if (!run?.alert) return { error: 'Run not found' };

    const service = run.alert.service ?? run.alert.repoHint ?? 'triage';
    const monitorName = run.alert.monitorName ?? 'alert';
    const slug = monitorName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const branchName = `triage/${service}/${date}-${slug}`.replace(/\/+/g, '/');

    const report = run.reportMarkdown ?? '';
    const fileRegex =
      /(?:^|\s)([\w./-]+\.(?:ya?ml|json|ts|tsx|js|go|py|tf|hcl|md))/g;
    const files = new Set<string>();
    let match: RegExpExecArray | null = null;
    while ((match = fileRegex.exec(report)) !== null) {
      files.add(match[1]);
      if (files.size >= 5) break;
    }

    const repoPath = run.alert.repoPath ?? undefined;
    const commands = repoPath
      ? [`cd ${repoPath}`, `git checkout -b ${branchName}`]
      : [`git checkout -b ${branchName}`];

    return {
      branchName,
      repoPath,
      files: Array.from(files),
      commands,
    };
  }

  async collectAlerts(): Promise<AlertContext[]> {
    const apiKey = env('DATADOG_API_KEY') ?? '';
    const appKey = env('DATADOG_APP_KEY') ?? '';
    const site = env('DATADOG_SITE') ?? 'datadoghq.com';
    const timeoutMs = envNumber('DATADOG_TIMEOUT_MS', 20_000);

    if (!apiKey || !appKey) {
      this.logger.warn('Missing Datadog keys. Skipping alert collection.');
      return [];
    }

    const alertStates = parseAlertStates(env('ALERT_STATES'));
    const alertFilter = env('ALERT_TEXT_FILTER');
    const teamFilter = parseTeamFilter(env('ALERT_TEAM'));
    const maxAgeMinutes = envNumber('ALERT_MAX_AGE_MINUTES', 120);
    const now = Date.now();

    let monitors: any[] = [];
    try {
      this.logger.log('Fetching Datadog monitors.');
      const response = await axios.get(
        `https://api.${site}/api/v1/monitor?with_downtimes=true`,
        {
          headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
          timeout: timeoutMs,
          timeoutErrorMessage: `Datadog request timed out after ${timeoutMs}ms`,
        },
      );
      monitors = response.data ?? [];
      this.logger.log(`Datadog monitors fetched (${monitors.length}).`);
    } catch (error: any) {
      this.logger.error(
        `Datadog fetch failed: ${error?.message ?? 'unknown error'}`,
      );
      return [];
    }
    this.logger.log('Filtering Datadog monitors.');
    const alerts: AlertContext[] = [];

    for (const monitor of monitors) {
      const overallState = (monitor.overall_state ?? '').toLowerCase();
      if (!alertStates.includes(overallState)) continue;
      if (!matchesAlertFilter(monitor.message, alertFilter)) continue;

      const modified = monitor.overall_state_modified ?? monitor.modified;
      const modifiedDate = modified ? new Date(modified) : null;
      if (!modifiedDate || Number.isNaN(modifiedDate.valueOf())) continue;
      if (now - modifiedDate.valueOf() > maxAgeMinutes * 60 * 1000) continue;

      const exists = await this.prisma.alertEvent.findFirst({
        where: {
          monitorId: String(monitor.id),
          overallStateModified: modifiedDate,
        },
      });
      if (exists) continue;

      const tags: string[] = monitor.tags ?? [];
      if (!matchesTeam(tags, teamFilter) && !matchesNamespace(tags, teamFilter))
        continue;
      let priority: number | null = null;
      if (typeof monitor.priority === 'number') {
        priority = monitor.priority;
      } else if (typeof monitor.priority === 'string') {
        const parsed = Number.parseInt(monitor.priority, 10);
        priority = Number.isFinite(parsed) ? parsed : null;
      }
      if (!priority) {
        priority =
          extractPriority(monitor.name) ??
          extractPriority(monitor.message) ??
          null;
      }
      const service =
        guessServiceFromTags(tags) ||
        guessServiceFromQuery(monitor.query) ||
        guessServiceFromMessage(monitor.message) ||
        guessServiceFromName(monitor.name);
      const environment = tags
        .find((tag) => tag.startsWith('environment:'))
        ?.split(':')[1];
      const sourceRepo = tags
        .find((tag) => tag.startsWith('sourceRepo:'))
        ?.split(':')[1];
      const { repo: repoHint, url: repoUrl } = extractRepoFromMessage(
        monitor.message,
      );

      const repoRoot = this.resolveRepoRoot();
      const repoMap = parseServiceRepoMap(env('SERVICE_REPO_MAP'));
      let repoPath =
        findRepoPath(service, repoHint, sourceRepo, repoRoot, repoMap) ??
        undefined;

      if (!repoPath && monitor.name) {
        const guessedRepoName = extractRepoNameFromMonitorName(monitor.name);
        if (guessedRepoName) {
          repoPath =
            guessGitHubRepoPath(guessedRepoName, repoRoot) ?? undefined;
        }
      }

      alerts.push({
        monitorId: String(monitor.id),
        monitorName: monitor.name,
        monitorState: monitor.overall_state,
        priority,
        monitorUrl: monitorUrl(site, monitor.id),
        monitorMessage: monitor.message,
        monitorQuery: monitor.query,
        monitorTags: tags,
        overallStateModified: modifiedDate.toISOString(),
        service: service ?? undefined,
        environment,
        sourceRepo,
        repoHint: repoHint ?? undefined,
        repoUrl: repoUrl ?? undefined,
        repoPath,
      });
    }

    this.logger.log(
      `Datadog monitors filtered to ${alerts.length} new alert(s).`,
    );
    return alerts;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private async failStaleRuns() {
    const timeoutMs = envNumber(
      'TRIAGE_RUN_TIMEOUT_MS',
      envNumber('TRIAGE_PROVIDER_TIMEOUT_MS', 600_000) + 120_000,
    );
    const threshold = new Date(Date.now() - timeoutMs);
    const stale = await this.prisma.triageRun.findMany({
      where: { status: 'running', createdAt: { lt: threshold } },
      select: { id: true },
    });
    if (stale.length === 0) return;
    const ids = stale.map((run) => run.id);
    await this.prisma.triageRun.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'failed',
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        finishedAt: new Date(),
      },
    });
    this.logger.warn(`Marked ${ids.length} stale triage run(s) as failed.`);
  }

  async processAlert(
    alert: AlertContext,
    options?: { allowReprocess?: boolean },
  ) {
    const { allowReprocess = false } = options ?? {};

    this.logger.log(
      `processAlert() started for ${alert.monitorName} (${alert.monitorId})`,
    );

    let alertRecord;
    if (allowReprocess && alert.monitorId && alert.overallStateModified) {
      this.logger.log('Checking for existing alert event...');
      const existing = await this.findExistingAlertEvent(
        alert.monitorId,
        new Date(alert.overallStateModified),
      );
      if (existing) {
        this.logger.log(
          `Found existing alert event for reprocessing: ${existing.id}`,
        );
        alertRecord = await this.prisma.alertEvent.findUnique({
          where: { id: existing.id },
        });
      }
    }

    this.logger.log('Starting enrichAlert()...');
    const enrichment = await this.enrichAlert(alert);
    this.logger.log('enrichAlert() completed');
    const enrichedAlert: AlertContext = {
      ...alert,
      githubEnrichment: enrichment.github,
      confluenceEnrichment: enrichment.confluence,
    };

    if (!alertRecord) {
      this.logger.log('Creating new alert event record...');
      alertRecord = await this.prisma.alertEvent.create({
        data: {
          monitorId: alert.monitorId,
          monitorName: alert.monitorName ?? '',
          monitorState: alert.monitorState ?? '',
          priority: alert.priority ?? undefined,
          monitorUrl: alert.monitorUrl,
          monitorMessage: alert.monitorMessage,
          monitorQuery: alert.monitorQuery,
          monitorTags: alert.monitorTags ?? [],
          overallStateModified: alert.overallStateModified
            ? new Date(alert.overallStateModified)
            : undefined,
          service: alert.service,
          environment: alert.environment,
          sourceRepo: alert.sourceRepo,
          repoHint: alert.repoHint,
          repoUrl: alert.repoUrl,
          repoPath: alert.repoPath,
          githubEnrichment: enrichment.github ?? undefined,
          confluenceEnrichment: enrichment.confluence ?? undefined,
        },
      });
    } else {
      this.logger.log(`Using existing alert event record: ${alertRecord.id}`);
    }

    this.logger.log('Creating triage run...');
    const run = await this.prisma.triageRun.create({
      data: {
        alertId: alertRecord.id,
        status: 'running',
        provider: env('PROVIDER') ?? 'opencode',
      },
    });

    this.logger.log('Starting runTriage()...');
    await this.runTriage(run, enrichedAlert, { gatherEvidence: true });
    this.logger.log('runTriage() completed');
  }

  private buildEvidenceFallback(error: unknown): EvidenceBundle {
    const message = this.formatError(error);
    return {
      steps: [
        {
          id: 'evidence-failure',
          title: 'Evidence gathering',
          status: 'error',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          summary: message,
        },
      ],
      artifacts: {},
      repoFiles: [],
      fixSuggestions: [],
      similarIncidents: [],
      evidenceMap: {
        steps: [
          {
            id: 'evidence-failure',
            title: 'Evidence gathering',
            status: 'error',
            summary: message,
            artifacts: [],
          },
        ],
        topRepoFindings: [],
        fixSuggestions: [],
      },
    };
  }

  private async runTriage(
    run: { id: string; provider: string },
    alert: AlertContext,
    options?: {
      previousReport?: string;
      evidence?: EvidenceBundle | null;
      gatherEvidence?: boolean;
    },
  ) {
    const runStartTime = Date.now();
    this.logger.log(
      `[${run.id}] Starting triage run with provider ${run.provider}`,
    );

    try {
      let evidence: EvidenceBundle | null | undefined =
        options?.evidence ?? null;
      if (options?.gatherEvidence !== false && !evidence) {
        this.logger.log(`[${run.id}] Starting evidence gathering`);
        const evidenceStartTime = Date.now();

        this.logger.log(`[${run.id}] Calling gatherEvidence()...`);

        const repoRoot = this.resolveRepoRoot();
        const datadogSite =
          env('DATADOG_SITE', 'datadoghq.com') ?? 'datadoghq.com';
        try {
          evidence = await gatherEvidence({
            alert,
            repoRoot,
            repoPath: alert.repoPath,
            runId: run.id,
            datadogSite,
            datadogKeys: {
              apiKey: env('DATADOG_API_KEY'),
              appKey: env('DATADOG_APP_KEY'),
            },
            confluence: {
              baseUrl: (() => {
                const atlassianBaseUrl = env('ATLASSIAN_BASE_URL') ?? '';
                return atlassianBaseUrl
                  ? `${atlassianBaseUrl.replace(/\/$/, '')}/wiki`
                  : '';
              })(),
              user: env('ATLASSIAN_USER') ?? env('CONFLUENCE_USER'),
              token: env('ATLASSIAN_TOKEN') ?? env('CONFLUENCE_TOKEN'),
            },
            jira: {
              baseUrl: (() => {
                const atlassianBaseUrl = env('ATLASSIAN_BASE_URL') ?? '';
                return atlassianBaseUrl.replace(/\/$/, '');
              })(),
              user: env('ATLASSIAN_USER') ?? env('CONFLUENCE_USER'),
              token: env('ATLASSIAN_TOKEN') ?? env('CONFLUENCE_TOKEN'),
            },
            scanCommits: envNumber('REPO_SCAN_COMMITS', 20),
            findSimilar: () => this.findSimilarIncidents(alert),
            getRepoMapping: (
              monitorId: string,
              monitorName: string,
              service?: string,
            ) =>
              this.repoMappingService.getRepoPathForMonitor(
                monitorId,
                monitorName,
                service,
              ),
          });

          const evidenceDuration = (
            (Date.now() - evidenceStartTime) /
            1000
          ).toFixed(1);
          this.logger.log(
            `[${run.id}] Evidence gathering completed in ${evidenceDuration}s (${evidence.steps.length} steps)`,
          );
          this.logger.log(`[${run.id}] gatherEvidence() finished successfully`);
        } catch (error: unknown) {
          const evidenceDuration = (
            (Date.now() - evidenceStartTime) /
            1000
          ).toFixed(1);
          this.logger.warn(
            `[${run.id}] Evidence gathering failed after ${evidenceDuration}s: ${this.formatError(error)}`,
          );
          evidence = this.buildEvidenceFallback(error);
        }
      } else if (evidence) {
        this.logger.log(`[${run.id}] Using pre-gathered evidence`);
      } else {
        this.logger.log(`[${run.id}] Skipping evidence gathering`);
      }

      if (evidence) {
        this.logger.log(`[${run.id}] Saving evidence to database`);
        await this.prisma.triageRun.update({
          where: { id: run.id },
          data: {
            evidence,
            evidenceTimeline: evidence.steps,
            fixSuggestions: evidence.fixSuggestions,
            similarIncidents: evidence.similarIncidents,
          },
        });
      }

      this.logger.log(
        `[${run.id}] Starting provider execution (${run.provider})`,
      );
      this.logger.log(`[${run.id}] Calling executeProviderRun()...`);
      const providerStartTime = Date.now();

      await this.executeProviderRun(run, alert, {
        previousReport: options?.previousReport,
        evidence: evidence ?? undefined,
      });

      const providerDuration = (
        (Date.now() - providerStartTime) /
        1000
      ).toFixed(1);
      const totalDuration = ((Date.now() - runStartTime) / 1000).toFixed(1);
      this.logger.log(
        `[${run.id}] Triage completed successfully - provider: ${providerDuration}s, total: ${totalDuration}s`,
      );
    } catch (error: any) {
      const totalDuration = ((Date.now() - runStartTime) / 1000).toFixed(1);
      this.logger.error(
        `[${run.id}] Triage failed after ${totalDuration}s: ${this.formatError(error)}`,
      );
      await this.failRun(run.id, error);
    }
  }

  private buildRunInputs(
    alert: AlertContext,
    runId: string,
    options?: {
      previousReport?: string;
      evidence?: EvidenceBundle | null | undefined;
    },
  ) {
    const repoRoot = this.resolveRepoRoot();
    const runDir = join(
      env('RUNS_DIR') ?? join(process.cwd(), 'data', 'runs'),
      runId,
    );
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

    const alertPath = join(runDir, 'alert.json');
    writeFileSync(alertPath, JSON.stringify(alert, null, 2));

    const skillsPath = env('SKILLS_CONTEXT_PATH');
    const skillsContext =
      skillsPath && existsSync(skillsPath)
        ? readFileSync(skillsPath, 'utf-8')
        : undefined;
    const extraSections: string[] = [];
    if (options?.previousReport) {
      const reportPath = join(runDir, 'previous_report.md');
      writeFileSync(reportPath, options.previousReport);
      extraSections.push(
        `PREVIOUS REPORT:\n${options.previousReport}`.slice(0, 8000),
      );
    }

    if (options?.evidence) {
      const evidencePath = join(runDir, 'evidence.json');
      writeFileSync(evidencePath, JSON.stringify(options.evidence, null, 2));
      extraSections.push(
        `EVIDENCE TIMELINE (steps + timestamps):\n${JSON.stringify(
          options.evidence.steps ?? [],
          null,
          2,
        ).slice(0, 8000)}`,
      );
      extraSections.push(
        `EVIDENCE ARTIFACT KEYS:\n${Object.keys(options.evidence.artifacts ?? {}).join(', ')}`,
      );
      if (options.evidence.fixSuggestions?.length) {
        extraSections.push(
          `DRAFT FIX SUGGESTIONS (not applied):\n${JSON.stringify(
            options.evidence.fixSuggestions,
            null,
            2,
          ).slice(0, 8000)}`,
        );
      }
      extraSections.push(
        `EVIDENCE MAP (ids + summaries):\n${JSON.stringify(
          options.evidence.evidenceMap ?? {},
          null,
          2,
        ).slice(0, 8000)}`,
      );
    }

    const prompt = buildPrompt(alert, skillsContext, extraSections);

    const promptPath = join(runDir, 'prompt.txt');
    writeFileSync(promptPath, prompt);

    const attachments = [alertPath, promptPath];
    if (options?.previousReport) {
      attachments.push(join(runDir, 'previous_report.md'));
    }
    if (options?.evidence) {
      attachments.push(join(runDir, 'evidence.json'));
    }
    if (skillsPath && existsSync(skillsPath)) attachments.push(skillsPath);

    return {
      prompt: 'Use the attached prompt.txt and alert.json files.',
      attachments,
      workingDir: repoRoot,
    };
  }

  private async executeProviderRun(
    run: { id: string; provider: string },
    alertContext: AlertContext,
    options?: {
      previousReport?: string;
      evidence?: EvidenceBundle | null | undefined;
    },
  ) {
    this.logger.log(`[${run.id}] Building run inputs`);
    const { prompt, attachments, workingDir } = this.buildRunInputs(
      alertContext,
      run.id,
      options,
    );

    this.logger.log(
      `[${run.id}] Invoking provider ${run.provider} (prompt: ${prompt.length} chars, attachments: ${attachments.length})`,
    );
    const provider = this.getProvider();
    const providerCallStart = Date.now();

    const result = await provider.run({
      runId: run.id,
      prompt,
      alertContext,
      attachments,
      workingDir,
    });

    const providerCallDuration = (
      (Date.now() - providerCallStart) /
      1000
    ).toFixed(1);
    this.logger.log(
      `[${run.id}] Provider completed in ${providerCallDuration}s (report: ${result.reportMarkdown?.length || 0} chars)`,
    );
    this.logger.log(`[${run.id}] executeProviderRun() finished`);

    const apiBase = env('API_PUBLIC_URL') ?? 'http://localhost:4000';
    const sessionUrl =
      result.sessionUrl ??
      (result.sessionId && run.provider === 'codex'
        ? `${apiBase.replace(/\/$/, '')}/triage/open-codex/${run.id}`
        : result.sessionId && run.provider === 'opencode'
          ? `${apiBase.replace(/\/$/, '')}/triage/opencode/${run.id}`
          : undefined);

    this.logger.log(`[${run.id}] Saving completed run to database`);
    await this.prisma.triageRun.update({
      where: { id: run.id },
      data: {
        status: 'complete',
        reportMarkdown: result.reportMarkdown,
        sessionId: result.sessionId,
        sessionUrl,
        finishedAt: new Date(),
      },
    });

    return { ...result, sessionUrl };
  }

  private async failRun(runId: string, error: unknown) {
    await this.prisma.triageRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        error: this.formatError(error),
        finishedAt: new Date(),
      },
    });
    this.logger.error(`Triage failed: ${this.formatError(error)}`);
  }

  private getProvider(): TriageProvider {
    const provider = (env('PROVIDER') ?? 'opencode').toLowerCase();
    if (provider === 'codex') {
      const bin =
        env('CODEX_BIN') ??
        (() => {
          const which = spawnSync('which', ['codex']);
          if (which.status === 0) {
            const resolved = String(which.stdout).trim();
            if (resolved) return resolved;
          }
          const appPath = '/Applications/Codex.app/Contents/Resources/codex';
          return appPath;
        })();
      const model = env('CODEX_MODEL');
      const allowFallback = env('CODEX_ALLOW_FALLBACK') !== 'false';
      return new CodexProvider(bin, model, allowFallback);
    }
    if (provider === 'opencode') {
      const bin = env('OPENCODE_BIN') ?? 'opencode';
      const model = env('OPENCODE_MODEL');
      const variant = env('OPENCODE_VARIANT');
      return new OpenCodeProvider(bin, model, variant);
    }
    return new MockProvider();
  }

  private async findSimilarIncidents(
    alert: AlertContext,
  ): Promise<SimilarIncident[]> {
    const service = alert.service;
    const monitorName = alert.monitorName;
    const orFilters: Prisma.AlertEventWhereInput[] = [];
    if (service) orFilters.push({ service });
    if (monitorName) orFilters.push({ monitorName });
    const alertFilter = orFilters.length > 0 ? { OR: orFilters } : undefined;
    const runs = await this.prisma.triageRun.findMany({
      where: {
        status: 'complete',
        ...(alertFilter ? { alert: alertFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { alert: true },
    });

    return runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      summary: this.extractSummary(run.reportMarkdown ?? ''),
      confidence: this.similarityConfidence(
        alert,
        run.alert?.service,
        run.alert?.monitorName,
      ),
      service: run.alert?.service ?? undefined,
      monitorName: run.alert?.monitorName ?? undefined,
    }));
  }

  private extractSummary(report: string) {
    const lines = report.split('\n').map((line) => line.trim());
    const nonEmpty = lines.filter(Boolean);
    if (nonEmpty.length === 0) return 'No summary available.';

    // Try to find "Alert Summary" section
    const alertSummaryIndex = nonEmpty.findIndex(
      (line) =>
        line.toLowerCase().includes('alert summary') ||
        line.toLowerCase().includes('## alert summary'),
    );

    if (alertSummaryIndex !== -1 && alertSummaryIndex + 1 < nonEmpty.length) {
      // Return the line after "Alert Summary" heading
      return nonEmpty[alertSummaryIndex + 1].slice(0, 200);
    }

    // Fallback: look for first non-heading line that's not JSON
    const nonJsonLines = nonEmpty.filter((line) => {
      return (
        !line.startsWith('#') && !line.startsWith('{') && !line.startsWith('[')
      );
    });

    if (nonJsonLines.length > 0) {
      return nonJsonLines[0].slice(0, 200);
    }

    return nonEmpty[0].slice(0, 200);
  }

  private similarityConfidence(
    alert: AlertContext,
    service?: string | null,
    monitorName?: string | null,
  ) {
    let score = 0.4;
    if (alert.service && service && alert.service === service)
      score = Math.max(score, 0.7);
    if (alert.monitorName && monitorName && alert.monitorName === monitorName)
      score = Math.max(score, 0.8);
    if (
      alert.service &&
      service &&
      alert.monitorName &&
      monitorName &&
      alert.service === service &&
      alert.monitorName === monitorName
    ) {
      score = 0.9;
    }
    return score;
  }

  private asEvidenceBundle(value: unknown): EvidenceBundle | null {
    if (!value || typeof value !== 'object') return null;
    return value as EvidenceBundle;
  }

  private formatError(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Unknown error';
  }

  private async enrichAlert(alert: AlertContext) {
    const github = await this.enrichGithub(alert).catch((error) => {
      this.logger.warn(
        `GitHub enrichment failed: ${error?.message ?? 'unknown error'}`,
      );
      return null;
    });
    const confluence = await this.enrichConfluence(alert).catch((error) => {
      this.logger.warn(
        `Confluence enrichment failed: ${error?.message ?? 'unknown error'}`,
      );
      return null;
    });
    return { github, confluence };
  }

  private async enrichGithub(alert: AlertContext) {
    if (env('ENRICH_GITHUB') === 'false') return null;
    const token = env('GITHUB_TOKEN');

    let owner: string | undefined;
    let repo: string | undefined;
    if (alert.repoUrl) {
      const match = alert.repoUrl.match(/github\.com\/([^/]+)\/([^\s]+)/i);
      if (match) {
        owner = match[1];
        repo = match[2];
      }
    }
    if (!owner && alert.repoHint) {
      owner = env('GITHUB_DEFAULT_ORG') ?? 'businessinsider';
      repo = alert.repoHint;
    }
    if (!owner || !repo) return null;

    let repoData: any = null;
    let commitsData: any[] = [];
    let issuesData: any[] = [];
    if (token) {
      const headers = { Authorization: `Bearer ${token}` };
      const repoResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers },
      );
      const commitsResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/commits?per_page=5`,
        {
          headers,
        },
      );
      const issuesResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=5`,
        {
          headers,
        },
      );
      repoData = repoResp.data;
      commitsData = commitsResp.data ?? [];
      issuesData = issuesResp.data ?? [];
    } else {
      try {
        const repoResp = await this.execFileAsync(
          'gh',
          ['api', `repos/${owner}/${repo}`, '--hostname', 'github.com'],
          { timeout: 8_000 },
        );
        repoData = JSON.parse(repoResp.stdout);
        const commitsResp = await this.execFileAsync(
          'gh',
          [
            'api',
            `repos/${owner}/${repo}/commits?per_page=5`,
            '--hostname',
            'github.com',
          ],
          { timeout: 8_000 },
        );
        commitsData = JSON.parse(commitsResp.stdout);
        const issuesResp = await this.execFileAsync(
          'gh',
          [
            'api',
            `repos/${owner}/${repo}/issues?state=open&per_page=5`,
            '--hostname',
            'github.com',
          ],
          { timeout: 8_000 },
        );
        issuesData = JSON.parse(issuesResp.stdout);
      } catch (error) {
        this.logger.warn(
          `GitHub CLI enrichment failed: ${this.formatError(error)}`,
        );
        return null;
      }
    }

    const latestCommit = commitsData?.[0];
    const openIssues = (issuesData ?? []).filter(
      (issue: any) => !issue.pull_request,
    );
    const openPRs = (issuesData ?? []).filter(
      (issue: any) => issue.pull_request,
    );

    return {
      fullName: repoData?.full_name,
      description: repoData?.description,
      defaultBranch: repoData?.default_branch,
      latestCommit: latestCommit
        ? {
            sha: latestCommit.sha,
            message: latestCommit.commit?.message,
            author: latestCommit.commit?.author?.name,
            date: latestCommit.commit?.author?.date,
          }
        : null,
      openIssues: openIssues.slice(0, 3).map((issue: any) => ({
        title: issue.title,
        url: issue.html_url,
      })),
      openPullRequests: openPRs.slice(0, 3).map((pr: any) => ({
        title: pr.title,
        url: pr.html_url,
      })),
    };
  }

  private async enrichConfluence(alert: AlertContext) {
    if (env('ENRICH_CONFLUENCE') === 'false') return null;
    const baseUrl = (() => {
      const atlassianBaseUrl = env('ATLASSIAN_BASE_URL') ?? '';
      return atlassianBaseUrl
        ? `${atlassianBaseUrl.replace(/\/$/, '')}/wiki`
        : env('CONFLUENCE_BASE_URL');
    })();
    const user = env('ATLASSIAN_USER') ?? env('CONFLUENCE_USER');
    const token = env('ATLASSIAN_TOKEN') ?? env('CONFLUENCE_TOKEN');
    if (!baseUrl || !user || !token) return null;

    const terms = [alert.service, alert.repoHint, alert.sourceRepo]
      .filter(Boolean)
      .join(' ');
    if (!terms) return null;
    const cql = `text ~ \"${terms}\" AND (title ~ runbook OR title ~ incident OR text ~ runbook)`;

    const resp = await axios.get(
      `${baseUrl.replace(/\/$/, '')}/rest/api/search`,
      {
        auth: { username: user, password: token },
        params: { cql, limit: 5 },
      },
    );

    const results = resp.data?.results ?? [];
    return results.slice(0, 3).map((item: any) => ({
      title: item.title,
      url: item._links
        ? `${baseUrl.replace(/\/$/, '')}${item._links.webui}`
        : undefined,
    }));
  }
}

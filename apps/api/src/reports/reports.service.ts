import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  private resolveRepoRoot() {
    return env('REPO_ROOT') ?? path.resolve(__dirname, '../../../../..');
  }

  async list(limit = 20) {
    return this.prisma.triageRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        status: true,
        error: true,
        finishedAt: true,
        reportMarkdown: true,
        sessionId: true,
        sessionUrl: true,
        provider: true,
        evidenceTimeline: true,
        fixSuggestions: true,
        similarIncidents: true,
        alert: true,
      },
    });
  }

  async get(id: string) {
    return this.prisma.triageRun.findUnique({
      where: { id },
      include: { alert: true },
    });
  }

  openFile(payload: { repoPath?: string; path: string; line?: number }) {
    const repoRoot = payload.repoPath ?? this.resolveRepoRoot();
    const resolvedRepo = path.resolve(repoRoot);
    const target = path.isAbsolute(payload.path)
      ? path.resolve(payload.path)
      : path.resolve(resolvedRepo, payload.path);

    if (!target.startsWith(resolvedRepo)) {
      return { error: 'Path is outside the repository root.' };
    }
    if (!existsSync(target)) {
      return { error: 'File not found.' };
    }

    const line =
      payload.line && Number.isFinite(payload.line) ? payload.line : undefined;
    const editor = env('CODE_EDITOR');
    const hasCode = spawnSync('which', ['code']).status === 0;
    const hasOpen = spawnSync('which', ['open']).status === 0;
    const hasXdg = spawnSync('which', ['xdg-open']).status === 0;

    if (editor) {
      const args = line ? ['-g', `${target}:${line}`] : [target];
      spawnSync(editor, args, { stdio: 'ignore' });
      return { ok: true, command: `${editor} ${args.join(' ')}` };
    }

    if (hasCode) {
      const args = line ? ['-g', `${target}:${line}`] : [target];
      spawnSync('code', args, { stdio: 'ignore' });
      return { ok: true, command: `code ${args.join(' ')}` };
    }

    if (hasOpen) {
      spawnSync('open', [target], { stdio: 'ignore' });
      return { ok: true, command: `open ${target}` };
    }

    if (hasXdg) {
      spawnSync('xdg-open', [target], { stdio: 'ignore' });
      return { ok: true, command: `xdg-open ${target}` };
    }

    return { error: 'No supported opener found (code/open/xdg-open).' };
  }

  async clear() {
    await this.prisma.triageRun.deleteMany();
    await this.prisma.alertEvent.deleteMany();
    return { ok: true };
  }

  async downloadFiles(id: string) {
    const run = await this.prisma.triageRun.findUnique({
      where: { id },
      select: { workingDir: true, createdAt: true },
    });

    if (!run?.workingDir) {
      return { error: 'Working directory not found for this run.' };
    }

    if (!existsSync(run.workingDir)) {
      return { error: 'Working directory no longer exists.' };
    }

    const files: Array<{
      name: string;
      path: string;
      content?: string;
      size: number;
    }> = [];

    try {
      const entries = readdirSync(run.workingDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(run.workingDir, entry.name);
          const stats = existsSync(filePath) ? readFileSync(filePath) : '';

          const maxSize = 100 * 1024;
          const shouldIncludeContent = stats.length <= maxSize;

          files.push({
            name: entry.name,
            path: filePath,
            content: shouldIncludeContent ? stats.toString() : undefined,
            size: stats.length,
          });
        }
      }
    } catch (error) {
      return { error: `Failed to read working directory: ${String(error)}` };
    }

    return { runId: id, workingDir: run.workingDir, files };
  }

  async getRunInputs(id: string) {
    const runsDir =
      env('RUNS_DIR') ?? path.resolve(process.cwd(), 'data', 'runs');
    const runDir = path.join(runsDir, id);

    if (!existsSync(runDir)) {
      return { error: 'Run directory not found.' };
    }

    const readFileIfExists = (name: string): string | null => {
      const filePath = path.join(runDir, name);
      if (!existsSync(filePath)) return null;
      try {
        return readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    };

    const prompt = readFileIfExists('prompt.txt');
    const alertJson = readFileIfExists('alert.json');
    const evidenceJson = readFileIfExists('evidence.json');
    const previousReport = readFileIfExists('previous_report.md');

    const files: Array<{ name: string; size: number }> = [];
    try {
      const entries = readdirSync(runDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(runDir, entry.name);
          const buf = readFileSync(filePath);
          files.push({ name: entry.name, size: buf.length });
        }
      }
    } catch {
      // ignore read errors for the file listing
    }

    return {
      runId: id,
      runDir,
      prompt,
      alertContext: alertJson ? JSON.parse(alertJson) : null,
      evidence: evidenceJson ? JSON.parse(evidenceJson) : null,
      previousReport,
      files,
    };
  }
}

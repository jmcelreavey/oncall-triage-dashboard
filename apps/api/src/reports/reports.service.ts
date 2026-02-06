import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';
import { existsSync } from 'fs';
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

  async openFile(payload: { repoPath?: string; path: string; line?: number }) {
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
}

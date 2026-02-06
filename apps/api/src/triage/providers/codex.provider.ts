import { ProviderResult, TriageProvider } from '../types';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

function parseSessionId(output: string) {
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const sessionId =
        obj.session_id ||
        obj.sessionId ||
        obj?.metadata?.session_id ||
        obj?.metadata?.sessionId ||
        obj?.session?.id;
      if (sessionId) return sessionId as string;
    } catch {
      continue;
    }
  }
  return undefined;
}

export class CodexProvider implements TriageProvider {
  constructor(
    private readonly bin: string,
    private readonly model?: string,
    private readonly allowFallback = true,
  ) {}

  async run(params: {
    prompt: string;
    attachments: string[];
    workingDir: string;
  }): Promise<ProviderResult> {
    let capturedStdout = '';
    const timeoutMs = Number(process.env.TRIAGE_PROVIDER_TIMEOUT_MS ?? 600_000);
    const promptFile =
      params.attachments.find((file) => path.basename(file) === 'prompt.txt') ??
      params.attachments[0];
    const promptText = promptFile
      ? readFileSync(promptFile, 'utf-8')
      : params.prompt;
    const runDir = promptFile ? path.dirname(promptFile) : params.workingDir;
    const outputPath = path.join(runDir, 'codex_report.md');

    const runCodex = (withModel: boolean) =>
      new Promise<void>((resolve, reject) => {
        const args = [
          'exec',
          '--skip-git-repo-check',
          '--add-dir',
          params.workingDir,
          '-s',
          'read-only',
          '--json',
          '--output-last-message',
          outputPath,
        ];
        if (withModel && this.model) {
          args.push('--model', this.model);
        }

        const child = spawn(this.bin, args, {
          cwd: params.workingDir,
          env: process.env,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 3_000);
          reject(new Error(`codex timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', (chunk) =>
          stdoutChunks.push(Buffer.from(chunk)),
        );
        child.stderr.on('data', (chunk) =>
          stderrChunks.push(Buffer.from(chunk)),
        );
        child.stdin.write(promptText);
        child.stdin.end();
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timeout);
          const stdout = Buffer.concat(stdoutChunks).toString();
          const stderr = Buffer.concat(stderrChunks).toString();
          if (code === 0) {
            capturedStdout = stdout;
            resolve();
          } else {
            reject(new Error(`codex exited with code ${code}: ${stderr}`));
          }
        });
      });

    try {
      await runCodex(true);
    } catch (error) {
      if (this.allowFallback && this.model) {
        await runCodex(false);
      } else {
        throw error;
      }
    }

    const reportMarkdown = readFileSync(outputPath, 'utf-8');
    const sessionId = capturedStdout
      ? parseSessionId(capturedStdout)
      : undefined;
    return { reportMarkdown, sessionId, rawOutput: capturedStdout };
  }
}

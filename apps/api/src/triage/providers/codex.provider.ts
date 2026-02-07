import { ProviderResult, TriageProvider, AlertContext } from '../types';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
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
    runId: string;
    prompt: string;
    alertContext: AlertContext;
    attachments: string[];
    workingDir: string;
  }): Promise<ProviderResult> {
    const { runId, prompt, attachments, workingDir } = params;
    let capturedStdout = '';
    const timeoutMs = Number(process.env.TRIAGE_PROVIDER_TIMEOUT_MS ?? 600_000);

    console.log(
      `[${runId}] Codex provider timeout set to ${timeoutMs}ms (${timeoutMs / 1000}s)`,
    );

    const promptFile =
      attachments.find((file) => path.basename(file) === 'prompt.txt') ??
      attachments[0];
    const promptText = promptFile ? readFileSync(promptFile, 'utf-8') : prompt;
    const runDir = promptFile ? path.dirname(promptFile) : workingDir;
    const outputPath = path.join(runDir, 'codex_report.md');

    const runCodex = (withModel: boolean) =>
      new Promise<void>((resolve, reject) => {
        // Use --full-auto for headless automated triage:
        //   --full-auto sets: -a on-request (no approval prompts) + -s workspace-write
        // This allows the agent to run shell commands (git, kubectl, rg, etc.)
        // and write files without requiring user approval.
        // Previous read-only sandbox prevented ALL tool execution.
        const args = [
          'exec',
          '--skip-git-repo-check',
          '--add-dir',
          workingDir,
          '--full-auto',
          '--json',
          '--output-last-message',
          outputPath,
        ];
        if (withModel && this.model) {
          args.push('--model', this.model);
        }

        console.log(
          `[${runId}] Starting Codex process: ${this.bin} ${args.slice(0, 5).join(' ')}...`,
        );

        const startTime = Date.now();

        const child = spawn(this.bin, args, {
          cwd: workingDir,
          env: {
            ...process.env,
            CODEX_ALLOW_NETWORK: 'true',
            CODEX_ALLOW_FILESYSTEM: 'true',
          },
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        console.log(`[${runId}] Codex process spawned (PID: ${child.pid})`);

        // Periodic heartbeat to show process is still alive
        let lastStdoutLen = 0;
        let lastStderrLen = 0;
        const heartbeat = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const stdoutBytes = stdoutChunks.reduce(
            (sum, b) => sum + b.length,
            0,
          );
          const stderrBytes = stderrChunks.reduce(
            (sum, b) => sum + b.length,
            0,
          );
          const stdoutDelta = stdoutBytes - lastStdoutLen;
          const stderrDelta = stderrBytes - lastStderrLen;
          lastStdoutLen = stdoutBytes;
          lastStderrLen = stderrBytes;
          console.log(
            `[${runId}] Codex heartbeat ${elapsed}s - stdout: ${stdoutBytes}B (+${stdoutDelta}), stderr: ${stderrBytes}B (+${stderrDelta})`,
          );
        }, 30_000);

        const timeout = setTimeout(() => {
          clearInterval(heartbeat);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const stderrSoFar = Buffer.concat(stderrChunks)
            .toString()
            .slice(-500);
          console.log(
            `[${runId}] Codex timeout reached after ${elapsed}s, killing process`,
          );
          console.log(`[${runId}] Last stderr: ${stderrSoFar || '(empty)'}`);
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 3_000);
          reject(
            new Error(
              `codex timed out after ${timeoutMs}ms (${elapsed}s elapsed). Last stderr: ${stderrSoFar || '(none)'}`,
            ),
          );
        }, timeoutMs);

        child.stdout.on('data', (chunk) =>
          stdoutChunks.push(Buffer.from(chunk)),
        );
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) {
            console.log(`[${runId}] Codex stderr: ${text.slice(0, 200)}`);
          }
          stderrChunks.push(Buffer.from(chunk));
        });

        // Pipe prompt text via stdin, then close
        child.stdin.write(promptText);
        child.stdin.end();

        child.on('error', (err) => {
          clearInterval(heartbeat);
          console.log(`[${runId}] Codex process error:`, err);
          reject(err);
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          clearInterval(heartbeat);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const stdout = Buffer.concat(stdoutChunks).toString();
          const stderr = Buffer.concat(stderrChunks).toString();

          if (code === 0) {
            console.log(
              `[${runId}] Codex process completed successfully in ${elapsed}s`,
            );
            capturedStdout = stdout;
            resolve();
          } else {
            console.log(
              `[${runId}] Codex process failed (exit code ${code}) after ${elapsed}s: ${stderr.slice(-500)}`,
            );
            reject(
              new Error(
                `codex exited with code ${code} after ${elapsed}s: ${stderr.slice(-500)}`,
              ),
            );
          }
        });
      });

    try {
      await runCodex(true);
    } catch (error) {
      if (this.allowFallback && this.model) {
        console.log(
          `[${runId}] Codex failed with model ${this.model}, retrying without model flag...`,
        );
        await runCodex(false);
      } else {
        throw error;
      }
    }

    let reportMarkdown = '';
    if (existsSync(outputPath)) {
      reportMarkdown = readFileSync(outputPath, 'utf-8');
      console.log(
        `[${runId}] Codex report read from ${outputPath}: ${reportMarkdown.length} chars`,
      );
    } else {
      console.log(
        `[${runId}] Warning: Codex output file not found at ${outputPath}`,
      );
      reportMarkdown = 'Codex completed but no output file was generated.';
    }

    const sessionId = capturedStdout
      ? parseSessionId(capturedStdout)
      : undefined;

    console.log(
      `[${runId}] Codex final: report=${reportMarkdown.length} chars, sessionId=${sessionId ?? '(none)'}`,
    );

    return { reportMarkdown, sessionId, rawOutput: capturedStdout };
  }
}

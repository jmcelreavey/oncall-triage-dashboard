import { spawn } from 'child_process';
import { basename } from 'path';
import { ProviderResult, TriageProvider } from '../types';

function encodeRepoPath(path: string) {
  return Buffer.from(path).toString('base64url');
}

function isOpenCodeMetadata(type?: string): boolean {
  const metadataTypes = [
    'step_start',
    'step_finish',
    'step_error',
    'run_start',
    'run_finish',
    'run_error',
    'tool_call',
    'tool_result',
    'agent_thought',
    'session_info',
  ];
  return Boolean(type && metadataTypes.includes(type));
}

function extractTextFromObj(obj: any): string | null {
  if (!obj) return null;

  // Skip metadata objects
  if (isOpenCodeMetadata(obj?.type)) return null;

  // Extract text from known locations
  if (obj?.role === 'assistant' && typeof obj?.content === 'string') {
    return obj.content;
  }
  if (
    obj?.message?.role === 'assistant' &&
    typeof obj?.message?.content === 'string'
  ) {
    return obj.message.content;
  }
  if (obj?.type === 'assistant_message' && typeof obj?.content === 'string') {
    return obj.content;
  }
  if (obj?.type === 'text' && typeof obj?.text === 'string') {
    return obj.text;
  }
  if (
    obj?.type === 'content_block_delta' &&
    typeof obj?.delta?.text === 'string'
  ) {
    return obj.delta.text;
  }

  // Handle OpenCode streaming response format (text nested in part)
  if (obj?.part?.type === 'text' && typeof obj?.part?.text === 'string') {
    return obj.part.text;
  }

  return null;
}

function parseJsonLines(output: string) {
  const lines = output.split('\n');
  let sessionId: string | undefined;
  const assistantParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Extract session ID from various possible locations (check before skipping metadata)
    if (!sessionId) {
      sessionId =
        obj.session_id ||
        obj.sessionId ||
        obj.session ||
        obj?.metadata?.session_id ||
        obj?.part?.sessionID ||
        obj?.sessionID;
    }

    // Extract text if available, will return null for metadata
    const text = extractTextFromObj(obj);
    if (text) {
      assistantParts.push(text);
    }
  }

  // If we found incremental parts, join them; otherwise return undefined
  const assistantText =
    assistantParts.length > 0 ? assistantParts.join('') : undefined;

  return { sessionId, assistantText };
}

export class OpenCodeProvider implements TriageProvider {
  constructor(
    private readonly bin: string,
    private readonly model?: string,
    private readonly variant?: string,
  ) {}

  async run(params: {
    runId: string;
    prompt: string;
    alertContext: any;
    attachments: string[];
    workingDir: string;
  }): Promise<ProviderResult> {
    const { runId, prompt, attachments, workingDir } = params;
    const title = `Triage ${basename(workingDir)} ${new Date().toISOString()}`;
    const timeoutMs = Number(process.env.TRIAGE_PROVIDER_TIMEOUT_MS ?? 600_000);

    console.log(
      `[${runId}] OpenCode provider timeout set to ${timeoutMs}ms (${timeoutMs / 1000}s)`,
    );

    const args = ['run', '--format', 'json', '--title', title];
    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.variant) {
      args.push('--variant', this.variant);
    }

    const attachUrl = process.env.OPENCODE_WEB_URL;
    if (attachUrl) {
      args.push('--attach', attachUrl);
    }

    if (attachments.length > 0) {
      args.push('--file', ...attachments);
    }

    args.push('--', prompt);

    console.log(
      `[${runId}] Starting OpenCode process: ${this.bin} ${args.slice(0, 5).join(' ')}...`,
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: workingDir,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: undefined,
          OPENCODE_SERVER_PASSWORD: undefined,
          OPENCODE: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately to signal non-interactive mode
      child.stdin.end();

      console.log(`[${runId}] OpenCode process spawned (PID: ${child.pid})`);

      // Periodic heartbeat to show process is still alive
      let lastStdoutLen = 0;
      let lastStderrLen = 0;
      const heartbeat = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const stdoutBytes = stdoutChunks.reduce((sum, b) => sum + b.length, 0);
        const stderrBytes = stderrChunks.reduce((sum, b) => sum + b.length, 0);
        const stdoutDelta = stdoutBytes - lastStdoutLen;
        const stderrDelta = stderrBytes - lastStderrLen;
        lastStdoutLen = stdoutBytes;
        lastStderrLen = stderrBytes;
        console.log(
          `[${runId}] OpenCode heartbeat ${elapsed}s - stdout: ${stdoutBytes}B (+${stdoutDelta}), stderr: ${stderrBytes}B (+${stderrDelta})`,
        );
      }, 30_000);

      const timeout = setTimeout(() => {
        clearInterval(heartbeat);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const stdoutSoFar = Buffer.concat(stdoutChunks).toString().slice(-500);
        const stderrSoFar = Buffer.concat(stderrChunks).toString().slice(-500);
        console.log(
          `[${runId}] OpenCode timeout reached after ${elapsed}s, killing process`,
        );
        console.log(`[${runId}] Last stdout: ${stdoutSoFar || '(empty)'}`);
        console.log(`[${runId}] Last stderr: ${stderrSoFar || '(empty)'}`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000);
        reject(
          new Error(
            `opencode timed out after ${timeoutMs}ms (${elapsed}s elapsed). Last stderr: ${stderrSoFar || '(none)'}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          console.log(`[${runId}] OpenCode stderr: ${text.slice(0, 200)}`);
        }
        stderrChunks.push(Buffer.from(chunk));
      });

      child.on('error', (err) => {
        clearInterval(heartbeat);
        console.log(`[${runId}] OpenCode process error:`, err);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (code === 0) {
          console.log(
            `[${runId}] OpenCode process completed successfully in ${elapsed}s`,
          );
          resolve();
        } else {
          const stderr = Buffer.concat(stderrChunks).toString();
          console.log(
            `[${runId}] OpenCode process failed (exit code ${code}) after ${elapsed}s: ${stderr.slice(-500)}`,
          );
          reject(
            new Error(
              `opencode exited with code ${code} after ${elapsed}s: ${stderr.slice(-500)}`,
            ),
          );
        }
      });
    });

    const stdout = Buffer.concat(stdoutChunks).toString();
    const { sessionId, assistantText } = parseJsonLines(stdout);

    const webBase = process.env.OPENCODE_WEB_URL || '';
    console.log(
      `[${runId}] OpenCode parse result: sessionId=${sessionId ?? '(none)'}, assistantText length=${assistantText?.length ?? 0}`,
    );
    console.log(
      `[${runId}] Environment: OPENCODE_WEB_URL=${webBase ? webBase : '(not set)'}`,
    );
    console.log(`[${runId}] Working directory: ${workingDir}`);

    const sessionUrl =
      sessionId && webBase
        ? `${webBase.replace(/\/$/, '')}/${encodeRepoPath(workingDir)}/session/${sessionId}`
        : undefined;

    console.log(
      `[${runId}] Generated sessionUrl: ${sessionUrl ?? '(not generated)'}`,
    );

    // If structured parsing didn't find assistant text, try to extract
    // readable content from the raw JSON output as a fallback
    let report = assistantText;
    if (!report && stdout) {
      const fallbackParts: string[] = [];
      for (const line of stdout.split('\n')) {
        try {
          const obj = JSON.parse(line.trim());
          const text = extractTextFromObj(obj);
          if (text && text.length > 20) {
            fallbackParts.push(text);
          }
        } catch {
          // Not JSON, skip
        }
      }
      report = fallbackParts.length > 0 ? fallbackParts.join('\n\n') : '';
    }

    console.log(
      `[${runId}] Parsed report: ${report?.length ?? 0} chars, sessionId: ${sessionId ?? '(none)'}`,
    );

    return {
      reportMarkdown: report || 'No response received from OpenCode.',
      sessionId,
      sessionUrl,
      rawOutput: stdout,
    };
  }
}

import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { basename } from "path";
import * as fs from "fs/promises";
import { ProviderResult, TriageProvider } from "@/triage/types";

const execFileAsync = promisify(execFile);

interface JsonObject {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    sessionID?: string;
  };
  role?: string;
  content?: string | Array<{ text?: string; [key: string]: unknown }>;
  message?: {
    role?: string;
    content?: string;
  };
  delta?: {
    text?: string;
  };
  text?: string;
  session_id?: string;
  sessionId?: string;
  session?: string;
  sessionID?: string;
  metadata?: {
    session_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenCodeSessionWithId {
  id: string;
  [key: string]: unknown;
}

function encodeRepoPath(path: string) {
  return Buffer.from(path).toString("base64url");
}

function isOpenCodeMetadata(type?: string): boolean {
  const metadataTypes = [
    "step_start",
    "step_finish",
    "step_error",
    "run_start",
    "run_finish",
    "run_error",
    "tool_call",
    "tool_result",
    "agent_thought",
    "session_info",
  ];
  return Boolean(type && metadataTypes.includes(type));
}

function extractTextFromObj(obj: JsonObject | null): string | null {
  if (!obj) return null;

  // Skip metadata objects first
  if (isOpenCodeMetadata(obj?.type)) return null;

  // Handle OpenCode streaming response format (text nested in part) - PRIORITY 1
  if (obj?.part?.type === "text" && typeof obj?.part?.text === "string") {
    return obj.part.text;
  }

  // Direct top-level text (format variation) - PRIORITY 2
  if (obj?.type === "text" && typeof obj?.text === "string") {
    return obj.text;
  }

  // Extract text from known locations (fallback formats)
  if (obj?.role === "assistant" && typeof obj?.content === "string") {
    return obj.content;
  }
  if (
    obj?.message?.role === "assistant" &&
    typeof obj?.message?.content === "string"
  ) {
    return obj.message.content;
  }
  if (obj?.type === "assistant_message" && typeof obj?.content === "string") {
    return obj.content;
  }
  if (
    obj?.type === "content_block_delta" &&
    typeof obj?.delta?.text === "string"
  ) {
    return obj.delta.text;
  }

  // Additional fallback: check for text in nested content_block
  if (
    obj?.type === "content_block" &&
    Array.isArray(obj?.content) &&
    typeof obj?.content[0]?.text === "string"
  ) {
    return obj.content[0].text;
  }

  // Debug: log objects that don't match known patterns (helps identify new formats)
  if (obj?.type && typeof obj.type === "string" && obj.type !== "text") {
    const keys = Object.keys(obj).slice(0, 5).join(", ");
    if (
      !["step_start", "step_finish", "run_start", "run_finish"].includes(
        obj.type,
      )
    ) {
      console.log(
        `[extractTextFromObj] Unknown type "${obj.type}" with keys: ${keys}`,
      );
    }
  }

  return null;
}

function parseJsonLines(output: string) {
  const lines = output.split("\n");
  let sessionId: string | undefined;
  const assistantParts: string[] = [];
  let linesParsed = 0;
  let linesWithText = 0;
  const debugSample: string[] = []; // Store first few parsed objects for debugging

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: JsonObject | null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    linesParsed++;

    // Extract session ID from various possible locations (check before skipping metadata)
    if (!sessionId && obj) {
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
      linesWithText++;
      // Log first few text extractions for debugging
      if (assistantParts.length <= 3) {
        debugSample.push(
          `Part ${assistantParts.length}: ${text.slice(0, 100)}...`,
        );
      }
    }
  }

  // If we found incremental parts, join them; otherwise return undefined
  const assistantText =
    assistantParts.length > 0 ? assistantParts.join("") : undefined;

  console.log(
    `[parseJsonLines] Parsed ${linesParsed} JSON lines, found text in ${linesWithText} lines, total chars: ${assistantText?.length ?? 0}`,
  );

  // Debug: show sample of extracted parts
  if (debugSample.length > 0) {
    console.log(`[parseJsonLines] Sample parts: ${debugSample.join(" | ")}`);
  }

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
    alertContext: Record<string, unknown>;
    attachments: string[];
    workingDir: string;
  }): Promise<ProviderResult> {
    const { runId, prompt, attachments, workingDir } = params;
    const title = `Triage ${basename(workingDir)} ${new Date().toISOString()}`;
    const timeoutMs = Number(
      process.env.TRIAGE_PROVIDER_TIMEOUT_MS ?? 1_200_000,
    );

    const reportFilePath = `${workingDir}/.opencode-report-${runId}.txt`;
    const augmentedPrompt = `${prompt}\n\nIMPORTANT: At the end of your investigation, write your final report to the file ${reportFilePath} using the Write tool. This report should include your diagnosis, findings, and recommended actions.`;

    console.log(
      `[${runId}] OpenCode provider timeout set to ${timeoutMs}ms (${timeoutMs / 1000}s)`,
    );

    const args = ["run", "--format", "json", "--print-logs", "--title", title];

    // NOTE: Do NOT use --agent general here. The 'general' agent is a subagent
    // and cannot be used with `opencode run` (it warns and falls back to default).
    // Instead, permissions must be configured in the global OpenCode config at
    // ~/.config/opencode/opencode.json with:
    //   "permission": { "external_directory": "allow", "doom_loop": "allow", "read": "allow", ... }
    // The integrations service checks for this and the dashboard flags when it's missing.

    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.variant) {
      args.push("--variant", this.variant);
    }

    // Use --attach to connect to a running OpenCode web server when available.
    // This avoids the "Session not found" error that occurs when `opencode run`
    // tries to start its own server alongside an already-running instance.
    // --attach creates a NEW session on the existing server, so no pre-existing
    // session is needed.
    const attachUrl = process.env.OPENCODE_WEB_URL;
    if (attachUrl) {
      args.push("--attach", attachUrl);
      console.log(`[${runId}] Using --attach mode with server at ${attachUrl}`);
    }

    if (attachments.length > 0) {
      args.push("--file", ...attachments);
    }

    args.push("--", augmentedPrompt);

    console.log(
      `[${runId}] Starting OpenCode process: ${this.bin} ${args.slice(0, 5).join(" ")}...`,
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
        stdio: ["pipe", "pipe", "pipe"],
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
        console.log(`[${runId}] Last stdout: ${stdoutSoFar || "(empty)"}`);
        console.log(`[${runId}] Last stderr: ${stderrSoFar || "(empty)"}`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000);
        reject(
          new Error(
            `opencode timed out after ${timeoutMs}ms (${elapsed}s elapsed). Last stderr: ${stderrSoFar || "(none)"}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          const shouldLog = !text.includes(
            "service=bus type=message.part.updated",
          );
          if (shouldLog) {
            console.log(`[${runId}] OpenCode stderr: ${text.slice(0, 200)}`);
          }
        }
        stderrChunks.push(Buffer.from(chunk));
      });

      child.on("error", (err) => {
        clearInterval(heartbeat);
        console.log(`[${runId}] OpenCode process error:`, err);
        reject(err);
      });

      child.on("close", (code) => {
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

    console.log(`[${runId}] OpenCode stdout size: ${stdout.length} chars`);
    if (stdout.length > 0 && stdout.length < 500) {
      console.log(`[${runId}] Raw stdout preview: ${stdout}`);
    } else if (stdout.length > 0) {
      // Show first 5 JSON lines for debugging large outputs
      const firstLines = stdout.split("\n").slice(0, 5).join("\n");
      console.log(`[${runId}] First 5 JSON lines:\n${firstLines}`);
    }

    const { sessionId, assistantText } = parseJsonLines(stdout);

    const webBase = process.env.OPENCODE_WEB_URL || "";
    console.log(
      `[${runId}] OpenCode parse result: sessionId=${sessionId ?? "(none)"}, assistantText length=${assistantText?.length ?? 0}`,
    );
    console.log(
      `[${runId}] Environment: OPENCODE_WEB_URL=${webBase ? webBase : "(not set)"}`,
    );
    console.log(`[${runId}] Working directory: ${workingDir}`);
    console.log(
      `[${runId}] Working directory exists: ${await fs.access(workingDir).then(
        () => true,
        () => false,
      )}`,
    );

    // Query the actual session directory that OpenCode used (it may differ from workingDir)
    let actualDirectory = workingDir;
    if (sessionId) {
      try {
        const { stdout: sessionJson } = await execFileAsync(
          this.bin,
          ["session", "list", "--format", "json"],
          { timeout: 5000 },
        );
        const sessions = JSON.parse(sessionJson);
        const session = sessions.find(
          (s: OpenCodeSessionWithId) => s.id === sessionId,
        );
        if (session?.directory) {
          actualDirectory = session.directory;
          console.log(
            `[${runId}] OpenCode session actual directory: ${actualDirectory}`,
          );
        }
      } catch (error) {
        console.log(
          `[${runId}] Warning: Could not query session directory: ${error}`,
        );
      }
    }

    const encodedPath = encodeRepoPath(actualDirectory);
    console.log(
      `[${runId}] Encoded path: ${encodedPath ? encodedPath.substring(0, 50) : "(empty)"}...`,
    );
    const sessionUrl =
      sessionId && webBase
        ? `${webBase.replace(/\/$/, "")}/${encodedPath || ""}/session/${sessionId}`
        : undefined;

    console.log(
      `[${runId}] Generated sessionUrl: ${sessionUrl ?? "(not generated)"}`,
    );

    let report = assistantText;
    if (!report && stdout) {
      console.log(
        `[${runId}] No assistantText found, trying fallback extraction...`,
      );
      const fallbackParts: string[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const text = extractTextFromObj(obj);
          if (text && text.length > 20) {
            fallbackParts.push(text);
          }
        } catch {
          // Not JSON, skip
        }
      }
      console.log(
        `[${runId}] Fallback extraction found ${fallbackParts.length} parts`,
      );
      report = fallbackParts.length > 0 ? fallbackParts.join("\n\n") : "";
    }

    console.log(
      `[${runId}] Final report: ${report?.length ?? 0} chars, sessionId: ${sessionId ?? "(none)"}`,
    );

    // Try reading the report file that OpenCode should have written
    try {
      await fs.access(reportFilePath);
      const fileContent = await fs.readFile(reportFilePath, "utf-8");
      const currentLength = report?.length ?? 0;
      if (fileContent.length > currentLength) {
        console.log(
          `[${runId}] Using report from file: ${fileContent.length} chars (vs stdout ${currentLength})`,
        );
        report = fileContent;
        await fs.unlink(reportFilePath);
      } else {
        console.log(
          `[${runId}] Report file exists but is shorter (${fileContent.length}) than stdout (${currentLength}), ignoring`,
        );
        console.log(
          `[${runId}] Report file content: ${fileContent.substring(0, 200)}...`,
        );
      }
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        console.log(`[${runId}] Report file not found at ${reportFilePath}`);
      } else {
        console.log(
          `[${runId}] Failed to read report file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      reportMarkdown: report || "No response received from OpenCode.",
      sessionId,
      sessionUrl,
      rawOutput: stdout,
    };
  }
}

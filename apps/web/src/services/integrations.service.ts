import axios from "axios";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import { PrismaService } from "./prisma.service";
import { envString } from "@/utils/env";

export type IntegrationName =
  | "datadog"
  | "github"
  | "confluence"
  | "jira"
  | "opencode"
  | "codex";

export interface IntegrationStatus {
  name: IntegrationName;
  configured: boolean;
  ok: boolean | null;
  message?: string;
  checkedAt?: string;
}

export class IntegrationsService {
  constructor(private prisma: PrismaService) {}

  private rootDir = path.resolve(__dirname, "../../../../..");
  private execFileAsync = promisify(execFile);

  private formatValue(value: string) {
    if (!value) return "";
    if (/[\s#]/.test(value)) {
      return `"${value.replace(/\"/g, '\\"')}"`;
    }
    return value;
  }

  private async updateEnvFile(
    filePath: string,
    updates: Record<string, string>,
  ) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      content = "";
    }
    const lines = content.split(/\r?\n/);
    const seen = new Set<string>();
    const updated = lines.map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      if (!match) return line;
      const key = match[1];
      if (updates[key] === undefined) return line;
      seen.add(key);
      return `${key}=${this.formatValue(updates[key])}`;
    });
    for (const [key, value] of Object.entries(updates)) {
      if (!seen.has(key)) updated.push(`${key}=${this.formatValue(value)}`);
    }
    await fs.writeFile(filePath, updated.join("\n"));
  }

  private getDatadogConfig() {
    const apiKey = envString("DATADOG_API_KEY") ?? "";
    const appKey = envString("DATADOG_APP_KEY") ?? "";
    const site = envString("DATADOG_SITE") ?? "datadoghq.com";
    const team = envString("ALERT_TEAM") ?? "";
    return { apiKey, appKey, site, team };
  }

  private getGithubConfig() {
    const token = envString("GITHUB_TOKEN") ?? "";
    return { token };
  }

  private getConfluenceConfig() {
    const atlassianBaseUrl = envString("ATLASSIAN_BASE_URL") ?? "";
    const baseUrl = atlassianBaseUrl
      ? `${atlassianBaseUrl.replace(/\/$/, "")}/wiki`
      : "";
    const user =
      envString("ATLASSIAN_USER") ?? envString("CONFLUENCE_USER") ?? "";
    const token =
      envString("ATLASSIAN_TOKEN") ?? envString("CONFLUENCE_TOKEN") ?? "";
    return { baseUrl, user, token };
  }

  private getJiraConfig() {
    const atlassianBaseUrl = envString("ATLASSIAN_BASE_URL") ?? "";
    const baseUrl = atlassianBaseUrl.replace(/\/$/, "");
    const user =
      envString("ATLASSIAN_USER") ?? envString("CONFLUENCE_USER") ?? "";
    const token =
      envString("ATLASSIAN_TOKEN") ?? envString("CONFLUENCE_TOKEN") ?? "";
    return { baseUrl, user, token };
  }

  private async recordCheck(
    name: IntegrationName,
    ok: boolean,
    message?: string,
  ) {
    await this.prisma.integrationCheck.create({
      data: {
        name,
        ok,
        message,
      },
    });
  }

  private async latestCheck(
    name: IntegrationName,
  ): Promise<IntegrationStatus | null> {
    const check = await this.prisma.integrationCheck.findFirst({
      where: { name },
      orderBy: { checkedAt: "desc" },
    });
    if (!check) return null;
    return {
      name,
      configured: true,
      ok: check.ok,
      message: check.message ?? undefined,
      checkedAt: check.checkedAt.toISOString(),
    };
  }

  private async ghLogin(): Promise<string | null> {
    try {
      const { stdout } = await this.execFileAsync(
        "gh",
        ["api", "user", "-q", ".login", "--hostname", "github.com"],
        {
          timeout: 5_000,
        },
      );
      const login = stdout.trim();
      return login ? login : null;
    } catch {
      return null;
    }
  }

  private resolveCodexBin() {
    const configured = envString("CODEX_BIN");
    if (configured) return configured;
    const which = spawnSync("which", ["codex"]);
    if (which.status === 0) {
      const resolved = String(which.stdout).trim();
      if (resolved) return resolved;
    }
    const appPath = "/Applications/Codex.app/Contents/Resources/codex";
    if (existsSync(appPath)) return appPath;
    return "";
  }

  private resolveOpenCodeBin() {
    const configured = envString("OPENCODE_BIN");
    if (configured) {
      if (existsSync(configured)) return configured;
      const which = spawnSync("which", [configured]);
      if (which.status === 0) {
        const resolved = String(which.stdout).trim();
        if (resolved) return resolved;
      }
    }
    const which = spawnSync("which", ["opencode"]);
    if (which.status === 0) {
      const resolved = String(which.stdout).trim();
      if (resolved) return resolved;
    }
    return "";
  }

  async getConfig() {
    return {
      datadogApiKey: envString("DATADOG_API_KEY") ?? "",
      datadogAppKey: envString("DATADOG_APP_KEY") ?? "",
      datadogSite: envString("DATADOG_SITE") ?? "datadoghq.com",
      alertTeam: envString("ALERT_TEAM") ?? "",
      githubToken: envString("GITHUB_TOKEN") ?? "",
      confluenceBaseUrl: envString("CONFLUENCE_BASE_URL") ?? "",
      confluenceUser:
        envString("ATLASSIAN_USER") ?? envString("CONFLUENCE_USER") ?? "",
      confluenceToken:
        envString("ATLASSIAN_TOKEN") ?? envString("CONFLUENCE_TOKEN") ?? "",
      provider: envString("PROVIDER") ?? "opencode",
      repoRoot: envString("REPO_ROOT") ?? "",
      opencodeWebUrl: envString("OPENCODE_WEB_URL") ?? "",
      codexBin: this.resolveCodexBin(),
      codexModel: envString("CODEX_MODEL") ?? "gpt-5.2-codex",
    };
  }

  async getStatuses(): Promise<IntegrationStatus[]> {
    const datadog = this.getDatadogConfig();
    const github = this.getGithubConfig();
    const confluence = this.getConfluenceConfig();
    const jira = this.getJiraConfig();
    const ghLogin = await this.ghLogin();

    const configured: Record<IntegrationName, boolean> = {
      datadog: Boolean(datadog.apiKey && datadog.appKey),
      github: Boolean(github.token || ghLogin),
      confluence: Boolean(
        confluence.baseUrl && confluence.user && confluence.token,
      ),
      jira: Boolean(jira.baseUrl && jira.user && jira.token),
      opencode: Boolean(this.resolveOpenCodeBin()),
      codex: Boolean(this.resolveCodexBin()),
    };

    const statuses: IntegrationStatus[] = [];
    for (const name of Object.keys(configured) as IntegrationName[]) {
      const latest = await this.latestCheck(name);
      if (latest) {
        statuses.push({
          ...latest,
          configured: configured[name],
        });
      } else {
        statuses.push({
          name,
          configured: configured[name],
          ok: null,
        });
      }
    }
    return statuses;
  }

  async test(
    name: IntegrationName,
    overrides?: Record<string, string>,
  ): Promise<IntegrationStatus> {
    if (name === "datadog") {
      const base = this.getDatadogConfig();
      const apiKey = overrides?.DATADOG_API_KEY ?? base.apiKey;
      const appKey = overrides?.DATADOG_APP_KEY ?? base.appKey;
      const site = overrides?.DATADOG_SITE ?? base.site;
      if (!apiKey || !appKey) {
        return {
          name,
          configured: false,
          ok: false,
          message: "Missing DATADOG_API_KEY or DATADOG_APP_KEY",
        };
      }
      try {
        const resp = await axios.get(`https://api.${site}/api/v1/validate`, {
          headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey },
        });
        const ok = Boolean(resp.data?.valid);
        await this.recordCheck(name, ok, ok ? "Validated" : "Invalid keys");
        return {
          name,
          configured: true,
          ok,
          message: ok ? "Validated" : "Invalid keys",
        };
      } catch (error: unknown) {
        let message = "Datadog check failed";
        if (error && typeof error === "object") {
          if (
            "response" in error &&
            typeof error.response === "object" &&
            error.response !== null
          ) {
            if (
              "data" in error.response &&
              typeof error.response.data === "object" &&
              error.response.data !== null
            ) {
              if (
                "errors" in error.response.data &&
                Array.isArray(error.response.data.errors)
              ) {
                message = error.response.data.errors.join(", ");
              }
            }
          } else if ("message" in error && typeof error.message === "string") {
            message = error.message;
          }
        }
        await this.recordCheck(name, false, message);
        return { name, configured: true, ok: false, message };
      }
    }

    if (name === "github") {
      const base = this.getGithubConfig();
      const token = overrides?.GITHUB_TOKEN ?? base.token;
      if (!token) {
        const login = await this.ghLogin();
        if (login) {
          await this.recordCheck(name, true, `Connected via gh as ${login}`);
          return {
            name,
            configured: true,
            ok: true,
            message: `Connected via gh as ${login}`,
          };
        }
        return {
          name,
          configured: false,
          ok: false,
          message: "Missing GITHUB_TOKEN (and gh auth not found)",
        };
      }
      try {
        const resp = await axios.get("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const login = resp.data?.login ?? "GitHub user";
        await this.recordCheck(name, true, `Connected as ${login}`);
        return {
          name,
          configured: true,
          ok: true,
          message: `Connected as ${login}`,
        };
      } catch (error: unknown) {
        let message = "GitHub check failed";
        if (error && typeof error === "object") {
          if (
            "response" in error &&
            typeof error.response === "object" &&
            error.response !== null
          ) {
            if (
              "data" in error.response &&
              typeof error.response.data === "object" &&
              error.response.data !== null
            ) {
              if (
                "message" in error.response.data &&
                typeof error.response.data.message === "string"
              ) {
                message = error.response.data.message;
              }
            }
          } else if ("message" in error && typeof error.message === "string") {
            message = error.message;
          }
        }
        await this.recordCheck(name, false, message);
        return { name, configured: true, ok: false, message };
      }
    }

    if (name === "confluence") {
      const base = this.getConfluenceConfig();
      const atlassianBaseUrl = overrides?.ATLASSIAN_BASE_URL;
      const baseUrl = atlassianBaseUrl
        ? `${atlassianBaseUrl.replace(/\/$/, "")}/wiki`
        : base.baseUrl;
      const user =
        overrides?.ATLASSIAN_USER ?? overrides?.CONFLUENCE_USER ?? base.user;
      const token =
        overrides?.ATLASSIAN_TOKEN ?? overrides?.CONFLUENCE_TOKEN ?? base.token;
      if (!baseUrl || !user || !token) {
        return {
          name,
          configured: false,
          ok: false,
          message:
            "Missing Atlassian URL or credentials (ATLASSIAN_BASE_URL and ATLASSIAN_USER/TOKEN)",
        };
      }
      try {
        const resp = await axios.get(
          `${baseUrl.replace(/\/$/, "")}/rest/api/space`,
          {
            auth: { username: user, password: token },
          },
        );
        const total = resp.data?.size ?? 0;
        await this.recordCheck(name, true, `Accessible spaces: ${total}`);
        return {
          name,
          configured: true,
          ok: true,
          message: `Accessible spaces: ${total}`,
        };
      } catch (error: unknown) {
        let message = "Confluence check failed";
        if (error && typeof error === "object") {
          if (
            "response" in error &&
            typeof error.response === "object" &&
            error.response !== null
          ) {
            if (
              "data" in error.response &&
              typeof error.response.data === "object" &&
              error.response.data !== null
            ) {
              if (
                "message" in error.response.data &&
                typeof error.response.data.message === "string"
              ) {
                message = error.response.data.message;
              }
            }
          } else if ("message" in error && typeof error.message === "string") {
            message = error.message;
          }
        }
        await this.recordCheck(name, false, message);
        return { name, configured: true, ok: false, message };
      }
    }

    if (name === "jira") {
      const base = this.getJiraConfig();
      const atlassianBaseUrl = overrides?.ATLASSIAN_BASE_URL;
      const baseUrl = atlassianBaseUrl
        ? atlassianBaseUrl.replace(/\/$/, "")
        : base.baseUrl;
      const user =
        overrides?.ATLASSIAN_USER ?? overrides?.CONFLUENCE_USER ?? base.user;
      const token =
        overrides?.ATLASSIAN_TOKEN ?? overrides?.CONFLUENCE_TOKEN ?? base.token;
      if (!baseUrl || !user || !token) {
        return {
          name,
          configured: false,
          ok: false,
          message:
            "Missing Atlassian URL or credentials (ATLASSIAN_BASE_URL and ATLASSIAN_USER/TOKEN)",
        };
      }
      const jiraUrl = baseUrl.replace(/\/$/, "");
      try {
        // Try v3 first (Atlassian Cloud), fall back to v2 (Server/DC)
        let resp: import("axios").AxiosResponse;
        try {
          // /rest/api/3/myself is deprecated, use /rest/api/3/user/current
          resp = await axios.get(`${jiraUrl}/rest/api/3/user/current`, {
            auth: { username: user, password: token },
          });
        } catch (v3Error: unknown) {
          // If v3 returns 410, URL likely points to Confluence or wrong service
          if (
            v3Error &&
            typeof v3Error === "object" &&
            "response" in v3Error &&
            typeof v3Error.response === "object" &&
            v3Error.response !== null &&
            "status" in v3Error.response &&
            v3Error.response.status === 410
          ) {
            return {
              name,
              configured: true,
              ok: false,
              message: `Jira check failed (410 Gone). JIRA_BASE_URL (${jiraUrl}) does not point to a valid Jira instance. For Atlassian Cloud, use: https://your-domain.atlassian.net (no /wiki)`,
            };
          }
          resp = await axios.get(`${jiraUrl}/rest/api/2/myself`, {
            auth: { username: user, password: token },
          });
        }
        const displayName = resp.data?.displayName ?? "JIRA user";
        await this.recordCheck(name, true, `Connected as ${displayName}`);
        return {
          name,
          configured: true,
          ok: true,
          message: `Connected as ${displayName}`,
        };
      } catch (error: unknown) {
        let message = "JIRA check failed";
        if (error && typeof error === "object") {
          if (
            "response" in error &&
            typeof error.response === "object" &&
            error.response !== null
          ) {
            if (
              "data" in error.response &&
              typeof error.response.data === "object" &&
              error.response.data !== null
            ) {
              if (
                "errorMessages" in error.response.data &&
                Array.isArray(error.response.data.errorMessages)
              ) {
                message = error.response.data.errorMessages.join(", ");
              }
            }
          } else if ("message" in error && typeof error.message === "string") {
            message = error.message;
          }
        }
        await this.recordCheck(name, false, message);
        return { name, configured: true, ok: false, message };
      }
    }

    if (name === "opencode") {
      const bin = this.resolveOpenCodeBin();
      if (!bin) {
        await this.recordCheck(name, false, "OpenCode CLI not found");
        return {
          name,
          configured: false,
          ok: false,
          message: "OpenCode CLI not found",
        };
      }
      await this.recordCheck(name, true, `CLI ready (${bin})`);
      return {
        name,
        configured: true,
        ok: true,
        message: `CLI ready (${bin})`,
      };
    }

    if (name === "codex") {
      const bin = this.resolveCodexBin();
      if (!bin) {
        await this.recordCheck(name, false, "Codex CLI not found");
        return {
          name,
          configured: false,
          ok: false,
          message: "Codex CLI not found",
        };
      }
      await this.recordCheck(name, true, `CLI ready (${bin})`);
      return {
        name,
        configured: true,
        ok: true,
        message: `CLI ready (${bin})`,
      };
    }

    return {
      name,
      configured: false,
      ok: false,
      message: "Unknown integration",
    };
  }

  async configure(payload: Record<string, unknown>) {
    const rootEnv = path.join(this.rootDir, ".env");
    const apiEnv = path.join(this.rootDir, "apps/api/.env");
    const webEnv = path.join(this.rootDir, "apps/web/.env.local");

    const updates: Record<string, string> = {};
    if (Object.prototype.hasOwnProperty.call(payload, "datadogApiKey")) {
      updates.DATADOG_API_KEY =
        typeof payload.datadogApiKey === "string" ? payload.datadogApiKey : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "datadogAppKey")) {
      updates.DATADOG_APP_KEY =
        typeof payload.datadogAppKey === "string" ? payload.datadogAppKey : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "datadogSite")) {
      updates.DATADOG_SITE =
        typeof payload.datadogSite === "string"
          ? payload.datadogSite
          : "datadoghq.com";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "alertTeam")) {
      updates.ALERT_TEAM =
        typeof payload.alertTeam === "string" ? payload.alertTeam : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "githubToken")) {
      updates.GITHUB_TOKEN =
        typeof payload.githubToken === "string" ? payload.githubToken : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "confluenceBaseUrl")) {
      updates.CONFLUENCE_BASE_URL =
        typeof payload.confluenceBaseUrl === "string"
          ? payload.confluenceBaseUrl
          : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "confluenceUser")) {
      updates.ATLASSIAN_USER =
        typeof payload.confluenceUser === "string"
          ? payload.confluenceUser
          : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "confluenceToken")) {
      updates.ATLASSIAN_TOKEN =
        typeof payload.confluenceToken === "string"
          ? payload.confluenceToken
          : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "provider")) {
      updates.PROVIDER =
        typeof payload.provider === "string" ? payload.provider : "opencode";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "repoRoot")) {
      updates.REPO_ROOT =
        typeof payload.repoRoot === "string" ? payload.repoRoot : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "opencodeWebUrl")) {
      updates.OPENCODE_WEB_URL =
        typeof payload.opencodeWebUrl === "string"
          ? payload.opencodeWebUrl
          : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "codexBin")) {
      updates.CODEX_BIN =
        typeof payload.codexBin === "string"
          ? payload.codexBin
          : this.resolveCodexBin();
    }
    if (Object.prototype.hasOwnProperty.call(payload, "codexModel")) {
      updates.CODEX_MODEL =
        typeof payload.codexModel === "string" ? payload.codexModel : "";
    }

    await this.updateEnvFile(rootEnv, updates);
    await this.updateEnvFile(apiEnv, updates);
    await fs.writeFile(
      webEnv,
      `NEXT_PUBLIC_API_URL=${typeof payload.apiUrl === "string" ? payload.apiUrl : "http://localhost:4000"}\n`,
    );

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) process.env[key] = value;
    }

    await this.prisma.appConfig.upsert({
      where: { id: "default" },
      update: {
        datadogApiKey: updates.DATADOG_API_KEY,
        datadogAppKey: updates.DATADOG_APP_KEY,
        datadogSite: updates.DATADOG_SITE,
        alertTeam: updates.ALERT_TEAM,
        githubToken: updates.GITHUB_TOKEN,
        confluenceBaseUrl: updates.CONFLUENCE_BASE_URL,
        confluenceUser: updates.ATLASSIAN_USER,
        confluenceToken: updates.ATLASSIAN_TOKEN,
        provider: updates.PROVIDER,
        repoRoot: updates.REPO_ROOT,
        opencodeWebUrl: updates.OPENCODE_WEB_URL,
        codexBin: updates.CODEX_BIN,
        codexModel: updates.CODEX_MODEL,
      },
      create: {
        id: "default",
        datadogApiKey: updates.DATADOG_API_KEY,
        datadogAppKey: updates.DATADOG_APP_KEY,
        datadogSite: updates.DATADOG_SITE,
        alertTeam: updates.ALERT_TEAM,
        githubToken: updates.GITHUB_TOKEN,
        confluenceBaseUrl: updates.CONFLUENCE_BASE_URL,
        confluenceUser: updates.ATLASSIAN_USER,
        confluenceToken: updates.ATLASSIAN_TOKEN,
        provider: updates.PROVIDER,
        repoRoot: updates.REPO_ROOT,
        opencodeWebUrl: updates.OPENCODE_WEB_URL,
        codexBin: updates.CODEX_BIN,
        codexModel: updates.CODEX_MODEL,
      },
    });

    return { ok: true };
  }
}

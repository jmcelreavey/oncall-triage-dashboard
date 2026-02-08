import { PrismaService } from "./prisma.service";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { envString, envBool } from "@/utils/env";
import {
  extractRepoNameFromMonitorName,
  buildRepoUrlFromPath,
} from "@/triage/utils";

export class MonitorRepoMappingService {
  private readonly defaultOrg = "businessinsider";
  private readonly confidenceThreshold = 0.6;

  constructor(private prisma: PrismaService) {}

  async autoDiscoverMappings(): Promise<{
    discovered: number;
    errors: string[];
  }> {
    if (!envBool("AUTO_DISCOVER_REPOS", false)) {
      return { discovered: 0, errors: ["Auto-discovery disabled"] };
    }

    const repoRoot = envString("REPO_ROOT");
    if (!repoRoot || !existsSync(repoRoot)) {
      return {
        discovered: 0,
        errors: ["REPO_ROOT not configured or does not exist"],
      };
    }

    try {
      const existingMappings = await this.prisma.monitorRepoMapping.findMany({
        where: { source: "auto" },
      });

      const existingMonitorIds = new Set(
        existingMappings.map((m) => m.monitorId),
      );
      const errors: string[] = [];
      let discovered = 0;

      const repos = this.scanRepos(repoRoot);

      for (const repoPath of repos) {
        try {
          const repoName = repoPath.split("/").pop() ?? "";
          const repoUrl = buildRepoUrlFromPath(repoPath, repoRoot);

          const candidateMonitors = await this.prisma.alertEvent.findMany({
            where: {
              monitorId: { not: null },
              monitorName: { not: "" },
            },
            distinct: ["monitorId", "monitorName"],
            take: 1000,
          });

          for (const monitor of candidateMonitors) {
            const guessedRepoName = extractRepoNameFromMonitorName(
              monitor.monitorName,
            );
            const service = monitor.service ?? undefined;

            if (!guessedRepoName) continue;

            const confidence = this.calculateConfidence(
              guessedRepoName,
              repoName,
              service,
            );

            if (confidence >= this.confidenceThreshold) {
              if (!existingMonitorIds.has(monitor.monitorId ?? "")) {
                await this.prisma.monitorRepoMapping.create({
                  data: {
                    monitorId: monitor.monitorId ?? "",
                    monitorName: monitor.monitorName,
                    service: monitor.service ?? undefined,
                    namespace: undefined,
                    repoPath,
                    repoUrl,
                    confidence,
                    source: "auto",
                    lastVerifiedAt: new Date(),
                  },
                });

                discovered++;
                existingMonitorIds.add(monitor.monitorId ?? "");
              }
            }
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          errors.push(`${repoPath}: ${errorMessage}`);
        }
      }

      return { discovered, errors };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return { discovered: 0, errors: [errorMessage] };
    }
  }

  async getRepoPathForMonitor(
    monitorId: string,
    monitorName: string,
    service?: string | null,
  ): Promise<string | null> {
    const mapping = await this.prisma.monitorRepoMapping.findFirst({
      where: {
        OR: [{ monitorId }, { monitorName }, ...(service ? [{ service }] : [])],
        confidence: { gte: this.confidenceThreshold },
      },
      orderBy: { confidence: "desc" },
    });

    if (mapping && existsSync(mapping.repoPath)) {
      return mapping.repoPath;
    }

    return null;
  }

  async createOrUpdateMapping(data: {
    monitorId: string;
    monitorName: string;
    service?: string;
    namespace?: string;
    repoPath: string;
    confidence?: number;
    source?: string;
  }) {
    const repoRoot = envString("REPO_ROOT");
    const repoUrl = buildRepoUrlFromPath(data.repoPath, repoRoot ?? "");

    return this.prisma.monitorRepoMapping.upsert({
      where: {
        monitorId_repoPath: {
          monitorId: data.monitorId,
          repoPath: data.repoPath,
        },
      },
      create: {
        monitorId: data.monitorId,
        monitorName: data.monitorName,
        service: data.service,
        namespace: data.namespace,
        repoPath: data.repoPath,
        repoUrl,
        confidence: data.confidence ?? 0.5,
        source: data.source ?? "manual",
        lastVerifiedAt: new Date(),
      },
      update: {
        service: data.service,
        namespace: data.namespace,
        confidence: data.confidence,
        lastVerifiedAt: new Date(),
      },
    });
  }

  async getAllMappings() {
    return this.prisma.monitorRepoMapping.findMany({
      orderBy: { confidence: "desc" },
    });
  }

  async deleteMapping(id: string) {
    return this.prisma.monitorRepoMapping.delete({
      where: { id },
    });
  }

  async refreshLowConfidenceMappings(): Promise<{ refreshed: number }> {
    const lowConfidenceMappings = await this.prisma.monitorRepoMapping.findMany(
      {
        where: {
          source: "auto",
          confidence: { lt: this.confidenceThreshold },
        },
      },
    );

    let refreshed = 0;
    const repoRoot = envString("REPO_ROOT");

    for (const mapping of lowConfidenceMappings) {
      if (!repoRoot) continue;

      const guessedRepoName = extractRepoNameFromMonitorName(
        mapping.monitorName,
      );
      const repoName = mapping.repoPath.split("/").pop() ?? "";

      const newConfidence = this.calculateConfidence(
        guessedRepoName ?? "",
        repoName,
        mapping.service ?? undefined,
      );

      if (newConfidence >= this.confidenceThreshold) {
        await this.prisma.monitorRepoMapping.update({
          where: { id: mapping.id },
          data: { confidence: newConfidence, lastVerifiedAt: new Date() },
        });
        refreshed++;
      }
    }

    return { refreshed };
  }

  private scanRepos(repoRoot: string): string[] {
    const repos: string[] = [];

    if (!existsSync(repoRoot)) {
      return repos;
    }

    const entries = readdirSync(repoRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(repoRoot, entry.name);
        if (existsSync(join(fullPath, ".git"))) {
          repos.push(fullPath);
        }

        const subEntries = readdirSync(fullPath, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (subEntry.isDirectory()) {
            const subFullPath = join(fullPath, subEntry.name);
            if (existsSync(join(subFullPath, ".git"))) {
              repos.push(subFullPath);
            }
          }
        }
      }
    }

    return repos;
  }

  private calculateConfidence(
    guessedRepoName: string,
    actualRepoName: string,
    service?: string,
  ): number {
    let confidence = 0.0;

    const guessedLower = guessedRepoName.toLowerCase();
    const actualLower = actualRepoName.toLowerCase();

    if (guessedLower === actualLower) {
      confidence += 0.8;
    } else if (
      actualLower.includes(guessedLower) ||
      guessedLower.includes(actualLower)
    ) {
      confidence += 0.6;
    }

    if (service) {
      const serviceLower = service.toLowerCase();
      if (actualLower.includes(serviceLower)) {
        confidence += 0.1;
      }
    }

    const commonPrefix = this.longestCommonPrefix(guessedLower, actualLower);
    if (commonPrefix.length >= 3) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  private longestCommonPrefix(a: string, b: string): string {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) {
      i++;
    }
    return a.slice(0, i);
  }
}

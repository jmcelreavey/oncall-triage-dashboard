import { TriageService } from "./triage.service";
import { prisma } from "./prisma.service";
import { MonitorRepoMappingService } from "./monitor-repo-mapping.service";

let triageServiceInstance: TriageService | null = null;
let isInitialized = false;

export function getTriageService(): TriageService {
  if (!triageServiceInstance) {
    const repoMappingService = new MonitorRepoMappingService(prisma);
    triageServiceInstance = new TriageService(prisma, repoMappingService);
  }
  return triageServiceInstance;
}

export async function ensureTriageServiceInitialized(): Promise<void> {
  if (isInitialized) return;
  
  const service = getTriageService();
  service.initialize();
  isInitialized = true;
}

export async function shutdownTriageService(): Promise<void> {
  if (triageServiceInstance) {
    await triageServiceInstance.shutdown();
    triageServiceInstance = null;
    isInitialized = false;
  }
}

// Initialize on module load (only works in server context)
if (typeof process !== 'undefined') {
  process.on('beforeExit', async () => {
    await shutdownTriageService();
  });
}

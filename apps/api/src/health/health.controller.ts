import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { envNumber } from '../config/env';

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async status() {
    const intervalMs = envNumber('TRIAGE_INTERVAL_MS', 60_000);
    const staleThreshold = envNumber(
      'TRIAGE_STALE_THRESHOLD_MS',
      intervalMs * 2,
    );
    const scheduler = await this.prisma.schedulerState.findUnique({
      where: { name: 'default' },
    });
    const now = Date.now();
    const lastRunAt = scheduler?.lastRunAt?.toISOString();
    const ageMs = scheduler?.lastRunAt
      ? now - scheduler.lastRunAt.getTime()
      : null;
    const stale = ageMs !== null ? ageMs > staleThreshold : true;

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      scheduler: {
        lastRunAt,
        lastSuccessAt: scheduler?.lastSuccessAt?.toISOString() ?? null,
        lastError: scheduler?.lastError ?? null,
        intervalMs,
        staleThresholdMs: staleThreshold,
        stale,
      },
    };
  }
}

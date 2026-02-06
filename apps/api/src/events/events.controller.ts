import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Controller('events')
export class EventsController {
  private clients: Set<Response> = new Set();
  private lastReports: any[] = [];

  constructor(private prisma: PrismaService) {
    this.startPolling();
  }

  @Get('stream')
  async stream(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial state
    res.write(
      `data: ${JSON.stringify({ type: 'initial', reports: this.lastReports })}\n\n`,
    );

    // Keep connection alive
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);

    // Store client for later cleanup
    this.clients.add(res);

    // Clean up on disconnect
    res.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  private async startPolling() {
    setInterval(async () => {
      const reports = await this.prisma.triageRun.findMany({
        include: {
          alert: {
            select: {
              monitorName: true,
              monitorState: true,
              priority: true,
              monitorUrl: true,
              service: true,
              environment: true,
              overallStateModified: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      const changed = this.reportsChanged(this.lastReports, reports);

      if (changed) {
        this.lastReports = reports;
        const data = `data: ${JSON.stringify({ type: 'update', reports })}\n\n`;

        for (const client of this.clients) {
          try {
            client.write(data);
          } catch {
            // Client disconnected, will be cleaned up on close event
          }
        }
      }
    }, 1000);
  }

  private reportsChanged(oldReports: any[], newReports: any[]): boolean {
    if (oldReports.length !== newReports.length) return true;

    for (let i = 0; i < oldReports.length; i++) {
      const old = oldReports[i];
      const newR = newReports[i];

      if (old.id !== newR.id) return true;
      if (old.status !== newR.status) return true;
      if (old.finishedAt?.toISOString() !== newR.finishedAt?.toISOString())
        return true;
    }

    return false;
  }
}

import { NextResponse } from "next/server";
import { prisma } from "@/services/prisma.service";
import { envNumber } from "@/utils/env";

export async function GET() {
  try {
    const intervalMs = envNumber("TRIAGE_INTERVAL_MS", 60_000);
    const staleThreshold = envNumber(
      "TRIAGE_STALE_THRESHOLD_MS",
      intervalMs * 2,
    );

    const scheduler = await prisma.schedulerState.findUnique({
      where: { name: "default" },
    });

    const now = Date.now();
    const lastRunAt = scheduler?.lastRunAt?.toISOString();
    const ageMs = scheduler?.lastRunAt
      ? now - scheduler.lastRunAt.getTime()
      : null;
    const stale = ageMs !== null ? ageMs > staleThreshold : true;

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("[Health] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Health check failed" },
      { status: 500 },
    );
  }
}

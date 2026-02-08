import { NextResponse } from "next/server";
import { prisma } from "@/services/prisma.service";

export async function POST() {
  try {
    console.warn("Clear all local data requested.");

    await prisma.triageRun.deleteMany({});
    await prisma.alertEvent.deleteMany({});

    console.warn("Cleared all triage runs and alerts.");

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    console.error("[Clear] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to clear local data",
      },
      { status: 500 },
    );
  }
}

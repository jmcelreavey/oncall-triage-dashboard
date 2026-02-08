import { NextResponse } from "next/server";
import {
  getTriageService,
  ensureTriageServiceInitialized,
} from "@/services/triage-manager";

export async function POST() {
  try {
    console.warn("Force clear running runs requested.");
    await ensureTriageServiceInitialized();
    const triageService = getTriageService();
    const result = await triageService.forceClearRunning();
    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to clear running runs",
      },
      { status: 500 },
    );
  }
}

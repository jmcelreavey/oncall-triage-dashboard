import { NextResponse } from "next/server";
import {
  getTriageService,
  ensureTriageServiceInitialized,
} from "@/services/triage-manager";

export async function POST() {
  try {
    await ensureTriageServiceInitialized();
    const triageService = getTriageService();
    const result = await triageService.triggerRun();
    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to trigger run",
      },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  getTriageService,
  ensureTriageServiceInitialized,
} from "@/services/triage-manager";

export async function POST() {
  try {
    console.log("Reprocess last error requested.");
    await ensureTriageServiceInitialized();
    const triageService = getTriageService();
    const result = await triageService.reprocessLastError();
    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reprocess last error",
      },
      { status: 500 },
    );
  }
}

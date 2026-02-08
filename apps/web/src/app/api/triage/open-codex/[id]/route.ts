import { NextResponse } from "next/server";
import {
  getTriageService,
  ensureTriageServiceInitialized,
} from "@/services/triage-manager";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await ensureTriageServiceInitialized();
    const triageService = getTriageService();
    const result = await triageService.openCodexSession(id);
    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to open Codex session",
      },
      { status: 500 },
    );
  }
}

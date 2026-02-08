import { NextResponse } from "next/server";
import { IntegrationsService } from "@/services/integrations.service";
import { prisma } from "@/services/prisma.service";

export async function GET() {
  try {
    const integrationsService = new IntegrationsService(prisma);
    const config = await integrationsService.getConfig();
    return NextResponse.json(config);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get config",
      },
      { status: 500 },
    );
  }
}

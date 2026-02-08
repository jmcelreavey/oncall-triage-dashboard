import { NextResponse } from "next/server";
import { IntegrationsService } from "@/services/integrations.service";
import { prisma } from "@/services/prisma.service";
import { z } from "zod";

const configureSchema = z.object({
  datadogApiKey: z.string().optional(),
  datadogAppKey: z.string().optional(),
  datadogSite: z.string().optional(),
  alertTeam: z.string().optional(),
  githubToken: z.string().optional(),
  confluenceBaseUrl: z.string().optional(),
  confluenceUser: z.string().optional(),
  confluenceToken: z.string().optional(),
  provider: z.string().optional(),
  repoRoot: z.string().optional(),
  opencodeWebUrl: z.string().optional(),
  codexBin: z.string().optional(),
  codexModel: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = configureSchema.parse(body);

    const integrationsService = new IntegrationsService(prisma);
    const result = await integrationsService.configure(parsed);

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "ZodError"
    ) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: "errors" in error ? error.errors : undefined,
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Configure failed" },
      { status: 500 },
    );
  }
}

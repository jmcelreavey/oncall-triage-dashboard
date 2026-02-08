import { NextResponse } from "next/server";
import { IntegrationsService } from "@/services/integrations.service";
import { prisma } from "@/services/prisma.service";
import { z } from "zod";
import type { IntegrationName } from "@/services/integrations.service";

const testSchema = z.object({
  name: z.enum([
    "datadog",
    "github",
    "confluence",
    "jira",
    "opencode",
    "codex",
  ]),
  overrides: z.record(z.string()).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = testSchema.parse(body);

    const integrationsService = new IntegrationsService(prisma);
    const result = await integrationsService.test(
      parsed.name as IntegrationName,
      parsed.overrides,
    );

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
      { error: error instanceof Error ? error.message : "Test failed" },
      { status: 500 },
    );
  }
}

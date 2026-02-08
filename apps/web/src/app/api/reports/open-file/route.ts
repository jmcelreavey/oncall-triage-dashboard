import { NextResponse } from "next/server";
import { ReportsService } from "@/services/reports.service";
import { prisma } from "@/services/prisma.service";
import { z } from "zod";

const openFileSchema = z.object({
  repoPath: z.string().optional(),
  path: z.string(),
  line: z.number().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = openFileSchema.parse(body);

    const reportsService = new ReportsService(prisma);
    const result = reportsService.openFile(parsed);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request body", details: error.errors },
        { status: 400 },
      );
    }

    console.error("[Reports] Error opening file:", error);
    return NextResponse.json({ error: "Failed to open file" }, { status: 500 });
  }
}

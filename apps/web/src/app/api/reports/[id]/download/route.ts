import { NextResponse } from "next/server";
import { ReportsService } from "@/services/reports.service";
import { prisma } from "@/services/prisma.service";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const reportsService = new ReportsService(prisma);
    const result = await reportsService.downloadFiles(id);

    if ("error" in result) {
      return NextResponse.json(result, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Reports] Error downloading files:", error);
    return NextResponse.json(
      { error: "Failed to download files" },
      { status: 500 },
    );
  }
}

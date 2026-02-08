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
    const report = await reportsService.get(id);

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    console.error("[Reports] Error getting report:", error);
    return NextResponse.json(
      { error: "Failed to get report" },
      { status: 500 },
    );
  }
}

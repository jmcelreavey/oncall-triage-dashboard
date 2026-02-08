import { NextResponse } from "next/server";
import { ReportsService } from "@/services/reports.service";
import { prisma } from "@/services/prisma.service";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);

    const reportsService = new ReportsService(prisma);
    const reports = await reportsService.list(limit);

    return NextResponse.json(reports);
  } catch (error) {
    console.error("[Reports] Error listing reports:", error);
    return NextResponse.json(
      { error: "Failed to list reports" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const reportsService = new ReportsService(prisma);
    const result = await reportsService.clear();

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Reports] Error clearing reports:", error);
    return NextResponse.json(
      { error: "Failed to clear reports" },
      { status: 500 },
    );
  }
}

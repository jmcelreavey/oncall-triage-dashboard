import { NextRequest } from "next/server";
import { prisma } from "@/services/prisma.service";

type Report = {
  id: string;
  createdAt: Date;
  status: string | null;
  error: string | null;
  finishedAt: Date | null;
  reportMarkdown: string | null;
  sessionId: string | null;
  sessionUrl: string | null;
  provider: string | null;
  alert: {
    monitorName: string | null;
    monitorState: string | null;
    priority: number | null;
    monitorUrl: string | null;
    service: string | null;
    environment: string | null;
    overallStateModified: Date | null;
    repoPath: string | null;
  } | null;
};

interface StreamData {
  type: "initial" | "update";
  reports: Report[];
  timestamp?: string;
}

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let lastReports: Report[] = [];

  const reportsChanged = (
    oldReports: Report[],
    newReports: Report[],
  ): boolean => {
    if (oldReports.length !== newReports.length) return true;

    for (let i = 0; i < oldReports.length; i++) {
      const old = oldReports[i];
      const newR = newReports[i];

      if (old.id !== newR.id) return true;
      if (old.status !== newR.status) return true;
      if (old.finishedAt?.toISOString() !== newR.finishedAt?.toISOString())
        return true;
    }

    return false;
  };

  const fetchData = async (): Promise<StreamData | null> => {
    try {
      const reports = await prisma.triageRun.findMany({
        include: {
          alert: {
            select: {
              monitorName: true,
              monitorState: true,
              priority: true,
              monitorUrl: true,
              service: true,
              environment: true,
              overallStateModified: true,
              repoPath: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      if (!reportsChanged(lastReports, reports)) return null;

      lastReports = reports;
      return {
        type: "update",
        reports,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("[Events] Polling error:", error);
      return null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const sendInitialData = async () => {
        const reports = await prisma.triageRun.findMany({
          include: {
            alert: {
              select: {
                monitorName: true,
                monitorState: true,
                priority: true,
                monitorUrl: true,
                service: true,
                environment: true,
                overallStateModified: true,
                repoPath: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        });

        const data: StreamData = {
          type: "initial",
          reports,
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      sendInitialData();

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      const polling = setInterval(async () => {
        const data = await fetchData();
        if (data) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            clearInterval(keepAlive);
            clearInterval(polling);
          }
        }
      }, 1000);

      req.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        clearInterval(polling);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

class PrismaService extends PrismaClient {
  private static instance: PrismaService;

  private constructor() {
    const url = process.env.DATABASE_URL ?? "file:./dev.db";

    const adapter = new PrismaLibSql({
      url,
      intMode: "number",
    });

    super({
      adapter,
      log: ["error", "warn"],
    });
  }

  static getInstance(): PrismaService {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaService();
    }

    return PrismaService.instance;
  }

  async initialize(): Promise<void> {
    await this.$connect();
    await this.$executeRawUnsafe("PRAGMA journal_mode = WAL;");
    await this.$executeRawUnsafe("PRAGMA synchronous = NORMAL;");
    await this.$executeRawUnsafe("PRAGMA wal_autocheckpoint = 0;");
  }

  async cleanup(): Promise<void> {
    await this.$disconnect();
  }
}

export { PrismaService };
export const prisma = PrismaService.getInstance();

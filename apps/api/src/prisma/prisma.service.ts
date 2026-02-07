import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';

    const adapter = new PrismaLibSql({
      url,
      intMode: 'number',
    });

    super({
      adapter,
      log: ['error', 'warn'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    await this.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
    await this.$executeRawUnsafe('PRAGMA synchronous = NORMAL;');
    await this.$executeRawUnsafe('PRAGMA wal_autocheckpoint = 0;');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

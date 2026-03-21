import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const datasourceUrl = process.env.DATABASE_URL;
    if (!datasourceUrl) {
      throw new Error(
        'DATABASE_URL is missing. Ensure apps/api/.env is loaded (or set DATABASE_URL in environment).',
      );
    }

    // Enable WAL journal mode so reads are never blocked by long write operations
    // (e.g. instrument sync). Must be set before Prisma connects.
    try {
      const dbPath = datasourceUrl.replace(/^file:/, '').split('?')[0];
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.close();
    } catch {
      // Non-fatal — WAL mode is an optimisation, not a requirement
    }

    super({
      adapter: new PrismaBetterSqlite3({
        url: datasourceUrl,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

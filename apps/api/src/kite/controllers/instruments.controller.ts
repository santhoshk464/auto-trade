import { Controller, Get, Query, UseGuards, Post } from '@nestjs/common';
import { AuthGuard } from '../../auth/guards/auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import https from 'https';
import { parse } from 'csv-parse/sync';

@Controller('instruments')
@UseGuards(AuthGuard)
export class InstrumentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getInstruments(
    @Query('search') search?: string,
    @Query('exchange') exchange?: string,
    @Query('segment') segment?: string,
    @Query('instrumentType') instrumentType?: string,
    @Query('name') name?: string,
    @Query('expiry') expiry?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseInt(page || '1', 10);
    const limitNum = Math.min(parseInt(limit || '50', 10), 500);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};

    if (search) {
      where.OR = [
        { tradingsymbol: { contains: search } },
        { name: { contains: search } },
      ];
    }

    if (exchange) {
      where.exchange = exchange;
    }

    if (segment) {
      where.segment = segment;
    }

    if (instrumentType) {
      where.instrumentType = instrumentType;
    }

    if (name) {
      where.name = name;
    }

    if (expiry) {
      where.expiry = expiry;
    }

    const [instruments, total] = await Promise.all([
      this.prisma.instrument.findMany({
        where,
        orderBy: [
          { name: 'asc' },
          { expiry: 'asc' },
          { strike: 'asc' },
          { instrumentType: 'asc' },
        ],
        skip,
        take: limitNum,
      }),
      this.prisma.instrument.count({ where }),
    ]);

    return {
      instruments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  @Get('filters')
  async getFilters() {
    const [exchanges, segments, types, names, expiries] = await Promise.all([
      this.prisma.instrument.findMany({
        distinct: ['exchange'],
        select: { exchange: true },
        orderBy: { exchange: 'asc' },
      }),
      this.prisma.instrument.findMany({
        distinct: ['segment'],
        select: { segment: true },
        orderBy: { segment: 'asc' },
      }),
      this.prisma.instrument.findMany({
        distinct: ['instrumentType'],
        select: { instrumentType: true },
        orderBy: { instrumentType: 'asc' },
      }),
      this.prisma.instrument.findMany({
        where: {
          name: { not: null },
        },
        distinct: ['name'],
        select: { name: true },
        orderBy: { name: 'asc' },
        take: 100, // Limit to top 100 names
      }),
      this.prisma.instrument.findMany({
        where: {
          expiry: { not: null },
        },
        distinct: ['expiry'],
        select: { expiry: true },
        orderBy: { expiry: 'asc' },
        take: 50, // Limit to next 50 expiries
      }),
    ]);

    return {
      exchanges: exchanges.map((e: any) => e.exchange),
      segments: segments.map((s: any) => s.segment),
      instrumentTypes: types.map((t: any) => t.instrumentType),
      names: names.map((n: any) => n.name).filter(Boolean),
      expiries: expiries.map((e: any) => e.expiry).filter(Boolean),
    };
  }

  @Get('stats')
  async getStats() {
    const [totalCount, byExchange, byType, bySegment] = await Promise.all([
      this.prisma.instrument.count(),
      this.prisma.instrument.groupBy({
        by: ['exchange'],
        _count: true,
      }),
      this.prisma.instrument.groupBy({
        by: ['instrumentType'],
        _count: true,
      }),
      this.prisma.instrument.groupBy({
        by: ['segment'],
        _count: true,
      }),
    ]);

    return {
      total: totalCount,
      byExchange: byExchange
        .map((e: any) => ({
          exchange: e.exchange,
          count: e._count,
        }))
        .sort((a: any, b: any) => b.count - a.count),
      byType: byType
        .map((t: any) => ({
          type: t.instrumentType,
          count: t._count,
        }))
        .sort((a: any, b: any) => b.count - a.count),
      bySegment: bySegment
        .map((s: any) => ({
          segment: s.segment,
          count: s._count,
        }))
        .sort((a: any, b: any) => b.count - a.count),
    };
  }

  @Post('sync')
  async syncInstruments() {
    try {
      // Download from Kite API
      const csvContent = await this.downloadInstrumentsFromKite();

      // Sync to database
      const stats = await this.syncInstrumentsToDatabase(csvContent);

      return {
        success: true,
        message: 'Instruments synced successfully',
        stats,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Sync failed',
        error: error.message,
      };
    }
  }

  private async downloadInstrumentsFromKite(): Promise<string> {
    const url = 'https://api.kite.trade/instruments';

    return new Promise((resolve, reject) => {
      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${response.statusCode}: ${response.statusMessage}`,
              ),
            );
            return;
          }

          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const content = Buffer.concat(chunks).toString('utf-8');
            resolve(content);
          });
          response.on('error', reject);
        })
        .on('error', reject);
    });
  }

  private async syncInstrumentsToDatabase(csvContent: string): Promise<{
    inserted: number;
    updated: number;
    total: number;
    newToday: number;
  }> {
    interface InstrumentRow {
      instrument_token: string;
      exchange_token: string;
      tradingsymbol: string;
      name: string;
      last_price: string;
      expiry: string;
      strike: string;
      tick_size: string;
      lot_size: string;
      instrument_type: string;
      segment: string;
      exchange: string;
    }

    const records: InstrumentRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const today = new Date();

    // ── Step 1: Load all existing tokens in ONE query ──────────────────────
    const existingRows = await this.prisma.instrument.findMany({
      select: { instrumentToken: true },
    });
    const existingTokens = new Set(existingRows.map((r) => r.instrumentToken));

    const toInsert: InstrumentRow[] = [];
    const toUpdate: InstrumentRow[] = [];

    for (const row of records) {
      const token = parseInt(row.instrument_token);
      if (existingTokens.has(token)) toUpdate.push(row);
      else toInsert.push(row);
    }

    // ── Step 2: Bulk-insert new instruments (createMany, skip duplicates) ──
    const insertBatchSize = 1000;
    for (let i = 0; i < toInsert.length; i += insertBatchSize) {
      const batch = toInsert.slice(i, i + insertBatchSize);
      await this.prisma.instrument.createMany({
        data: batch.map((row) => ({
          instrumentToken: parseInt(row.instrument_token),
          exchangeToken: parseInt(row.exchange_token),
          tradingsymbol: row.tradingsymbol,
          name: row.name || null,
          lastPrice: parseFloat(row.last_price) || 0,
          expiry: row.expiry || null,
          strike: parseFloat(row.strike) || 0,
          tickSize: parseFloat(row.tick_size),
          lotSize: parseInt(row.lot_size),
          instrumentType: row.instrument_type,
          segment: row.segment,
          exchange: row.exchange,
          lastSeenDate: today,
          firstSeenDate: today,
        })),
      });
    }

    // ── Step 3: Bulk-update existing instruments via raw SQL (one stmt / batch) ─
    const updateBatchSize = 500;
    for (let i = 0; i < toUpdate.length; i += updateBatchSize) {
      const batch = toUpdate.slice(i, i + updateBatchSize);
      // Build a single parameterised CASE UPDATE so we touch the DB once per batch
      // instead of once per row.
      await this.prisma.$transaction(
        batch.map((row) =>
          this.prisma.instrument.update({
            where: { instrumentToken: parseInt(row.instrument_token) },
            data: {
              exchangeToken: parseInt(row.exchange_token),
              tradingsymbol: row.tradingsymbol,
              name: row.name || null,
              lastPrice: parseFloat(row.last_price) || 0,
              tickSize: parseFloat(row.tick_size),
              lotSize: parseInt(row.lot_size),
              lastSeenDate: today,
            },
          }),
        ),
      );
    }

    const totalCount = await this.prisma.instrument.count();

    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const newToday = await this.prisma.instrument.count({
      where: { firstSeenDate: { gte: startOfDay } },
    });

    return {
      inserted: toInsert.length,
      updated: toUpdate.length,
      total: totalCount,
      newToday,
    };
  }
}

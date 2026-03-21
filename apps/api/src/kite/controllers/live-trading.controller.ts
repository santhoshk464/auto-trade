import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../../auth/guards/auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveTradingService } from '../services/live-trading.service';
import { KiteScheduler } from '../schedulers/kite.scheduler';

@Controller('live-trades')
@UseGuards(AuthGuard)
export class LiveTradingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveTradingService: LiveTradingService,
    private readonly kiteScheduler: KiteScheduler,
  ) {}

  /**
   * POST /live-trades/run-now
   * Manually triggers the scheduler logic (bypasses time guard).
   * Use this to test live order placement on demand.
   */
  @Post('run-now')
  async runNow(@Req() req: AuthenticatedRequest) {
    this.kiteScheduler
      .runNow()
      .catch((err) => console.error('run-now error:', err.message));
    return {
      message: '✅ Scheduler triggered. Check API logs for live order details.',
    };
  }

  /**
   * GET /live-trades
   * List all live trades for current user (optionally filter by status/date)
   */
  @Get()
  async getLiveTrades(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('date') date?: string,
  ) {
    const where: any = { userId: req.userId! };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      where.createdAt = { gte: start, lte: end };
    }

    const trades = await this.prisma.liveTrade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        broker: { select: { name: true, type: true } },
      },
    });

    return trades;
  }

  /**
   * GET /live-trades/active
   * Get currently active live trades
   */
  @Get('active')
  async getActiveTrades(@Req() req: AuthenticatedRequest) {
    const trades = await this.prisma.liveTrade.findMany({
      where: {
        userId: req.userId!,
        status: {
          in: [
            'PENDING_HEDGE',
            'PENDING_ENTRY',
            'PENDING_EXIT_ORDERS',
            'ACTIVE',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        broker: { select: { name: true, type: true } },
      },
    });

    return trades;
  }

  /**
   * GET /live-trades/stats
   * Summary stats for the current user
   */
  @Get('stats')
  async getStats(@Req() req: AuthenticatedRequest) {
    const [total, active, targetHit, slHit, squaredOff, failed] =
      await Promise.all([
        this.prisma.liveTrade.count({ where: { userId: req.userId! } }),
        this.prisma.liveTrade.count({
          where: {
            userId: req.userId!,
            status: {
              in: [
                'PENDING_HEDGE',
                'PENDING_ENTRY',
                'PENDING_EXIT_ORDERS',
                'ACTIVE',
              ],
            },
          },
        }),
        this.prisma.liveTrade.count({
          where: { userId: req.userId!, status: 'TARGET_HIT' },
        }),
        this.prisma.liveTrade.count({
          where: { userId: req.userId!, status: 'SL_HIT' },
        }),
        this.prisma.liveTrade.count({
          where: { userId: req.userId!, status: 'SQUARED_OFF' },
        }),
        this.prisma.liveTrade.count({
          where: { userId: req.userId!, status: 'FAILED' },
        }),
      ]);

    // Total realized PnL
    const pnlResult = await this.prisma.liveTrade.aggregate({
      where: {
        userId: req.userId!,
        pnl: { not: null },
      },
      _sum: { pnl: true },
    });

    return {
      total,
      active,
      targetHit,
      slHit,
      squaredOff,
      failed,
      totalPnl: pnlResult._sum.pnl ?? 0,
    };
  }

  /**
   * POST /live-trades/:id/square-off
   * Manually square off a specific live trade
   */
  @Post(':id/square-off')
  async squareOffTrade(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const trade = await this.prisma.liveTrade.findFirst({
      where: { id, userId: req.userId! },
    });

    if (!trade) {
      return { error: 'Trade not found' };
    }

    await this.liveTradingService.squareOffTrade(trade, 'Manual square-off');
    return { success: true };
  }
}

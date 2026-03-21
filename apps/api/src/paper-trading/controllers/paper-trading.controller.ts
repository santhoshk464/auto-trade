import {
  Controller,
  Get,
  Post,
  Body,
  Delete,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../../auth/guards/auth.guard';
import { PaperTradingService } from '../services/paper-trading.service';
import { PaperTradeStatus, SignalType } from '@prisma/client';

@Controller('paper-trading')
@UseGuards(AuthGuard)
export class PaperTradingController {
  constructor(private paperTradingService: PaperTradingService) {}

  /**
   * POST /paper-trading/create
   * Create a new paper trade
   */
  @Post('create')
  @UseGuards(AuthGuard)
  async createPaperTrade(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      brokerId: string;
      symbol: string;
      optionSymbol: string;
      instrumentToken: number;
      strike: number;
      optionType: string;
      expiryDate: string;
      signalType: SignalType;
      strategy: string;
      signalReason?: string;
      entryPrice: number;
      stopLoss: number;
      target1: number;
      target2: number;
      target3: number;
      quantity?: number;
      marginPoints?: number;
      interval?: string;
    },
  ) {
    return this.paperTradingService.createPaperTrade({
      userId: req.userId!,
      ...body,
    });
  }

  /**
   * GET /paper-trading
   * Get all paper trades for the current user
   */
  @Get()
  @UseGuards(AuthGuard)
  async getPaperTrades(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: PaperTradeStatus,
    @Query('strategy') strategy?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    const filters: any = {};

    if (status) {
      filters.status = status;
    }
    if (strategy) {
      filters.strategy = strategy;
    }
    if (fromDate) {
      filters.fromDate = new Date(fromDate);
    }
    if (toDate) {
      filters.toDate = new Date(toDate);
    }

    return this.paperTradingService.getUserPaperTrades(req.userId!, filters);
  }

  /**
   * GET /paper-trading/active
   * Get active paper trades
   */
  @Get('active')
  @UseGuards(AuthGuard)
  async getActiveTrades(@Req() req: AuthenticatedRequest) {
    return this.paperTradingService.getActiveTrades(req.userId!);
  }

  /**
   * GET /paper-trading/stats
   * Get P&L statistics
   */
  @Get('stats')
  @UseGuards(AuthGuard)
  async getPnLStats(
    @Req() req: AuthenticatedRequest,
    @Query('period') period?: 'daily' | 'weekly' | 'monthly' | 'all',
  ) {
    return this.paperTradingService.getPnLStats(req.userId!, period || 'all');
  }

  /**
   * GET /paper-trading/today-stats
   * Get today's trading statistics (for auto-trading dashboard)
   */
  @Get('today-stats')
  @UseGuards(AuthGuard)
  async getTodayStats(@Req() req: AuthenticatedRequest) {
    return this.paperTradingService.getTodayStats(req.userId!);
  }

  /**
   * POST /paper-trading/monitor
   * Monitor and update active trades
   */
  @Post('monitor')
  @UseGuards(AuthGuard)
  async monitorTrades(@Req() req: AuthenticatedRequest) {
    return this.paperTradingService.monitorAndUpdateTrades(req.userId!);
  }

  /**
   * DELETE /paper-trading/clear-all
   * Delete all paper trades for current user
   * NOTE: Must be defined BEFORE :id route to avoid route collision
   */
  @Delete('clear-all')
  @UseGuards(AuthGuard)
  async clearAllTrades(@Req() req: AuthenticatedRequest) {
    return this.paperTradingService.deleteAllTrades(req.userId!);
  }

  /**
   * DELETE /paper-trading/:id
   * Delete a paper trade
   */
  @Delete(':id')
  @UseGuards(AuthGuard)
  async deleteTrade(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.paperTradingService.deleteTrade(id, req.userId!);
    return { success: true, message: 'Trade deleted successfully' };
  }
}

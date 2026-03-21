import {
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
  Request,
  Header,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/guards/auth.guard';
import { SignalsService } from '../services/signals.service';

@Controller('signals')
@UseGuards(AuthGuard)
export class SignalsController {
  constructor(private readonly signalsService: SignalsService) {}

  /**
   * GET /signals?strategy=DAY_SELLING&date=2026-02-23
   * Returns all signals for a specific strategy and optional date
   */
  @Get()
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getSignals(
    @Request() req: any,
    @Query('strategy') strategy?: string,
    @Query('date') date?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.userId;
    const limitNum = limit ? parseInt(limit, 10) : 100;

    return this.signalsService.getSignals(userId, strategy, date, limitNum);
  }

  /**
   * GET /signals/latest?strategy=DAY_SELLING
   * Returns the latest signals grouped by strategy
   */
  @Get('latest')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getLatestSignals(
    @Request() req: any,
    @Query('strategy') strategy?: string,
  ) {
    const userId = req.userId;
    return this.signalsService.getLatestSignals(userId, strategy);
  }

  /**
   * GET /signals/stats
   * Returns statistics about signals
   */
  @Get('stats')
  async getSignalStats(@Request() req: any, @Query('date') date?: string) {
    const userId = req.userId;
    return this.signalsService.getSignalStats(userId, date);
  }

  /**
   * POST /signals/fix-unlinked
   * Links paper trades with their corresponding signals
   */
  @Post('fix-unlinked')
  async fixUnlinkedSignals(@Request() req: any) {
    const userId = req.userId;
    return this.signalsService.fixUnlinkedSignals(userId);
  }

  /**
   * DELETE /signals/today
   * Delete all of today's signals for the logged-in user
   */
  @Delete('today')
  async clearTodaySignals(@Request() req: any) {
    const userId = req.userId;
    return this.signalsService.clearTodaySignals(userId);
  }
}

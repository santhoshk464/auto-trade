import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeAdvisorService } from '../services/trade-advisor.service';
import { OiPollingService } from '../services/oi-polling.service';
import { TickStorageService } from '../services/tick-storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KiteGateway } from '../gateways/kite.gateway';

@Injectable()
export class AdvisorScheduler {
  private readonly logger = new Logger(AdvisorScheduler.name);

  constructor(
    private readonly tradeAdvisor: TradeAdvisorService,
    private readonly oiPolling: OiPollingService,
    private readonly tickStorage: TickStorageService,
    private readonly prisma: PrismaService,
    private readonly kiteGateway: KiteGateway,
  ) {}

  /**
   * Every minute during market hours (Mon–Fri 9:15 AM – 3:30 PM IST).
   * Runs the 1-min advisor analysis and sends WhatsApp update per active trade.
   */
  @Cron('* 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async oneMinuteAdvisorRun(): Promise<void> {
    if (!this.isMarketHours()) return;
    if (this.tradeAdvisor.getAdvisedTradeIds().length === 0) return;

    this.logger.debug('🤖 1-min advisor cycle');
    await this.tradeAdvisor.runOneMinuteAnalysis();

    // Push updated verdicts to all connected frontend clients
    this.broadcastVerdicts();

    // Detect and persist pattern events from the rolling window
    await this.detectPatterns();
  }

  /**
   * Every minute during market hours — push Kite price refresh signal to frontend.
   * Runs independently of whether any trades are being advised.
   */
  @Cron('* 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async broadcastKiteRefresh(): Promise<void> {
    if (!this.isMarketHours()) return;
    try {
      this.kiteGateway.broadcastRefresh('1min-price-tick');
    } catch (_) {}
  }

  /**
   * Every 5 minutes during market hours (Mon–Fri 9:15 AM – 3:30 PM IST).
   * Polls OI via Quote API + runs the deeper 5-min advisor analysis.
   */
  @Cron('*/5 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async fiveMinuteAdvisorRun(): Promise<void> {
    if (!this.isMarketHours()) return;

    // 1. Poll OI for all active strikes
    this.logger.debug('📊 5-min OI poll cycle');
    await this.oiPolling
      .pollAll()
      .catch((err) => this.logger.warn(`OI poll failed: ${err.message}`));

    // 2. Run advisor analysis with fresh OI data
    if (this.tradeAdvisor.getAdvisedTradeIds().length > 0) {
      this.logger.debug('🤖 5-min advisor cycle');
      await this.tradeAdvisor.runFiveMinuteAnalysis();
      this.broadcastVerdicts();
    }
    // Refresh already handled by broadcastKiteRefresh every minute
  }

  /**
   * Every 15 minutes — backfill ltpAfter15m for pattern events detected ~15 min ago.
   * This builds the accuracy dataset for future ML training.
   */
  @Cron('*/15 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async fillPatternConfirmations15m(): Promise<void> {
    if (!this.isMarketHours()) return;

    const tradeDate = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const windowStart = new Date(Date.now() - 16 * 60_000);
    const windowEnd = new Date(Date.now() - 14 * 60_000);

    const unfilled = await this.prisma.patternEvent.findMany({
      where: {
        tradeDate,
        detectedAt: { gte: windowStart, lte: windowEnd },
        ltpAfter15m: null,
      },
    });

    if (unfilled.length === 0) return;

    // For each unfilled pattern, look up current LTP from rolling state
    const tokenGroups = new Map<number, number[]>();
    for (const p of unfilled) {
      const arr = tokenGroups.get(p.instrumentToken) ?? [];
      arr.push(p.id);
      tokenGroups.set(p.instrumentToken, arr);
    }

    for (const [token, ids] of tokenGroups) {
      const state = this.tickStorage.getRollingState(token);
      const currentLTP = state?.ticks.slice(-1)[0]?.last_price;
      if (!currentLTP) continue;

      // Determine if pattern was "correct" based on price movement direction
      // Get the ltp at detection time
      const events = unfilled.filter((p) => ids.includes(p.id));
      for (const event of events) {
        const ltpAtDetection = event.ltpAtDetection;
        const priceMoved = currentLTP - ltpAtDetection;
        // OI_VELOCITY_SPIKE_DROP = expected price UP (short covering)
        // OI_VELOCITY_SPIKE_RISE = expected price UP direction for puts
        // ABSORPTION = expected price UP
        // ORDER_BOOK_FLIP_BULLISH = expected price UP
        // ORDER_BOOK_FLIP_BEARISH = expected price DOWN
        let wasCorrect: boolean | null = null;
        if (event.patternType === 'ORDER_BOOK_FLIP_BEARISH') {
          wasCorrect = priceMoved < -1;
        } else if (
          event.patternType.includes('BULLISH') ||
          event.patternType === 'ABSORPTION' ||
          event.patternType === 'OI_VELOCITY_SPIKE_DROP'
        ) {
          wasCorrect = priceMoved > 1;
        }

        await this.prisma.patternEvent.update({
          where: { id: event.id },
          data: { ltpAfter15m: currentLTP, wasCorrect },
        });
      }
    }

    this.logger.log(
      `🔍 Filled ltpAfter15m for ${unfilled.length} pattern event(s)`,
    );
  }

  /**
   * At 3:31 PM IST — clear all signal watchers and advisor state for market close.
   */
  @Cron('31 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async onMarketClose(): Promise<void> {
    this.logger.log('🔔 Market close — advisor cleanup');
    // OI polling auto-stops since no market activity; polled strikes remain until
    // next active trade. Nothing to forcibly clean up here.
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private broadcastVerdicts(): void {
    const ids = this.tradeAdvisor.getAdvisedTradeIds();
    if (ids.length === 0) return;
    const trades = ids.map((id) => ({
      liveTradeId: id,
      verdict: this.tradeAdvisor.getVerdict(id) ?? null,
    }));
    try {
      this.kiteGateway.broadcastAdvisorVerdicts(trades);
    } catch (err: any) {
      this.logger.error(`Broadcast verdicts failed: ${err.message}`);
    }
  }

  private async detectPatterns(): Promise<void> {
    const states = this.tickStorage.getAllRollingStates();
    const isExpiry = this.isTuesdayExpiry(new Date());
    for (const state of states) {
      await this.tickStorage
        .detectAndSavePatterns(state.instrumentToken, isExpiry)
        .catch(() => {});
    }
  }

  private isMarketHours(): boolean {
    const now = new Date();
    const ist = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    const h = ist.getHours();
    const m = ist.getMinutes();
    const totalMin = h * 60 + m;
    // 9:15 AM = 555, 3:30 PM = 930
    return totalMin >= 555 && totalMin <= 930;
  }

  private isTuesdayExpiry(date: Date): boolean {
    const ist = new Date(
      date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    return ist.getDay() === 2;
  }
}

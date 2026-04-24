import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Shape of a modeFull WebSocket tick from KiteTicker */
export interface FullTick {
  instrument_token: number;
  tradingsymbol?: string;
  last_price: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  volume?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  average_price?: number;
  timestamp?: Date;
}

/** Rolling window state maintained in memory per token (last N ticks) */
export interface TokenRollingState {
  instrumentToken: number;
  tradingsymbol: string;
  /** Circular buffer of last 10 ticks — newest at end */
  ticks: FullTick[];
  /** Computed deltas (OI change per tick) — parallel to ticks[1..] */
  oiDeltas: number[];
  /** Latest computed OI velocity (abs mean of last 5 deltas) */
  oiVelocityAvg: number;
  /** Latest detected pattern types (cleared each analysis cycle) */
  lastPatternTypes: string[];
  /** Timestamp of last tick stored to DB (for rate-limiting) */
  lastDbWriteAt: number;
}

@Injectable()
export class TickStorageService implements OnModuleDestroy {
  private readonly logger = new Logger(TickStorageService.name);

  // instrumentToken → rolling state
  private readonly rollingState = new Map<number, TokenRollingState>();

  // Pending tick rows to be batch-flushed to DB every 10 s
  private tickBuffer: Array<{
    instrumentToken: number;
    tradingsymbol: string;
    tradeDate: string;
    timestamp: Date;
    ltp: number;
    oi: number;
    oiDayHigh: number;
    oiDayLow: number;
    volume: number;
    buyQty: number;
    sellQty: number;
    avgPrice: number;
    isExpiry: boolean;
  }> = [];

  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Token → tradingsymbol mapping (populated by callers)
  private readonly symbolMap = new Map<number, string>();

  constructor(private readonly prisma: PrismaService) {
    // Flush tick buffer to DB every 10 seconds
    this.flushTimer = setInterval(() => {
      this.flushTickBuffer().catch((e) =>
        this.logger.error(`Tick flush error: ${e.message}`),
      );
    }, 10_000);
  }

  onModuleDestroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush on shutdown
    this.flushTickBuffer().catch(() => {});
  }

  /** Register a token → symbol mapping so ticks are stored with the symbol name */
  registerSymbol(instrumentToken: number, tradingsymbol: string): void {
    this.symbolMap.set(instrumentToken, tradingsymbol);
  }

  /**
   * Main entry point — called from KiteTickerService on every modeFull tick.
   * Updates rolling window, detects patterns, queues DB write.
   */
  ingestTick(tick: FullTick, isExpiry: boolean): void {
    const symbol =
      tick.tradingsymbol ??
      this.symbolMap.get(tick.instrument_token) ??
      String(tick.instrument_token);

    // ── Update rolling window ────────────────────────────────────────────────
    const state = this.getOrCreateState(tick.instrument_token, symbol);
    this.updateRollingWindow(state, tick);

    // ── Queue tick for DB (every tick goes into buffer) ──────────────────────
    const now = new Date();
    this.tickBuffer.push({
      instrumentToken: tick.instrument_token,
      tradingsymbol: symbol,
      tradeDate: this.toISTDateStr(now),
      timestamp: tick.timestamp ?? now,
      ltp: tick.last_price,
      oi: tick.oi ?? 0,
      oiDayHigh: tick.oi_day_high ?? 0,
      oiDayLow: tick.oi_day_low ?? 0,
      volume: tick.volume ?? 0,
      buyQty: tick.buy_quantity ?? 0,
      sellQty: tick.sell_quantity ?? 0,
      avgPrice: tick.average_price ?? 0,
      isExpiry,
    });

    // Cap buffer at 2,000 rows in case flush is delayed
    if (this.tickBuffer.length > 2_000) {
      this.tickBuffer.splice(0, 500); // drop oldest 500
    }
  }

  /** Detect patterns from rolling state and save PatternEvent rows */
  async detectAndSavePatterns(
    instrumentToken: number,
    isExpiry: boolean,
  ): Promise<string[]> {
    const state = this.rollingState.get(instrumentToken);
    if (!state || state.ticks.length < 5) return [];

    const detected: string[] = [];
    const now = new Date();
    const tradeDate = this.toISTDateStr(now);
    const latestTick = state.ticks[state.ticks.length - 1];

    // ── Pattern 1: OI Velocity Spike ────────────────────────────────────────
    // Latest OI delta is 3× faster than recent average → panic covering / building
    if (state.oiDeltas.length >= 4) {
      const recentDelta = state.oiDeltas[state.oiDeltas.length - 1];
      const avgPriorDeltas =
        state.oiDeltas.slice(-5, -1).reduce((s, d) => s + Math.abs(d), 0) / 4;

      if (avgPriorDeltas > 0 && Math.abs(recentDelta) > avgPriorDeltas * 3) {
        const type =
          recentDelta < 0 ? 'OI_VELOCITY_SPIKE_DROP' : 'OI_VELOCITY_SPIKE_RISE';
        detected.push(type);
        await this.savePatternEvent({
          instrumentToken,
          tradingsymbol: state.tradingsymbol,
          tradeDate,
          detectedAt: now,
          patternType: type,
          ltpAtDetection: latestTick.last_price,
          oiAtDetection: latestTick.oi ?? 0,
        }).catch(() => {});
      }
    }

    // ── Pattern 2: Volume Absorption ────────────────────────────────────────
    // High volume spike BUT price moved < 1% — buyers absorbing supply
    if (state.ticks.length >= 5) {
      const volumeHistory = state.ticks.slice(-5).map((t) => t.volume ?? 0);
      const priceHistory = state.ticks.slice(-5).map((t) => t.last_price);
      const latestVol = volumeHistory[4];
      const avgPriorVol =
        (volumeHistory[0] + volumeHistory[1] + volumeHistory[2]) / 3;
      const priceMove = Math.abs(priceHistory[4] - priceHistory[3]);
      const priceMovePct =
        priceHistory[3] > 0 ? (priceMove / priceHistory[3]) * 100 : 0;

      if (
        avgPriorVol > 0 &&
        latestVol > avgPriorVol * 3 &&
        priceMovePct < 0.5
      ) {
        detected.push('ABSORPTION');
        await this.savePatternEvent({
          instrumentToken,
          tradingsymbol: state.tradingsymbol,
          tradeDate,
          detectedAt: now,
          patternType: 'ABSORPTION',
          ltpAtDetection: latestTick.last_price,
          oiAtDetection: latestTick.oi ?? 0,
        }).catch(() => {});
      }
    }

    // ── Pattern 3: Order Book Flip ───────────────────────────────────────────
    // buyQty vs sellQty ratio flips significantly
    if (state.ticks.length >= 3) {
      const prev = state.ticks[state.ticks.length - 3];
      const curr = state.ticks[state.ticks.length - 1];
      const prevBuy = prev.buy_quantity ?? 0;
      const prevSell = prev.sell_quantity ?? 1;
      const currBuy = curr.buy_quantity ?? 0;
      const currSell = curr.sell_quantity ?? 1;
      const prevRatio = prevBuy / prevSell;
      const currRatio = currBuy / currSell;

      // Ratio flipped from buyer-dominated to seller-dominated or vice versa
      if (prevRatio < 0.8 && currRatio > 3.0) {
        detected.push('ORDER_BOOK_FLIP_BULLISH');
        await this.savePatternEvent({
          instrumentToken,
          tradingsymbol: state.tradingsymbol,
          tradeDate,
          detectedAt: now,
          patternType: 'ORDER_BOOK_FLIP_BULLISH',
          ltpAtDetection: latestTick.last_price,
          oiAtDetection: latestTick.oi ?? 0,
        }).catch(() => {});
      } else if (prevRatio > 3.0 && currRatio < 0.8) {
        detected.push('ORDER_BOOK_FLIP_BEARISH');
        await this.savePatternEvent({
          instrumentToken,
          tradingsymbol: state.tradingsymbol,
          tradeDate,
          detectedAt: now,
          patternType: 'ORDER_BOOK_FLIP_BEARISH',
          ltpAtDetection: latestTick.last_price,
          oiAtDetection: latestTick.oi ?? 0,
        }).catch(() => {});
      }
    }

    state.lastPatternTypes = detected;
    return detected;
  }

  /** Returns the current rolling state for a token (used by TradeAdvisorService) */
  getRollingState(instrumentToken: number): TokenRollingState | undefined {
    return this.rollingState.get(instrumentToken);
  }

  /** Returns all active rolling states */
  getAllRollingStates(): TokenRollingState[] {
    return Array.from(this.rollingState.values());
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private getOrCreateState(
    instrumentToken: number,
    tradingsymbol: string,
  ): TokenRollingState {
    if (!this.rollingState.has(instrumentToken)) {
      this.rollingState.set(instrumentToken, {
        instrumentToken,
        tradingsymbol,
        ticks: [],
        oiDeltas: [],
        oiVelocityAvg: 0,
        lastPatternTypes: [],
        lastDbWriteAt: 0,
      });
    }
    return this.rollingState.get(instrumentToken)!;
  }

  private updateRollingWindow(state: TokenRollingState, tick: FullTick): void {
    // Maintain last 10 ticks
    state.ticks.push(tick);
    if (state.ticks.length > 10) state.ticks.shift();

    // Track OI deltas
    if (state.ticks.length >= 2) {
      const prev = state.ticks[state.ticks.length - 2];
      const curr = state.ticks[state.ticks.length - 1];
      const delta = (curr.oi ?? 0) - (prev.oi ?? 0);
      state.oiDeltas.push(delta);
      if (state.oiDeltas.length > 10) state.oiDeltas.shift();

      // Recompute velocity average from last 5 deltas
      const last5 = state.oiDeltas.slice(-5);
      state.oiVelocityAvg =
        last5.reduce((s, d) => s + Math.abs(d), 0) / last5.length;
    }
  }

  private async flushTickBuffer(): Promise<void> {
    if (this.tickBuffer.length === 0) return;

    const batch = this.tickBuffer.splice(0, this.tickBuffer.length);
    try {
      await this.prisma.tickSnapshot.createMany({ data: batch });
      this.logger.debug(`💾 Flushed ${batch.length} tick(s) to DB`);
    } catch (err: any) {
      this.logger.error(`Tick flush DB error: ${err.message}`);
    }
  }

  private async savePatternEvent(data: {
    instrumentToken: number;
    tradingsymbol: string;
    tradeDate: string;
    detectedAt: Date;
    patternType: string;
    ltpAtDetection: number;
    oiAtDetection: number;
  }): Promise<void> {
    await this.prisma.patternEvent.create({ data });
    this.logger.log(
      `🔍 Pattern detected: ${data.patternType} | ${data.tradingsymbol} | LTP=₹${data.ltpAtDetection}`,
    );
  }

  private toISTDateStr(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }
}

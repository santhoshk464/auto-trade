import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { TickStorageService } from './tick-storage.service';
import { OiPollingService } from './oi-polling.service';

export interface AdvisorVerdict {
  action: 'HOLD' | 'CAUTION' | 'EXIT_WARNING';
  confidence: number; // 0–100
  reasons: string[];
  oiTrend:
    | 'BEARISH_BUILD'
    | 'BEARISH_UNWIND'
    | 'BULLISH_BUILD'
    | 'BULLISH_UNWIND'
    | 'NEUTRAL';
  oiVelocitySpike: boolean;
  orderBookFlipped: boolean;
  absorptionDetected: boolean;
  pcr: number | null;
  pcrTrend: 'RISING' | 'FALLING' | 'FLAT' | 'UNKNOWN';
  latestOI: number;
  latestLTP: number;
}

/** Active trade being advised */
interface AdvisedTrade {
  liveTradeId: string;
  optionSymbol: string;
  instrumentToken: number;
  niftyToken: number; // 256265 for Nifty 50
  strike: number;
  expiryDate: string;
  symbol: string;
  direction: 'SELL' | 'BUY';
  strategy: string;
  entryPrice: number;
  slPrice: number;
  targetPrice: number;
  entryOI: number;
  entryPCR: number | null;
  isExpiry: boolean;
  tradeDate: string;
  /** signalId for linking to TradeOutcome */
  signalId?: string;
}

// Nifty 50 index token — constant, never changes
const NIFTY_INDEX_TOKEN = 256265;

@Injectable()
export class TradeAdvisorService {
  private readonly logger = new Logger(TradeAdvisorService.name);

  // liveTradeId → AdvisedTrade
  private readonly advisedTrades = new Map<string, AdvisedTrade>();

  // Last verdict per trade (to detect changes)
  private readonly lastVerdicts = new Map<string, AdvisorVerdict>();

  // Throttle: last 1-min alert time per trade
  private readonly lastOneMinAlert = new Map<string, number>();

  // Throttle: last 5-min alert time per trade
  private readonly lastFiveMinAlert = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly tickStorage: TickStorageService,
    private readonly oiPolling: OiPollingService,
  ) {}

  /**
   * Register a live trade for advisory monitoring.
   * Call this when a LiveTrade becomes ACTIVE.
   */
  async startAdvisingTrade(params: {
    liveTradeId: string;
    optionSymbol: string;
    instrumentToken: number;
    strike: number;
    expiryDate: string;
    symbol: string;
    direction: 'SELL' | 'BUY';
    strategy: string;
    entryPrice: number;
    slPrice: number;
    targetPrice: number;
    brokerId: string;
    ceTradingsymbol: string;
    peTradingsymbol: string;
    signalId?: string;
  }): Promise<void> {
    if (this.advisedTrades.has(params.liveTradeId)) return;

    const now = new Date();
    const tradeDate = now.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const isExpiry = this.isTuesdayExpiry(now);

    // Snapshot current OI + PCR at entry
    const snap = this.oiPolling.getLatestSnapshot(
      params.symbol,
      params.strike,
      params.expiryDate,
    );
    const entryOI =
      this.tickStorage
        .getRollingState(params.instrumentToken)
        ?.ticks.slice(-1)[0]?.oi ?? 0;
    const entryPCR = snap?.pcr ?? null;

    // Register the OI poll (in case not already registered)
    this.oiPolling.registerStrike({
      brokerId: params.brokerId,
      symbol: params.symbol,
      strike: params.strike,
      expiryDate: params.expiryDate,
      ceTradingsymbol: params.ceTradingsymbol,
      peTradingsymbol: params.peTradingsymbol,
    });

    const trade: AdvisedTrade = {
      liveTradeId: params.liveTradeId,
      optionSymbol: params.optionSymbol,
      instrumentToken: params.instrumentToken,
      niftyToken: NIFTY_INDEX_TOKEN,
      strike: params.strike,
      expiryDate: params.expiryDate,
      symbol: params.symbol,
      direction: params.direction,
      strategy: params.strategy,
      entryPrice: params.entryPrice,
      slPrice: params.slPrice,
      targetPrice: params.targetPrice,
      entryOI,
      entryPCR,
      isExpiry,
      tradeDate,
      signalId: params.signalId,
    };

    this.advisedTrades.set(params.liveTradeId, trade);
    this.logger.log(
      `🤖 Advisor started for trade ${params.liveTradeId} | ${params.optionSymbol} | Entry OI: ${entryOI} | PCR: ${entryPCR?.toFixed(2) ?? 'N/A'}`,
    );

    // Save entry snapshot to TradeOutcome
    await this.upsertTradeOutcome(trade, 'ENTRY').catch(() => {});
  }

  /**
   * Stop advising a trade and record the exit snapshot.
   * Call this when a LiveTrade closes.
   */
  async stopAdvisingTrade(
    liveTradeId: string,
    exitPrice: number,
    outcome: 'TARGET_HIT' | 'SL_HIT' | 'MANUAL_EXIT' | 'EARLY_EXIT',
    exitReason?: string,
  ): Promise<void> {
    const trade = this.advisedTrades.get(liveTradeId);
    if (!trade) return;

    this.advisedTrades.delete(liveTradeId);
    this.lastVerdicts.delete(liveTradeId);
    this.lastOneMinAlert.delete(liveTradeId);
    this.lastFiveMinAlert.delete(liveTradeId);

    // Record exit snapshot
    const snap = this.oiPolling.getLatestSnapshot(
      trade.symbol,
      trade.strike,
      trade.expiryDate,
    );
    const exitState = this.tickStorage.getRollingState(trade.instrumentToken);
    const exitOI = exitState?.ticks.slice(-1)[0]?.oi ?? 0;
    const exitPCR = snap?.pcr ?? null;
    const niftyState = this.tickStorage.getRollingState(trade.niftyToken);
    const exitNiftyLTP = niftyState?.ticks.slice(-1)[0]?.last_price ?? null;

    const pnl =
      trade.direction === 'SELL'
        ? (trade.entryPrice - exitPrice) * 75 // approximate, qty from DB
        : (exitPrice - trade.entryPrice) * 75;

    await this.prisma.tradeOutcome
      .updateMany({
        where: { liveTradeId },
        data: {
          exitPrice,
          exitOI,
          exitPCR,
          exitNiftyLTP,
          outcome,
          pnl,
          exitReason: exitReason ?? outcome,
        },
      })
      .catch(() => {});

    this.logger.log(
      `🤖 Advisor stopped for trade ${liveTradeId} | outcome=${outcome} | exit=₹${exitPrice}`,
    );
  }

  /**
   * Run 1-minute advisory analysis on all active trades.
   * Called by AdvisorSchedulerService every minute during market hours.
   */
  async runOneMinuteAnalysis(): Promise<void> {
    if (this.advisedTrades.size === 0) return;

    const now = Date.now();
    for (const [tradeId, trade] of this.advisedTrades) {
      try {
        const verdict = this.buildVerdict(trade);
        if (!verdict) continue;

        // Only send 1-min alert if 55+ seconds have passed (avoid double-send)
        const lastAlert = this.lastOneMinAlert.get(tradeId) ?? 0;
        if (now - lastAlert < 55_000) continue;

        this.lastOneMinAlert.set(tradeId, now);
        this.lastVerdicts.set(tradeId, verdict);

        await this.whatsApp.sendAdvisorUpdate({
          interval: '1-MIN',
          trade,
          verdict,
        });
      } catch (err: any) {
        this.logger.error(`1-min advisor error for ${tradeId}: ${err.message}`);
      }
    }
  }

  /**
   * Run 5-minute advisory analysis — deeper analysis including PCR trend.
   * Called by AdvisorSchedulerService every 5 minutes during market hours.
   */
  async runFiveMinuteAnalysis(): Promise<void> {
    if (this.advisedTrades.size === 0) return;

    const now = Date.now();
    for (const [tradeId, trade] of this.advisedTrades) {
      try {
        const verdict = this.buildVerdict(trade);
        if (!verdict) continue;

        // Only send 5-min alert if 4.5+ min have passed
        const lastAlert = this.lastFiveMinAlert.get(tradeId) ?? 0;
        if (now - lastAlert < 270_000) continue;

        this.lastFiveMinAlert.set(tradeId, now);
        this.lastVerdicts.set(tradeId, verdict);

        await this.whatsApp.sendAdvisorUpdate({
          interval: '5-MIN',
          trade,
          verdict,
        });

        // Retroactively fill PatternEvent.ltpAfter5m for patterns detected ~5 min ago
        await this.fillPatternConfirmations(trade, 5).catch(() => {});
      } catch (err: any) {
        this.logger.error(`5-min advisor error for ${tradeId}: ${err.message}`);
      }
    }
  }

  /** Get current verdict for a trade (for REST API) */
  getVerdict(liveTradeId: string): AdvisorVerdict | undefined {
    return this.lastVerdicts.get(liveTradeId);
  }

  /** Get all active advised trade IDs */
  getAdvisedTradeIds(): string[] {
    return Array.from(this.advisedTrades.keys());
  }

  // ─── Core verdict logic ─────────────────────────────────────────────────────

  private buildVerdict(trade: AdvisedTrade): AdvisorVerdict | null {
    const optionState = this.tickStorage.getRollingState(trade.instrumentToken);
    if (!optionState || optionState.ticks.length < 3) return null;

    const latestTick = optionState.ticks[optionState.ticks.length - 1];
    const ltp = latestTick.last_price;
    const currentOI = latestTick.oi ?? 0;
    const isSell = trade.direction === 'SELL';

    const reasons: string[] = [];
    let score = 0; // higher = more HOLD-justified

    // ── Dimension 1: OI vs Price trend ──────────────────────────────────────
    const oiTrend = this.computeOITrend(optionState, trade, ltp, isSell);
    switch (oiTrend) {
      case 'BEARISH_BUILD': // Price ↓ + OI ↑ → writers adding → SELL PE holders benefit
        score += isSell ? 30 : -30;
        reasons.push(
          `OI building (${isSell ? 'bearish pressure ↑' : 'counter-trend'})`,
        );
        break;
      case 'BEARISH_UNWIND': // Price ↓ + OI ↓ → short covering → weak move
        score += isSell ? 10 : 5;
        reasons.push(
          `OI unwinding on down move (short covering — weak signal)`,
        );
        break;
      case 'BULLISH_BUILD': // Price ↑ + OI ↑ → bulls adding → bad for PE sellers
        score += isSell ? -25 : 25;
        reasons.push(
          `Fresh long build detected (${isSell ? 'counter-trend ⚠️' : 'trend confirmed ✅'})`,
        );
        break;
      case 'BULLISH_UNWIND': // Price ↑ + OI ↓ → long unwinding → pullback only
        score += isSell ? 20 : -10;
        reasons.push(
          `Pullback: OI falling on up move — short cover bounce (HOLD)`,
        );
        break;
      default:
        reasons.push('OI trend neutral');
    }

    // ── Dimension 2: OI velocity spike ──────────────────────────────────────
    const velSpike = this.detectVelocitySpike(optionState);
    if (velSpike === 'DROP_SPIKE') {
      // OI dropping fast — panic covering — price about to reverse UP
      score += isSell ? -20 : 15;
      reasons.push(
        '⚡ OI velocity spike DROP — panic covering (caution for SELL)',
      );
    } else if (velSpike === 'RISE_SPIKE') {
      // OI building fast — strong directional bet
      score += isSell ? 15 : -15;
      reasons.push('⚡ OI velocity spike RISE — strong position build');
    }
    const oiVelocitySpike = velSpike !== 'NONE';

    // ── Dimension 3: Order book imbalance ───────────────────────────────────
    const obRatio = this.computeOrderBookRatio(optionState);
    let orderBookFlipped = false;
    if (obRatio !== null) {
      if (obRatio > 3.0) {
        // Buyers dominating — bullish for option price (bad for PE seller)
        score += isSell ? -15 : 15;
        reasons.push(
          `Order book: Buyers ${obRatio.toFixed(1)}x Sellers (bullish pressure)`,
        );
        orderBookFlipped = isSell;
      } else if (obRatio < 0.5) {
        // Sellers dominating — bearish for option price (good for PE seller)
        score += isSell ? 15 : -15;
        reasons.push(
          `Order book: Sellers ${(1 / obRatio).toFixed(1)}x Buyers (bearish pressure)`,
        );
        orderBookFlipped = !isSell;
      }
    }

    // ── Dimension 4: PCR trend ───────────────────────────────────────────────
    const snap = this.oiPolling.getLatestSnapshot(
      trade.symbol,
      trade.strike,
      trade.expiryDate,
    );
    const pcr = snap?.pcr ?? null;
    let pcrTrend: AdvisorVerdict['pcrTrend'] = 'UNKNOWN';
    if (pcr !== null) {
      if (trade.entryPCR !== null) {
        const pcrDelta = pcr - (trade.entryPCR ?? pcr);
        if (pcrDelta > 0.1) {
          pcrTrend = 'RISING';
          score += isSell ? 15 : -10;
          reasons.push(
            `PCR rising (${trade.entryPCR?.toFixed(2)} → ${pcr.toFixed(2)}) — bearish bias maintained`,
          );
        } else if (pcrDelta < -0.1) {
          pcrTrend = 'FALLING';
          score += isSell ? -15 : 10;
          reasons.push(
            `PCR falling (${trade.entryPCR?.toFixed(2)} → ${pcr.toFixed(2)}) — bullish shift ⚠️`,
          );
        } else {
          pcrTrend = 'FLAT';
          reasons.push(`PCR stable at ${pcr.toFixed(2)}`);
        }
      }
    }

    // ── Dimension 5: OI change from entry ───────────────────────────────────
    if (trade.entryOI > 0 && currentOI > 0) {
      const oiChangePct = ((currentOI - trade.entryOI) / trade.entryOI) * 100;
      if (Math.abs(oiChangePct) > 5) {
        const dir = oiChangePct > 0 ? 'built up' : 'dropped';
        reasons.push(
          `OI ${dir} ${Math.abs(oiChangePct).toFixed(1)}% since entry (${trade.entryOI.toLocaleString()} → ${currentOI.toLocaleString()})`,
        );
      }
    }

    // ── Determine action ─────────────────────────────────────────────────────
    let action: AdvisorVerdict['action'];
    if (score >= 25) {
      action = 'HOLD';
    } else if (score >= 0) {
      action = 'CAUTION';
    } else {
      action = 'EXIT_WARNING';
    }

    return {
      action,
      confidence: Math.min(100, Math.max(0, 50 + score)),
      reasons,
      oiTrend,
      oiVelocitySpike,
      orderBookFlipped,
      absorptionDetected: optionState.lastPatternTypes.includes('ABSORPTION'),
      pcr,
      pcrTrend,
      latestOI: currentOI,
      latestLTP: ltp,
    };
  }

  private computeOITrend(
    state: ReturnType<typeof this.tickStorage.getRollingState>,
    trade: AdvisedTrade,
    ltp: number,
    isSell: boolean,
  ): AdvisorVerdict['oiTrend'] {
    if (!state || state.ticks.length < 3) return 'NEUTRAL';

    const first = state.ticks[0];
    const last = state.ticks[state.ticks.length - 1];
    const oiRising = (last.oi ?? 0) > (first.oi ?? 0);
    const priceFalling = last.last_price < first.last_price;
    const priceRising = last.last_price > first.last_price;

    if (priceFalling && oiRising) return 'BEARISH_BUILD';
    if (priceFalling && !oiRising) return 'BEARISH_UNWIND';
    if (priceRising && oiRising) return 'BULLISH_BUILD';
    if (priceRising && !oiRising) return 'BULLISH_UNWIND';
    return 'NEUTRAL';
  }

  private detectVelocitySpike(
    state: ReturnType<typeof this.tickStorage.getRollingState>,
  ): 'DROP_SPIKE' | 'RISE_SPIKE' | 'NONE' {
    if (!state || state.oiDeltas.length < 4) return 'NONE';

    const recent = state.oiDeltas[state.oiDeltas.length - 1];
    const avgPrior =
      state.oiDeltas.slice(-5, -1).reduce((s, d) => s + Math.abs(d), 0) / 4;

    if (avgPrior === 0) return 'NONE';
    if (Math.abs(recent) < avgPrior * 3) return 'NONE';

    return recent < 0 ? 'DROP_SPIKE' : 'RISE_SPIKE';
  }

  private computeOrderBookRatio(
    state: ReturnType<typeof this.tickStorage.getRollingState>,
  ): number | null {
    if (!state || state.ticks.length === 0) return null;
    const latest = state.ticks[state.ticks.length - 1];
    const buyQty = latest.buy_quantity ?? 0;
    const sellQty = latest.sell_quantity ?? 0;
    if (sellQty === 0) return null;
    return buyQty / sellQty;
  }

  // ─── TradeOutcome persistence ────────────────────────────────────────────────

  private async upsertTradeOutcome(
    trade: AdvisedTrade,
    phase: 'ENTRY',
  ): Promise<void> {
    const niftyState = this.tickStorage.getRollingState(trade.niftyToken);
    const entryNiftyLTP = niftyState?.ticks.slice(-1)[0]?.last_price ?? null;
    const snap = this.oiPolling.getLatestSnapshot(
      trade.symbol,
      trade.strike,
      trade.expiryDate,
    );
    const optionState = this.tickStorage.getRollingState(trade.instrumentToken);
    const entryOIVelocity = optionState?.oiVelocityAvg ?? null;
    const entryBuyQty = optionState?.ticks.slice(-1)[0]?.buy_quantity ?? null;
    const entrySellQty = optionState?.ticks.slice(-1)[0]?.sell_quantity ?? null;
    const entryVolume = optionState?.ticks.slice(-1)[0]?.volume ?? null;

    // Upsert — create if not exists (idempotent)
    const existing = await this.prisma.tradeOutcome.findFirst({
      where: { liveTradeId: trade.liveTradeId },
    });
    if (existing) return;

    await this.prisma.tradeOutcome.create({
      data: {
        liveTradeId: trade.liveTradeId,
        signalId: trade.signalId ?? null,
        symbol: trade.symbol,
        optionSymbol: trade.optionSymbol,
        direction: trade.direction,
        tradeDate: trade.tradeDate,
        isExpiry: trade.isExpiry,
        entryPrice: trade.entryPrice,
        entryOI: trade.entryOI,
        entryPCR: trade.entryPCR,
        entryOIVelocity,
        entryBuyQty,
        entrySellQty,
        entryVolume,
        entryNiftyLTP,
      },
    });
  }

  private async fillPatternConfirmations(
    trade: AdvisedTrade,
    minutesAgo: number,
  ): Promise<void> {
    // Find pattern events from ~minutesAgo that have no ltpAfter5m filled yet
    const windowStart = new Date(Date.now() - (minutesAgo + 1) * 60_000);
    const windowEnd = new Date(Date.now() - (minutesAgo - 1) * 60_000);
    const tradeDate = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });

    const unfilled = await this.prisma.patternEvent.findMany({
      where: {
        instrumentToken: trade.instrumentToken,
        tradeDate,
        detectedAt: { gte: windowStart, lte: windowEnd },
        ltpAfter5m: null,
      },
    });

    if (unfilled.length === 0) return;

    const state = this.tickStorage.getRollingState(trade.instrumentToken);
    const currentLTP = state?.ticks.slice(-1)[0]?.last_price;
    if (!currentLTP) return;

    await this.prisma.patternEvent.updateMany({
      where: { id: { in: unfilled.map((p) => p.id) } },
      data: { ltpAfter5m: currentLTP },
    });
  }

  private isTuesdayExpiry(date: Date): boolean {
    // Nifty expires every Tuesday (day 2 in JS)
    const istDate = new Date(
      date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    return istDate.getDay() === 2;
  }
}

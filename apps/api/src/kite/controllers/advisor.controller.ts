import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { KiteConnect } from 'kiteconnect';
import { TradeAdvisorService } from '../services/trade-advisor.service';
import { OiPollingService } from '../services/oi-polling.service';
import { TickStorageService } from '../services/tick-storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { KiteGateway } from '../gateways/kite.gateway';
import { AuthGuard } from '../../auth/guards/auth.guard';

@UseGuards(AuthGuard)
@Controller('advisor')
export class AdvisorController {
  constructor(
    private readonly tradeAdvisor: TradeAdvisorService,
    private readonly oiPolling: OiPollingService,
    private readonly tickStorage: TickStorageService,
    private readonly prisma: PrismaService,
    private readonly kiteGateway: KiteGateway,
  ) {}

  /**
   * POST /advisor/test-broadcast
   * Dev/test: manually fire all advisor push events so the frontend
   * can be verified without waiting for the market-hours cron.
   */
  @Post('test-broadcast')
  testBroadcast() {
    const ids = this.tradeAdvisor.getAdvisedTradeIds();
    const trades = ids.map((id) => ({
      liveTradeId: id,
      verdict: this.tradeAdvisor.getVerdict(id) ?? null,
    }));
    this.kiteGateway.broadcastAdvisorVerdicts(trades);
    this.kiteGateway.broadcastRefresh('test-broadcast');
    return {
      ok: true,
      emittedVerdicts: trades.length,
      emittedRefresh: true,
      hint: 'Watch the advisor page header timestamp update and Active Verdicts refresh',
    };
  }

  /**
   * GET /advisor/active-trades
   * Returns the current rolling state + verdict for every advised trade.
   */
  @Get('active-trades')
  getActiveTrades() {
    const ids = this.tradeAdvisor.getAdvisedTradeIds();
    return ids.map((id) => ({
      liveTradeId: id,
      verdict: this.tradeAdvisor.getVerdict(id) ?? null,
    }));
  }

  /**
   * GET /advisor/verdict/:liveTradeId
   * Returns the latest verdict for a specific live trade.
   */
  @Get('verdict/:liveTradeId')
  getVerdict(@Param('liveTradeId') liveTradeId: string) {
    const verdict = this.tradeAdvisor.getVerdict(liveTradeId);
    if (!verdict) return { message: 'No active advisory for this trade' };
    return verdict;
  }

  /**
   * GET /advisor/tick-data/:token?date=YYYY-MM-DD
   * Returns raw tick snapshots for a token on a given date (today if omitted).
   */
  @Get('tick-data/:token')
  async getTickData(
    @Param('token') token: string,
    @Query('date') date?: string,
  ) {
    const tradeDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const ticks = await this.prisma.tickSnapshot.findMany({
      where: { instrumentToken: parseInt(token, 10), tradeDate },
      orderBy: { timestamp: 'asc' },
      take: 5000,
    });
    return { date: tradeDate, count: ticks.length, ticks };
  }

  /**
   * GET /advisor/rolling-state/:token
   * Returns the in-memory rolling window (last 10 ticks + OI deltas) for a token.
   */
  @Get('rolling-state/:token')
  getRollingState(@Param('token') token: string) {
    const state = this.tickStorage.getRollingState(parseInt(token, 10));
    if (!state) return { message: 'No rolling state for this token' };
    return {
      instrumentToken: state.instrumentToken,
      tradingsymbol: state.tradingsymbol,
      tickCount: state.ticks.length,
      latestLTP: state.ticks.slice(-1)[0]?.last_price,
      latestOI: state.ticks.slice(-1)[0]?.oi,
      oiDeltaHistory: state.oiDeltas,
      oiVelocityAvg: state.oiVelocityAvg,
      lastPatterns: state.lastPatternTypes,
    };
  }

  /**
   * GET /advisor/oi-snapshots?symbol=NIFTY&strike=24500&expiry=2026-04-21&date=YYYY-MM-DD
   * Returns the PCR history for a strike on a given date.
   */
  @Get('oi-snapshots')
  async getOiSnapshots(
    @Query('symbol') symbol: string,
    @Query('strike') strike: string,
    @Query('expiry') expiry: string,
    @Query('date') date?: string,
  ) {
    if (!symbol || !strike || !expiry) {
      return { error: 'symbol, strike and expiry are required' };
    }
    const tradeDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const snapshots = await this.oiPolling.getTodaySnapshots(
      symbol,
      parseFloat(strike),
      expiry,
    );
    return { date: tradeDate, count: snapshots.length, snapshots };
  }

  /**
   * GET /advisor/patterns?date=YYYY-MM-DD&token=256265
   * Returns detected pattern events for today (or given date).
   */
  @Get('patterns')
  async getPatterns(
    @Query('date') date?: string,
    @Query('token') token?: string,
  ) {
    const tradeDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const where: any = { tradeDate };
    if (token) where.instrumentToken = parseInt(token, 10);

    const patterns = await this.prisma.patternEvent.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: 200,
    });
    return { date: tradeDate, count: patterns.length, patterns };
  }

  /**
   * GET /advisor/trade-outcomes?date=YYYY-MM-DD&symbol=NIFTY
   * Returns historical TradeOutcome records (the ML training dataset).
   */
  @Get('trade-outcomes')
  async getTradeOutcomes(
    @Query('date') date?: string,
    @Query('symbol') symbol?: string,
    @Query('outcome') outcome?: string,
  ) {
    const where: any = {};
    if (date) where.tradeDate = date;
    if (symbol) where.symbol = symbol;
    if (outcome) where.outcome = outcome;

    const outcomes = await this.prisma.tradeOutcome.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { count: outcomes.length, outcomes };
  }

  /**
   * GET /advisor/pattern-accuracy
   * Returns pattern accuracy stats — what % of each pattern type was "correct".
   */
  @Get('pattern-accuracy')
  async getPatternAccuracy() {
    const patterns = await this.prisma.patternEvent.findMany({
      where: { wasCorrect: { not: null } },
    });

    const stats: Record<
      string,
      { total: number; correct: number; accuracy: number }
    > = {};

    for (const p of patterns) {
      if (!stats[p.patternType]) {
        stats[p.patternType] = { total: 0, correct: 0, accuracy: 0 };
      }
      stats[p.patternType].total++;
      if (p.wasCorrect) stats[p.patternType].correct++;
    }

    for (const key of Object.keys(stats)) {
      const s = stats[key];
      s.accuracy = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
    }

    return { totalPatterns: patterns.length, stats };
  }

  /**
   * GET /advisor/historic-analysis?date=YYYY-MM-DD
   * Returns all LiveTrades for a date joined with:
   *  - StrikeSelection (CE/PE tokens + symbols)
   *  - OI snapshots for CE and PE tokens
   *  - Pattern events for those tokens
   *  - TradeOutcome record (if saved)
   *  - Tick summary (first/last OI, min/max LTP, tick count)
   */
  @Get('historic-analysis')
  async getHistoricAnalysis(@Query('date') date?: string) {
    const tradeDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // 1. Load all LiveTrades created on this date
    const dayStart = new Date(`${tradeDate}T00:00:00+05:30`);
    const dayEnd = new Date(`${tradeDate}T23:59:59+05:30`);

    const liveTrades = await this.prisma.liveTrade.findMany({
      where: { createdAt: { gte: dayStart, lte: dayEnd } },
      orderBy: { createdAt: 'asc' },
    });

    if (liveTrades.length === 0) return { date: tradeDate, trades: [] };

    // 2. Load StrikeSelections for the date — keyed by brokerId+symbol
    const strikeSelections = await this.prisma.strikeSelection.findMany({
      where: { date: tradeDate },
    });
    const ssMap = new Map(
      strikeSelections.map((s) => [`${s.brokerId}:${s.symbol}`, s]),
    );

    // 3. Collect all instrument tokens involved (CE + PE)
    const allTokens = new Set<number>();
    for (const ss of strikeSelections) {
      allTokens.add(ss.ceInstrumentToken);
      allTokens.add(ss.peInstrumentToken);
    }
    // Also add tokens from LiveTrades directly
    for (const t of liveTrades) {
      allTokens.add(t.instrumentToken);
    }
    const tokenList = Array.from(allTokens);

    // 4. Load OI snapshots, patterns, and tick summaries for all tokens
    const [oiSnapshots, patternEvents, tickSummaries, tradeOutcomes] =
      await Promise.all([
        this.prisma.oiSnapshot.findMany({
          where: { tradeDate },
          orderBy: { timestamp: 'asc' },
        }),
        this.prisma.patternEvent.findMany({
          where: { instrumentToken: { in: tokenList }, tradeDate },
          orderBy: { detectedAt: 'asc' },
        }),
        // Aggregate tick stats per token
        Promise.all(
          tokenList.map(async (token) => {
            const ticks = await this.prisma.tickSnapshot.findMany({
              where: { instrumentToken: token, tradeDate },
              orderBy: { timestamp: 'asc' },
              select: {
                timestamp: true,
                ltp: true,
                oi: true,
                volume: true,
                buyQty: true,
                sellQty: true,
              },
            });
            if (ticks.length === 0) return { token, ticks: 0 };
            const ltps = ticks.map((t) => t.ltp);
            const ois = ticks.map((t) => t.oi);
            return {
              token,
              ticks: ticks.length,
              firstOI: ois[0],
              lastOI: ois[ois.length - 1],
              oiChange: ois[ois.length - 1] - ois[0],
              minLTP: Math.min(...ltps),
              maxLTP: Math.max(...ltps),
              firstLTP: ltps[0],
              lastLTP: ltps[ltps.length - 1],
              firstTime: ticks[0].timestamp,
              lastTime: ticks[ticks.length - 1].timestamp,
              totalVolume: ticks[ticks.length - 1]?.volume ?? 0,
            };
          }),
        ),
        this.prisma.tradeOutcome.findMany({
          where: { tradeDate },
        }),
      ]);

    // Index tick summaries and outcomes by token / liveTradeId
    const tickMap = new Map(tickSummaries.map((s) => [s.token, s]));
    const outcomeMap = new Map(
      tradeOutcomes.map((o) => [o.liveTradeId ?? '', o]),
    );

    // 5. Build enriched trade records
    const trades = liveTrades.map((t) => {
      const ss = ssMap.get(`${t.brokerId}:${t.symbol}`);
      const outcome = outcomeMap.get(t.id) ?? null;

      // Patterns for this option's token
      const tokenPatterns = patternEvents.filter(
        (p) => p.instrumentToken === t.instrumentToken,
      );

      // Tick summary for this option token
      const tickSummary = tickMap.get(t.instrumentToken) ?? null;

      // OI snapshots for CE and PE (from StrikeSelection)
      const ceSnapshots = ss
        ? oiSnapshots.filter(
            (o) =>
              o.symbol === t.symbol &&
              Math.abs(o.strike - ss.ceStrike) < 1 &&
              o.expiryDate === t.expiryDate,
          )
        : [];

      // PCR history from OiSnapshot for this strike
      const pcrHistory = oiSnapshots
        .filter(
          (o) =>
            o.symbol === t.symbol &&
            Math.abs(o.strike - t.strike) < 1 &&
            o.expiryDate === t.expiryDate,
        )
        .map((o) => ({
          time: o.timestamp,
          pcr: o.pcr,
          ceOI: o.ceOI,
          peOI: o.peOI,
        }));

      // Compute verdict from saved outcome data
      const entryOI = outcome?.entryOI ?? tickSummary?.firstOI ?? null;
      const exitOI = outcome?.exitOI ?? tickSummary?.lastOI ?? null;
      const oiChange =
        entryOI != null && exitOI != null ? exitOI - entryOI : null;

      // Simple retrospective assessment
      let retrospectiveVerdict: 'PROFITABLE' | 'LOSS' | 'BREAKEVEN' | 'OPEN' =
        'OPEN';
      if (t.status === 'TARGET_HIT') retrospectiveVerdict = 'PROFITABLE';
      else if (t.status === 'SL_HIT') retrospectiveVerdict = 'LOSS';
      else if (
        t.pnl != null &&
        (t.status === 'SQUARED_OFF' || t.status === ('DONE' as any))
      ) {
        retrospectiveVerdict =
          t.pnl > 0 ? 'PROFITABLE' : t.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
      }

      return {
        trade: {
          id: t.id,
          symbol: t.symbol,
          optionSymbol: t.optionSymbol,
          strike: t.strike,
          optionType: t.optionType,
          expiryDate: t.expiryDate,
          strategy: t.strategy,
          status: t.status,
          entryFilledPrice: t.entryFilledPrice,
          exitPrice: t.exitPrice,
          targetPrice: t.targetPrice,
          slPrice: t.slPrice,
          pnl: t.pnl,
          createdAt: t.createdAt,
          entryFilledTime: t.entryFilledTime,
          exitTime: t.exitTime,
        },
        strikeSelection: ss
          ? {
              atmStrike: ss.atmStrike,
              niftySpotAtOpen: ss.niftySpotAtOpen,
              ceTradingSymbol: ss.ceTradingSymbol,
              ceStrike: ss.ceStrike,
              peTradingSymbol: ss.peTradingSymbol,
              peStrike: ss.peStrike,
            }
          : null,
        tickSummary,
        patterns: tokenPatterns,
        pcrHistory,
        outcome,
        retrospectiveVerdict,
        oiChange,
        entryOI,
        exitOI,
      };
    });

    return { date: tradeDate, count: trades.length, trades };
  }

  /**
   * GET /advisor/kite-strike-analysis?date=YYYY-MM-DD
   * Reads StrikeSelections for a date, calls Kite Quote API live for each
   * CE+PE token, and returns full OI/PCR/volume/depth analysis.
   * Works even when no tick/OI snapshots are saved locally.
   */
  @Get('kite-strike-analysis')
  async getKiteStrikeAnalysis(@Query('date') date?: string) {
    const tradeDate =
      date ??
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // 1. Load all StrikeSelections for this date
    const selections = await this.prisma.strikeSelection.findMany({
      where: { date: tradeDate },
      include: { broker: true },
    });

    if (selections.length === 0) {
      return {
        date: tradeDate,
        count: 0,
        message: 'No strike selections found for this date',
        results: [],
      };
    }

    const results = await Promise.all(
      selections.map(async (ss) => {
        const broker = ss.broker;
        if (!broker?.accessToken || !broker?.apiKey) {
          return {
            symbol: ss.symbol,
            date: ss.date,
            expiry: ss.expiry,
            atmStrike: ss.atmStrike,
            niftySpotAtOpen: ss.niftySpotAtOpen,
            ceSymbol: ss.ceTradingSymbol,
            peSymbol: ss.peTradingSymbol,
            ceStrike: ss.ceStrike,
            peStrike: ss.peStrike,
            error: 'No access token for broker',
            brokerName: broker?.name ?? 'Unknown',
          };
        }

        try {
          const kc = new KiteConnect({ api_key: broker.apiKey });
          kc.setAccessToken(broker.accessToken);

          const ceKey = `NFO:${ss.ceTradingSymbol}`;
          const peKey = `NFO:${ss.peTradingSymbol}`;

          const quotes = await kc.getQuote([ceKey, peKey]);
          const ce = quotes[ceKey];
          const pe = quotes[peKey];

          if (!ce || !pe) {
            return {
              symbol: ss.symbol,
              ceSymbol: ss.ceTradingSymbol,
              peSymbol: ss.peTradingSymbol,
              error: 'Quote not found',
            };
          }

          const ceOI = ce.oi ?? 0;
          const peOI = pe.oi ?? 0;
          const pcr = ceOI > 0 ? peOI / ceOI : 0;

          // Depth totals: sum all 5 levels
          const ceBuyQty = (ce.depth?.buy ?? []).reduce(
            (s: number, d: any) => s + (d.quantity ?? 0),
            0,
          );
          const ceSellQty = (ce.depth?.sell ?? []).reduce(
            (s: number, d: any) => s + (d.quantity ?? 0),
            0,
          );
          const peBuyQty = (pe.depth?.buy ?? []).reduce(
            (s: number, d: any) => s + (d.quantity ?? 0),
            0,
          );
          const peSellQty = (pe.depth?.sell ?? []).reduce(
            (s: number, d: any) => s + (d.quantity ?? 0),
            0,
          );

          // OI interpretation
          let pcrSignal = 'NEUTRAL';
          if (pcr >= 1.3)
            pcrSignal = 'BULLISH'; // heavy put writing = support
          else if (pcr >= 1.0) pcrSignal = 'MILD_BULLISH';
          else if (pcr <= 0.7)
            pcrSignal = 'BEARISH'; // heavy call writing = resistance
          else if (pcr <= 0.9) pcrSignal = 'MILD_BEARISH';

          // OI day change (open vs close proxy)
          const ceOIDayChange =
            (ce.oi_day_high ?? ceOI) - (ce.oi_day_low ?? ceOI);
          const peOIDayChange =
            (pe.oi_day_high ?? peOI) - (pe.oi_day_low ?? peOI);

          // Volume analysis
          const ceBuySellRatio = ceSellQty > 0 ? ceBuyQty / ceSellQty : null;
          const peBuySellRatio = peSellQty > 0 ? peBuyQty / peSellQty : null;

          // LTP move from open
          const ceLTPChange = ce.last_price - (ce.ohlc?.open ?? ce.last_price);
          const peLTPChange = pe.last_price - (pe.ohlc?.open ?? pe.last_price);

          // Expiry check — same date as expiry
          const isExpiryDay = ss.expiry === tradeDate;

          // ── Market direction verdict ─────────────────────────────────────
          let verdict = 'NEUTRAL';
          const verdictReasons: string[] = [];
          let score = 0;

          if (pcr >= 1.2) {
            score += 2;
            verdictReasons.push(
              `PCR ${pcr.toFixed(2)} — put writers defending (bullish)`,
            );
          } else if (pcr <= 0.8) {
            score -= 2;
            verdictReasons.push(
              `PCR ${pcr.toFixed(2)} — call writers defending (bearish)`,
            );
          } else {
            verdictReasons.push(`PCR ${pcr.toFixed(2)} — neutral zone`);
          }

          if (peOI > ceOI * 1.3) {
            score += 1;
            verdictReasons.push(
              `PE OI ${(peOI / 1e5).toFixed(0)}L >> CE OI — strong put writing`,
            );
          } else if (ceOI > peOI * 1.3) {
            score -= 1;
            verdictReasons.push(
              `CE OI ${(ceOI / 1e5).toFixed(0)}L >> PE OI — strong call writing`,
            );
          }

          if (peLTPChange < -2 && peLTPChange < ceLTPChange) {
            score -= 1;
            verdictReasons.push(
              `PE fell ${peLTPChange.toFixed(0)} pts from open — sellers dominant`,
            );
          }
          if (ceLTPChange < -2 && ceLTPChange < peLTPChange) {
            score += 1;
            verdictReasons.push(
              `CE fell ${ceLTPChange.toFixed(0)} pts from open — buyers dominant`,
            );
          }

          if (score >= 2) verdict = 'BULLISH';
          else if (score >= 1) verdict = 'MILD_BULLISH';
          else if (score <= -2) verdict = 'BEARISH';
          else if (score <= -1) verdict = 'MILD_BEARISH';

          // ── Trade-side recommendations ───────────────────────────────────
          // CE SELL position: you profit when CE price falls / stays low
          type TradeAction = 'HOLD' | 'CAUTION' | 'EXIT_WARNING';
          const ceSellAdvice: {
            action: TradeAction;
            reasons: string[];
            confidence: number;
          } = (() => {
            const reasons: string[] = [];
            let pts = 0;

            // CE price very high = bad for CE seller
            if (ce.last_price >= 100) {
              pts -= 3;
              reasons.push(
                `❌ CE LTP ${ce.last_price.toFixed(0)} is high — position at risk`,
              );
            } else if (ce.last_price >= 50) {
              pts -= 1;
              reasons.push(
                `⚠️ CE LTP ${ce.last_price.toFixed(0)} — monitor closely`,
              );
            } else {
              pts += 2;
              reasons.push(
                `✅ CE LTP ${ce.last_price.toFixed(0)} — decaying well`,
              );
            }

            // CE OI rising = more writers joining = support for CE seller
            if (ceOIDayChange > 0) {
              pts += 1;
              reasons.push(
                `✅ CE OI added ${(ceOIDayChange / 1e5).toFixed(1)}L today — more writers = resistance holding`,
              );
            } else if (ceOIDayChange < 0) {
              pts -= 1;
              reasons.push(
                `⚠️ CE OI shed ${(Math.abs(ceOIDayChange) / 1e5).toFixed(1)}L — call unwinding, potential squeeze`,
              );
            }

            // Order book for CE — if sell side dominates, CE will continue falling
            if (ceBuySellRatio !== null) {
              if (ceBuySellRatio < 0.7) {
                pts += 1;
                reasons.push(
                  `✅ CE order book: more sellers (B/S ${ceBuySellRatio.toFixed(2)}) — downward pressure`,
                );
              } else if (ceBuySellRatio > 1.5) {
                pts -= 1;
                reasons.push(
                  `⚠️ CE order book: buyers dominating (B/S ${ceBuySellRatio.toFixed(2)}) — possible CE spike`,
                );
              }
            }

            // PCR > 1: market bullish = CE writers safe
            if (pcr >= 1.2) {
              pts += 1;
              reasons.push(
                `✅ PCR ${pcr.toFixed(2)} — market bullish, CE sellers protected`,
              );
            } else if (pcr < 0.8) {
              pts -= 1;
              reasons.push(
                `⚠️ PCR ${pcr.toFixed(2)} — bearish tilt, CE sellers at risk`,
              );
            }

            // Expiry day: CE near zero = safe
            if (isExpiryDay && ce.last_price < 10) {
              pts += 2;
              reasons.push(
                `✅ Expiry day — CE at ${ce.last_price.toFixed(1)}, near worthless`,
              );
            }

            const action: TradeAction =
              pts >= 3 ? 'HOLD' : pts >= 1 ? 'CAUTION' : 'EXIT_WARNING';
            const confidence = Math.min(100, Math.max(0, 50 + pts * 12));
            return { action, reasons, confidence };
          })();

          // PE SELL position: you profit when PE price falls / stays low
          const peSellAdvice: {
            action: TradeAction;
            reasons: string[];
            confidence: number;
          } = (() => {
            const reasons: string[] = [];
            let pts = 0;

            // PE price very high = bad for PE seller
            if (pe.last_price >= 100) {
              pts -= 3;
              reasons.push(
                `❌ PE LTP ${pe.last_price.toFixed(0)} is high — position at risk`,
              );
            } else if (pe.last_price >= 50) {
              pts -= 1;
              reasons.push(
                `⚠️ PE LTP ${pe.last_price.toFixed(0)} — monitor closely`,
              );
            } else {
              pts += 2;
              reasons.push(
                `✅ PE LTP ${pe.last_price.toFixed(1)} — decaying well`,
              );
            }

            // PE OI rising = more put writers = bullish for market = PE seller safe
            if (peOIDayChange > 0) {
              pts += 1;
              reasons.push(
                `✅ PE OI added ${(peOIDayChange / 1e7).toFixed(1)}Cr today — put writers adding = support for PE seller`,
              );
            } else if (peOIDayChange < 0) {
              pts -= 1;
              reasons.push(
                `⚠️ PE OI shed ${(Math.abs(peOIDayChange) / 1e7).toFixed(1)}Cr — unwinding, possible put reversal`,
              );
            }

            // Order book for PE — sell dominance = PE stays down = safe for seller
            if (peBuySellRatio !== null) {
              if (peBuySellRatio < 0.7) {
                pts += 1;
                reasons.push(
                  `✅ PE order book: sellers dominating (B/S ${peBuySellRatio.toFixed(2)}) — downward pressure`,
                );
              } else if (peBuySellRatio > 1.5) {
                pts -= 1;
                reasons.push(
                  `⚠️ PE order book: buyers aggressive (B/S ${peBuySellRatio.toFixed(2)}) — possible PE bounce`,
                );
              }
            }

            // PCR > 1 = bullish market = PE sellers safe
            if (pcr >= 1.2) {
              pts += 1;
              reasons.push(
                `✅ PCR ${pcr.toFixed(2)} — strong put writing, PE sellers protected`,
              );
            } else if (pcr < 0.8) {
              pts -= 1;
              reasons.push(
                `⚠️ PCR ${pcr.toFixed(2)} — puts getting bid up, PE seller under pressure`,
              );
            }

            // Expiry day: PE near zero = safe
            if (isExpiryDay && pe.last_price < 10) {
              pts += 2;
              reasons.push(
                `✅ Expiry day — PE at ${pe.last_price.toFixed(1)}, near worthless`,
              );
            }

            const action: TradeAction =
              pts >= 3 ? 'HOLD' : pts >= 1 ? 'CAUTION' : 'EXIT_WARNING';
            const confidence = Math.min(100, Math.max(0, 50 + pts * 12));
            return { action, reasons, confidence };
          })();

          // CE BUY position: you profit when CE price rises (market goes up)
          const ceBuyAdvice: {
            action: TradeAction;
            reasons: string[];
            confidence: number;
          } = (() => {
            const reasons: string[] = [];
            let pts = 0;

            // CE falling from open = bad for CE buyer
            if (ceLTPChange <= -50) {
              pts -= 3;
              reasons.push(
                `❌ CE down ${Math.abs(ceLTPChange).toFixed(0)} pts from open — strong downtrend, CE buyers losing`,
              );
            } else if (ceLTPChange <= -20) {
              pts -= 1;
              reasons.push(
                `⚠️ CE down ${Math.abs(ceLTPChange).toFixed(0)} pts from open — bearish, watch closely`,
              );
            } else if (ceLTPChange >= 20) {
              pts += 2;
              reasons.push(
                `✅ CE up ${ceLTPChange.toFixed(0)} pts from open — momentum with CE buyers`,
              );
            }

            // PCR < 0.8 = call writers dominant = bad for CE buyer
            if (pcr >= 1.2) {
              pts += 2;
              reasons.push(
                `✅ PCR ${pcr.toFixed(2)} — market bullish, CE buyers protected`,
              );
            } else if (pcr < 0.8) {
              pts -= 2;
              reasons.push(
                `❌ PCR ${pcr.toFixed(2)} — call writers defending, bad for CE buyers`,
              );
            }

            // CE OI rising + CE falling = fresh call writing = bad for CE buyer
            if (ceOIDayChange > 0 && ceLTPChange < 0) {
              pts -= 1;
              reasons.push(
                `❌ CE OI rising while price falling — call writers adding resistance`,
              );
            } else if (ceOIDayChange > 0 && ceLTPChange > 0) {
              pts += 1;
              reasons.push(
                `✅ CE OI rising with price — fresh longs building, bullish`,
              );
            } else if (ceOIDayChange < 0 && ceLTPChange > 0) {
              pts += 1;
              reasons.push(
                `✅ CE OI unwinding on up move — short covering, price can extend`,
              );
            }

            // Order book: buyers dominating = good for CE buyer
            if (ceBuySellRatio !== null) {
              if (ceBuySellRatio > 1.5) {
                pts += 1;
                reasons.push(
                  `✅ CE order book: buyers dominating (B/S ${ceBuySellRatio.toFixed(2)}) — upward pressure`,
                );
              } else if (ceBuySellRatio < 0.7) {
                pts -= 1;
                reasons.push(
                  `❌ CE order book: sellers dominating (B/S ${ceBuySellRatio.toFixed(2)}) — downward pressure`,
                );
              }
            }

            // Expiry day: CE has to rally hard to profit — extra risk
            if (isExpiryDay) {
              pts -= 1;
              reasons.push(
                `⚠️ Expiry day — CE time decay accelerating, needs quick move up`,
              );
            }

            const action: TradeAction =
              pts >= 3 ? 'HOLD' : pts >= 1 ? 'CAUTION' : 'EXIT_WARNING';
            const confidence = Math.min(100, Math.max(0, 50 + pts * 12));
            return { action, reasons, confidence };
          })();

          // PE BUY position: you profit when PE price rises (market goes down)
          const peBuyAdvice: {
            action: TradeAction;
            reasons: string[];
            confidence: number;
          } = (() => {
            const reasons: string[] = [];
            let pts = 0;

            // PE falling from open = bad for PE buyer
            if (peLTPChange <= -50) {
              pts -= 3;
              reasons.push(
                `❌ PE down ${Math.abs(peLTPChange).toFixed(0)} pts from open — market going up, PE buyers losing`,
              );
            } else if (peLTPChange <= -20) {
              pts -= 1;
              reasons.push(
                `⚠️ PE down ${Math.abs(peLTPChange).toFixed(0)} pts — market rising, PE under pressure`,
              );
            } else if (peLTPChange >= 20) {
              pts += 2;
              reasons.push(
                `✅ PE up ${peLTPChange.toFixed(0)} pts from open — market falling, PE buyers in profit`,
              );
            }

            // PCR < 0.8 = fewer puts = bearish market sentiment weakening = good for PE buyer
            if (pcr < 0.8) {
              pts += 2;
              reasons.push(
                `✅ PCR ${pcr.toFixed(2)} — call writers dominant, market weak, supports PE buyers`,
              );
            } else if (pcr >= 1.2) {
              pts -= 2;
              reasons.push(
                `❌ PCR ${pcr.toFixed(2)} — strong put writing = market bullish, bad for PE buyers`,
              );
            }

            // PE OI rising + PE rising = fresh put buying = good for PE buyer
            if (peOIDayChange > 0 && peLTPChange > 0) {
              pts += 1;
              reasons.push(
                `✅ PE OI rising with price — fresh puts being bought, bearish momentum`,
              );
            } else if (peOIDayChange > 0 && peLTPChange < 0) {
              pts -= 1;
              reasons.push(
                `❌ PE OI rising while price falls — put writers adding, buyers trapped`,
              );
            }

            // Order book: buyers dominating = good for PE buyer
            if (peBuySellRatio !== null) {
              if (peBuySellRatio > 1.5) {
                pts += 1;
                reasons.push(
                  `✅ PE order book: buyers dominating (B/S ${peBuySellRatio.toFixed(2)}) — upward pressure on PE`,
                );
              } else if (peBuySellRatio < 0.7) {
                pts -= 1;
                reasons.push(
                  `❌ PE order book: sellers dominating (B/S ${peBuySellRatio.toFixed(2)}) — PE will keep falling`,
                );
              }
            }

            // Expiry day: PE has to fall hard to profit — extra risk
            if (isExpiryDay) {
              pts -= 1;
              reasons.push(
                `⚠️ Expiry day — PE time decay accelerating, needs quick move down`,
              );
            }

            const action: TradeAction =
              pts >= 3 ? 'HOLD' : pts >= 1 ? 'CAUTION' : 'EXIT_WARNING';
            const confidence = Math.min(100, Math.max(0, 50 + pts * 12));
            return { action, reasons, confidence };
          })();

          // ── Entry suggestions (for users who haven't taken a trade yet) ──────
          const ceOpen = ce.ohlc?.open ?? ce.last_price;
          const ceHigh = ce.ohlc?.high ?? ce.last_price;
          const ceLow = ce.ohlc?.low ?? ce.last_price;
          const peOpen = pe.ohlc?.open ?? pe.last_price;
          const peHigh = pe.ohlc?.high ?? pe.last_price;
          const peLow = pe.ohlc?.low ?? pe.last_price;

          // ── Price position in day range (0 = at day low, 1 = at day high) ──────
          const cePIR =
            ceHigh > ceLow
              ? Math.max(
                  0,
                  Math.min(1, (ce.last_price - ceLow) / (ceHigh - ceLow)),
                )
              : 0.5;
          const pePIR =
            peHigh > peLow
              ? Math.max(
                  0,
                  Math.min(1, (pe.last_price - peLow) / (peHigh - peLow)),
                )
              : 0.5;

          // % move from today's open
          const ceMoveFromOpenPct =
            ceOpen > 0 ? ((ce.last_price - ceOpen) / ceOpen) * 100 : 0;
          const peMoveFromOpenPct =
            peOpen > 0 ? ((pe.last_price - peOpen) / peOpen) * 100 : 0;

          // Zone detection: <22% = support zone, >78% = resistance zone
          const CE_AT_SUPPORT = cePIR < 0.22;
          const CE_AT_RESISTANCE = cePIR > 0.78;
          const PE_AT_SUPPORT = pePIR < 0.22;
          const PE_AT_RESISTANCE = pePIR > 0.78;

          // Resistance sell target: 4% inside day high (realistic pullback zone)
          // Support buy target: 4% above day low (bounce confirmation buffer)
          const ceResTarget = Math.round(ceHigh * 0.96);
          const peResTarget = Math.round(peHigh * 0.96);
          const ceSuppTarget = Math.round(ceLow * 1.04);
          const peSuppTarget = Math.round(peLow * 1.04);

          // Breakdown sell trigger: close below day low
          const ceBreakdown = Math.round(ceLow * 0.98);
          const peBreakdown = Math.round(peLow * 0.98);

          // Big-move warning: option already moved >35% from open
          const ceBigDown = ceMoveFromOpenPct <= -35;
          const ceBigUp = ceMoveFromOpenPct >= 35;
          const peBigDown = peMoveFromOpenPct <= -35;
          const peBigUp = peMoveFromOpenPct >= 35;

          // ── CE entry notes (market-aware) ────────────────────────────────────
          let ceSellNote: string;
          let ceSellNow = false;
          let ceSellRisk: string | null = null;
          let ceBuyNote: string;
          let ceBuyNow = false;
          let ceBuyRisk: string | null = null;

          if (CE_AT_RESISTANCE) {
            ceSellNote = `✅ CE ₹${ce.last_price.toFixed(0)} near resistance ₹${ceResTarget} — SELL NOW`;
            ceSellNow = true;
            if (ceBigUp)
              ceSellRisk = `⚠️ CE already up ${ceMoveFromOpenPct.toFixed(0)}% from open — confirm rejection candle before entering`;
          } else if (CE_AT_SUPPORT) {
            ceSellNote = `⚠️ CE ₹${ce.last_price.toFixed(0)} near support — risky to sell here`;
            ceSellRisk = `Wait for bounce to ₹${ceResTarget} → then SELL, OR breakdown below ₹${ceBreakdown} with volume → then SELL`;
          } else {
            ceSellNote = `⏳ CE ₹${ce.last_price.toFixed(0)} — wait for bounce to ₹${ceResTarget} (resistance), then SELL`;
          }

          if (CE_AT_SUPPORT) {
            ceBuyNote = `✅ CE ₹${ce.last_price.toFixed(0)} near support ₹${ceSuppTarget} — BUY possible`;
            ceBuyNow = true;
            if (ceBigDown)
              ceBuyRisk = `⚠️ CE already down ${Math.abs(ceMoveFromOpenPct).toFixed(0)}% from open — late entry risk. Confirm with volume before buying.`;
          } else if (CE_AT_RESISTANCE) {
            ceBuyNote = `❌ CE ₹${ce.last_price.toFixed(0)} at resistance — avoid BUY here`;
            ceBuyRisk = `Wait for pullback to ₹${ceSuppTarget} for a better entry`;
          } else {
            ceBuyNote = `⏳ CE ₹${ce.last_price.toFixed(0)} — wait for dip to ₹${ceSuppTarget} (support) before BUY`;
            if (ceBigDown)
              ceBuyRisk = `⚠️ Big move already happened (${Math.abs(ceMoveFromOpenPct).toFixed(0)}% down) — confirm with volume/OI spike before chasing`;
          }

          // ── PE entry notes (market-aware) ────────────────────────────────────
          let peSellNote: string;
          let peSellNow = false;
          let peSellRisk: string | null = null;
          let peBuyNote: string;
          let peBuyNow = false;
          let peBuyRisk: string | null = null;

          if (PE_AT_RESISTANCE) {
            peSellNote = `✅ PE ₹${pe.last_price.toFixed(0)} near resistance ₹${peResTarget} — SELL NOW`;
            peSellNow = true;
            if (peBigUp)
              peSellRisk = `⚠️ PE already up ${peMoveFromOpenPct.toFixed(0)}% from open — confirm rejection candle before entering`;
          } else if (PE_AT_SUPPORT) {
            peSellNote = `⚠️ PE ₹${pe.last_price.toFixed(0)} near support — risky to sell here`;
            peSellRisk = `Wait for bounce to ₹${peResTarget} → then SELL, OR breakdown below ₹${peBreakdown} with volume → then SELL`;
          } else {
            peSellNote = `⏳ PE ₹${pe.last_price.toFixed(0)} — wait for bounce to ₹${peResTarget} (resistance), then SELL`;
          }

          if (PE_AT_SUPPORT) {
            peBuyNote = `✅ PE ₹${pe.last_price.toFixed(0)} near support ₹${peSuppTarget} — BUY possible`;
            peBuyNow = true;
            if (peBigDown)
              peBuyRisk = `⚠️ PE already down ${Math.abs(peMoveFromOpenPct).toFixed(0)}% from open — late entry risk. Confirm with volume before buying.`;
          } else if (PE_AT_RESISTANCE) {
            peBuyNote = `❌ PE ₹${pe.last_price.toFixed(0)} at resistance — avoid BUY here`;
            peBuyRisk = `Wait for pullback to ₹${peSuppTarget} for a better entry`;
          } else {
            peBuyNote = `⏳ PE ₹${pe.last_price.toFixed(0)} — wait for dip to ₹${peSuppTarget} (support) before BUY`;
            if (peBigDown)
              peBuyRisk = `⚠️ Big move already happened (${Math.abs(peMoveFromOpenPct).toFixed(0)}% down) — confirm with volume/OI spike before chasing`;
          }

          // ── Market phase classification ───────────────────────────────────────
          type MarketPhase =
            | 'TRENDING_BEARISH'
            | 'TRENDING_BULLISH'
            | 'BEARISH_AT_SUPPORT'
            | 'BULLISH_AT_RESISTANCE'
            | 'NEUTRAL';
          let marketPhase: MarketPhase;
          if (score <= -2) {
            marketPhase = CE_AT_SUPPORT
              ? 'BEARISH_AT_SUPPORT'
              : 'TRENDING_BEARISH';
          } else if (score >= 2) {
            marketPhase = PE_AT_SUPPORT
              ? 'BULLISH_AT_RESISTANCE'
              : 'TRENDING_BULLISH';
          } else {
            marketPhase = 'NEUTRAL';
          }

          // ── Top trade: direction + price-position aware ───────────────────────
          type TopTrade = {
            action: string;
            at: number | null;
            atNow: boolean;
            reason: string;
            confidence: 'HIGH' | 'MEDIUM' | 'LOW';
            marketPhase: MarketPhase;
            riskNote: string | null;
            alternative: string | null;
          };
          let topTrade: TopTrade;

          if (score <= -2) {
            // ── BEARISH market ────────────────────────────────────────────────
            if (CE_AT_SUPPORT) {
              // CE already at support — selling CE here is dangerous (bounce risk)
              if (peBigUp) {
                // PE also already up huge — both are late entries
                topTrade = {
                  action: 'WAIT',
                  at: null,
                  atNow: false,
                  reason: `Bearish, but CE near support & PE already up ${peMoveFromOpenPct.toFixed(0)}% — market between trend continuation & temporary support`,
                  confidence: 'LOW',
                  marketPhase,
                  riskNote: `Late selling CE = risky. Chasing PE now = risky. Big move already happened.`,
                  alternative: `Option 1 (safe): SELL CE on pullback bounce to ₹${ceResTarget} | Option 2 (aggressive): SELL CE on breakdown below ₹${ceBreakdown} with volume`,
                };
              } else {
                topTrade = {
                  action: 'BUY PE',
                  at: peSuppTarget,
                  atNow: PE_AT_SUPPORT,
                  reason: `Bearish trend, but CE is near support — don't sell CE here (bounce risk). BUY PE at support ₹${peSuppTarget} is the safer play`,
                  confidence: 'MEDIUM',
                  marketPhase,
                  riskNote: `Never sell CE into support ₹${ceLow.toFixed(0)} — wait for rejection or breakdown`,
                  alternative: `SELL CE on pullback to ₹${ceResTarget} | SELL CE on breakdown below ₹${ceBreakdown} with big red candle`,
                };
              }
            } else if (CE_AT_RESISTANCE) {
              // CE bounced to resistance — ideal SELL CE setup
              topTrade = {
                action: 'SELL CE',
                at: ceResTarget,
                atNow: true,
                reason: `Bearish trend — CE bounced to resistance ₹${ceResTarget}. SELL CE NOW`,
                confidence: 'HIGH',
                marketPhase,
                riskNote: ceBigDown
                  ? `CE already down ${Math.abs(ceMoveFromOpenPct).toFixed(0)}% from open — confirm rejection candle before entering`
                  : null,
                alternative: `Stop loss above ₹${Math.round(ceHigh * 1.03)}`,
              };
            } else {
              // CE in middle range — wait for pullback or breakdown
              topTrade = {
                action: 'SELL CE',
                at: ceResTarget,
                atNow: false,
                reason: `Bearish market (PCR ${pcr.toFixed(2)}, score ${score}) — wait for CE to bounce to ₹${ceResTarget}, then SELL`,
                confidence: 'MEDIUM',
                marketPhase,
                riskNote: `Don't sell CE at current ₹${ce.last_price.toFixed(0)} — not at resistance yet. Resistance zone: ₹${ceResTarget}`,
                alternative: `BUY PE at support ₹${peSuppTarget} for directional momentum | Breakdown sell: if CE breaks below ₹${ceBreakdown} with volume`,
              };
            }
          } else if (score >= 2) {
            // ── BULLISH market ────────────────────────────────────────────────
            if (PE_AT_SUPPORT) {
              // PE at support — selling PE here is risky
              if (ceBigUp) {
                topTrade = {
                  action: 'WAIT',
                  at: null,
                  atNow: false,
                  reason: `Bullish, but PE near support & CE already up ${ceMoveFromOpenPct.toFixed(0)}% — late entry risk on both sides`,
                  confidence: 'LOW',
                  marketPhase,
                  riskNote: `Chasing CE now = risky. Don't sell PE at support — bounce risk.`,
                  alternative: `BUY CE on pullback dip to ₹${ceSuppTarget} | SELL PE on bounce to ₹${peResTarget}`,
                };
              } else {
                topTrade = {
                  action: 'BUY CE',
                  at: ceSuppTarget,
                  atNow: CE_AT_SUPPORT,
                  reason: `Bullish trend, PE near support — don't sell PE here (bounce risk). BUY CE at support ₹${ceSuppTarget} is safer`,
                  confidence: 'MEDIUM',
                  marketPhase,
                  riskNote: `Never sell PE into support ₹${peLow.toFixed(0)} — wait for PE bounce to ₹${peResTarget}`,
                  alternative: `SELL PE on pullback to ₹${peResTarget}`,
                };
              }
            } else if (PE_AT_RESISTANCE) {
              topTrade = {
                action: 'SELL PE',
                at: peResTarget,
                atNow: true,
                reason: `Bullish trend — PE bounced to resistance ₹${peResTarget}. SELL PE NOW`,
                confidence: 'HIGH',
                marketPhase,
                riskNote: peBigDown
                  ? `PE already down ${Math.abs(peMoveFromOpenPct).toFixed(0)}% from open — confirm rejection before entering`
                  : null,
                alternative: `Stop loss above ₹${Math.round(peHigh * 1.03)}`,
              };
            } else {
              topTrade = {
                action: 'SELL PE',
                at: peResTarget,
                atNow: false,
                reason: `Bullish market (PCR ${pcr.toFixed(2)}, score ${score}) — wait for PE bounce to ₹${peResTarget}, then SELL`,
                confidence: 'MEDIUM',
                marketPhase,
                riskNote: `Don't sell PE at current ₹${pe.last_price.toFixed(0)}. Wait for pullback to resistance ₹${peResTarget}`,
                alternative: `BUY CE at support ₹${ceSuppTarget} for directional play`,
              };
            }
          } else if (score <= -1) {
            // Mild bearish
            topTrade = {
              action: 'BUY PE',
              at: peSuppTarget,
              atNow: PE_AT_SUPPORT,
              reason: `Mild bearish bias — BUY PE near support ₹${peSuppTarget} for directional momentum play`,
              confidence: PE_AT_SUPPORT ? 'MEDIUM' : 'LOW',
              marketPhase,
              riskNote: peBigUp
                ? `PE already up ${peMoveFromOpenPct.toFixed(0)}% from open — risky to chase`
                : null,
              alternative: `SELL CE at resistance ₹${ceResTarget} for premium decay play`,
            };
          } else if (score >= 1) {
            // Mild bullish
            topTrade = {
              action: 'BUY CE',
              at: ceSuppTarget,
              atNow: CE_AT_SUPPORT,
              reason: `Mild bullish bias — BUY CE near support ₹${ceSuppTarget} for directional momentum play`,
              confidence: CE_AT_SUPPORT ? 'MEDIUM' : 'LOW',
              marketPhase,
              riskNote: ceBigUp
                ? `CE already up ${ceMoveFromOpenPct.toFixed(0)}% from open — risky to chase`
                : null,
              alternative: `SELL PE at resistance ₹${peResTarget} for premium decay play`,
            };
          } else {
            topTrade = {
              action: 'WAIT',
              at: null,
              atNow: false,
              reason: `PCR ${pcr.toFixed(2)} — neutral zone. No strong directional edge. Wait for breakout or clear OI signal.`,
              confidence: 'LOW',
              marketPhase,
              riskNote: null,
              alternative: null,
            };
          }

          const entrySuggestions = {
            ce: {
              sellAt: ceResTarget,
              sellNow: ceSellNow,
              sellNote: ceSellNote,
              sellRisk: ceSellRisk,
              buyAt: ceSuppTarget,
              buyNow: ceBuyNow,
              buyNote: ceBuyNote,
              buyRisk: ceBuyRisk,
              open: parseFloat(ceOpen.toFixed(2)),
              dayHigh: parseFloat(ceHigh.toFixed(2)),
              dayLow: parseFloat(ceLow.toFixed(2)),
              priceInRange: parseFloat(cePIR.toFixed(2)),
              moveFromOpenPct: parseFloat(ceMoveFromOpenPct.toFixed(1)),
            },
            pe: {
              sellAt: peResTarget,
              sellNow: peSellNow,
              sellNote: peSellNote,
              sellRisk: peSellRisk,
              buyAt: peSuppTarget,
              buyNow: peBuyNow,
              buyNote: peBuyNote,
              buyRisk: peBuyRisk,
              open: parseFloat(peOpen.toFixed(2)),
              dayHigh: parseFloat(peHigh.toFixed(2)),
              dayLow: parseFloat(peLow.toFixed(2)),
              priceInRange: parseFloat(pePIR.toFixed(2)),
              moveFromOpenPct: parseFloat(peMoveFromOpenPct.toFixed(1)),
            },
            topTrade,
          };

          return {
            symbol: ss.symbol,
            date: ss.date,
            expiry: ss.expiry,
            isExpiryDay,
            atmStrike: ss.atmStrike,
            niftySpotAtOpen: ss.niftySpotAtOpen,
            brokerName: broker.name,
            brokerId: broker.id,

            ce: {
              symbol: ss.ceTradingSymbol,
              strike: ss.ceStrike,
              token: ss.ceInstrumentToken,
              ltp: ce.last_price,
              open: ce.ohlc?.open,
              high: ce.ohlc?.high,
              low: ce.ohlc?.low,
              close: ce.ohlc?.close,
              ltpChange: ceLTPChange,
              oi: ceOI,
              oiDayHigh: ce.oi_day_high,
              oiDayLow: ce.oi_day_low,
              oiDayChange: ceOIDayChange,
              volume: ce.volume,
              buyQty: ceBuyQty,
              sellQty: ceSellQty,
              buySellRatio: ceBuySellRatio,
            },

            pe: {
              symbol: ss.peTradingSymbol,
              strike: ss.peStrike,
              token: ss.peInstrumentToken,
              ltp: pe.last_price,
              open: pe.ohlc?.open,
              high: pe.ohlc?.high,
              low: pe.ohlc?.low,
              close: pe.ohlc?.close,
              ltpChange: peLTPChange,
              oi: peOI,
              oiDayHigh: pe.oi_day_high,
              oiDayLow: pe.oi_day_low,
              oiDayChange: peOIDayChange,
              volume: pe.volume,
              buyQty: peBuyQty,
              sellQty: peSellQty,
              buySellRatio: peBuySellRatio,
            },

            analysis: {
              pcr: parseFloat(pcr.toFixed(3)),
              pcrSignal,
              verdict,
              score,
              reasons: verdictReasons,
            },

            tradeAdvice: {
              ceSell: ceSellAdvice,
              peSell: peSellAdvice,
              ceBuy: ceBuyAdvice,
              peBuy: peBuyAdvice,
            },

            entrySuggestions,
          };
        } catch (err: any) {
          return {
            symbol: ss.symbol,
            ceSymbol: ss.ceTradingSymbol,
            peSymbol: ss.peTradingSymbol,
            error: err?.message ?? 'Kite API error',
          };
        }
      }),
    );

    return { date: tradeDate, count: results.length, results };
  }
}

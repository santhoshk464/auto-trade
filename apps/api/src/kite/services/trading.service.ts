import { Injectable, Logger } from '@nestjs/common';
import { KiteConnect } from 'kiteconnect';
import { PrismaService } from '../../prisma/prisma.service';
import { PaperTradingService } from '../../paper-trading/services/paper-trading.service';
import { SignalsService } from './signals.service';
import { IndicatorsService } from './indicators.service';
import { KiteService } from './kite.service';
import { StrategyConfigService } from '../../strategy-config/strategy-config.service';
import {
  parseTimeToMinutes,
  parseSignalTimeToDate,
} from '../helpers/kite.helpers';
import { detectDayHighRejectionOnly } from '../strategies/day-high-rejection.strategy';
import { detectDayLowBreakOnly } from '../strategies/day-low-break.strategy';
import { detectDayReversalOnly } from '../strategies/day-reversal.strategy';
import {
  detectEmaRejectionOnly,
  emaRejFileLog,
} from '../strategies/ema-rejection.strategy';
import {
  detectDaySellSignals,
  type DaySellSignal,
} from '../strategies/day-selling-v1.strategy';
import { detectDaySellSignalsV2 } from '../strategies/day-selling-v2.strategy';
import { detectDaySellSignalsCombined } from '../strategies/day-selling-combined.strategy';
import { detectDaySellSignalsV3 } from '../strategies/day-selling-v3.strategy';
import { detectDaySellSignalsV4 } from '../strategies/day-selling-v4.strategy';
import { detectDaySellSignalsV2Enhanced } from '../strategies/day-selling-v2-enhanced.strategy';
import { executeTrendNiftyStrategy } from '../strategies/trend-nifty.strategy';
import { detectSuperPowerPackSignals } from '../strategies/super-power-pack.strategy';
import { detectTripleSyncSignals } from '../strategies/triple-sync.strategy';
import { checkNiftyFuturesTrend } from '../helpers/nifty-trend.helper';
import {
  computeSignalConfidence,
  type ConfidenceGrade,
} from '../helpers/signal-confidence.helper';

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  /**
   * In-memory intraday candle cache.
   * Key: `${instrumentToken}:${interval}:${dateStr}` (e.g. "123456:5minute:2026-04-17")
   * Value: sorted candle array fetched from Kite during this trading session.
   *
   * Populated on first live fetch, then incrementally extended: subsequent
   * calls only fetch candles newer than the last cached candle, cutting
   * live Kite API data volume from "full day history" down to "delta since
   * last run" (typically 1-2 candles per minute).
   *
   * Invalidated automatically at each IST midnight (new dateStr).
   */
  private readonly intradayCandleCache = new Map<string, any[]>();

  constructor(
    private prisma: PrismaService,
    private paperTradingService: PaperTradingService,
    private signalsService: SignalsService,
    private indicators: IndicatorsService,
    private kiteService: KiteService,
    private strategyConfigService: StrategyConfigService,
  ) {}

  /**
   * Load DHR config from DB (merged over hardcoded defaults).
   * Returns {} if no row saved — strategy will use its own inline defaults.
   * Cached per-request via the promise to avoid multiple DB hits in one scan.
   */
  private async loadDhrConfig(): Promise<
    import('../strategies/day-high-rejection.strategy').DhrConfig
  > {
    return this.strategyConfigService.getDhrConfig();
  }

  /**
   * Normalizes an instrument name from the DB into the symbol key used in
   * TradingSettings.  Index instruments are stored with names like 'NIFTY 50'
   * or 'NIFTY BANK' while TradingSettings records use 'NIFTY' / 'BANKNIFTY'.
   */
  private normalizeSettingsSymbol(name: string): string {
    const MAP: Record<string, string> = {
      'NIFTY 50': 'NIFTY',
      'NIFTY BANK': 'BANKNIFTY',
      'NIFTY MIDCAP SELECT': 'MIDCPNIFTY',
    };
    return MAP[name] ?? name;
  }

  /**
   * Fetch candles for a given instrument + date range.
   *
   * Cache-first strategy:
   *  1. If the requested date range fits entirely within a single `dateStr` day
   *     AND a CandleCache row exists for (token, dateStr, interval) → return
   *     the cached candles (filtered to from/to if needed).
   *  2. Otherwise fall back to kc.getHistoricalData() (live Kite API).
   *
   * This allows expired option data (not available on Kite after expiry) to be
   * replayed from the local DB, as long as the EOD cron ran on that day.
   */
  private async getCandlesWithCache(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kc: any,
    instrumentToken: number,
    interval: string,
    from: string, // "YYYY-MM-DD HH:MM:SS"
    to: string, // "YYYY-MM-DD HH:MM:SS"
    skipLiveFallback = false, // set true in DB/historic mode — never call Kite
  ): Promise<any[]> {
    const dateStr = from.slice(0, 10); // "YYYY-MM-DD"
    const toDateStr = to.slice(0, 10);

    // Only use cache when the entire range is within a single day
    if (dateStr === toDateStr) {
      // ── In-memory intraday cache (live mode only) ────────────────────────
      // Each scheduler run re-fetched the FULL day history from Kite.
      // Instead: keep the candles we already have in memory and only fetch
      // the delta (candles after the last cached candle's timestamp).
      // This cuts live API payload by ~95% after the first run of the day.
      if (!skipLiveFallback) {
        const memKey = `${instrumentToken}:${interval}:${dateStr}`;
        const existing = this.intradayCandleCache.get(memKey);

        if (existing && existing.length > 0) {
          // Find the timestamp of the last cached candle
          const lastCachedDate = existing[existing.length - 1].date as Date;
          const lastCachedMs = lastCachedDate.getTime();

          // Only fetch candles strictly AFTER the last cached one
          const deltaFromMs = lastCachedMs + 1; // +1 ms to exclude last candle
          const deltaFrom = new Date(deltaFromMs)
            .toISOString()
            .replace('T', ' ')
            .slice(0, 19);

          try {
            const delta: any[] = await kc.getHistoricalData(
              instrumentToken,
              interval,
              deltaFrom,
              to,
            );
            if (delta && delta.length > 0) {
              const newCandles = delta.map((c: any) => ({
                ...c,
                date: c.date instanceof Date ? c.date : new Date(c.date),
              }));
              // Merge: append only truly new candles (guard against API overlap)
              const uniqueNew = newCandles.filter(
                (c: any) => (c.date as Date).getTime() > lastCachedMs,
              );
              existing.push(...uniqueNew);
            }
          } catch {
            // Delta fetch failed — use what we have (stale but safe)
          }

          // Return all cached candles filtered to the caller's requested window
          const fromMs = new Date(from).getTime();
          const toMs = new Date(to).getTime();
          return existing.filter((c) => {
            const t = (c.date as Date).getTime();
            return t >= fromMs && t <= toMs;
          });
        }

        // First fetch of the day — get full history, prime the cache
        try {
          const fresh: any[] = await kc.getHistoricalData(
            instrumentToken,
            interval,
            from,
            to,
          );
          if (fresh && fresh.length > 0) {
            const withDates = fresh.map((c: any) => ({
              ...c,
              date: c.date instanceof Date ? c.date : new Date(c.date),
            }));
            this.intradayCandleCache.set(memKey, withDates);
            return withDates;
          }
          return [];
        } catch {
          return [];
        }
      }

      // ── Persistent DB candle cache (DB/historic mode) ────────────────────
      try {
        const cached = await this.prisma.candleCache.findUnique({
          where: {
            instrumentToken_dateStr_interval: {
              instrumentToken,
              dateStr,
              interval,
            },
          },
          select: { candlesJson: true },
        });

        if (cached) {
          const allCandles: any[] = JSON.parse(cached.candlesJson);
          // Convert stored date strings back to Date objects to match Kite API shape
          const fromMs = new Date(from).getTime();
          const toMs = new Date(to).getTime();
          return allCandles
            .map((c) => ({ ...c, date: new Date(c.date) }))
            .filter((c) => {
              const t = (c.date as Date).getTime();
              return t >= fromMs && t <= toMs;
            });
        }
      } catch {
        // DB read failure — fall through to live fetch (unless DB mode)
      }
    }

    // In DB/historic mode never fall back to the live Kite API.
    // Expired option tokens will throw "invalid token" — return empty instead.
    if (skipLiveFallback) return [];

    return kc.getHistoricalData(instrumentToken, interval, from, to);
  }

  /**
   * Fetches candles for the most recent trading day BEFORE `beforeDateStr` from
   * CandleCache.  Used in historic mode so EMA pre-seeding and yesterday's
   * OHLC can be derived without calling the live Kite API.
   *
   * Returns null when no matching cache row exists.
   */
  private async getPrevDayCandlesFromCache(
    instrumentToken: number,
    beforeDateStr: string,
    interval: string,
  ): Promise<any[] | null> {
    try {
      const row = await this.prisma.candleCache.findFirst({
        where: {
          instrumentToken,
          interval,
          dateStr: { lt: beforeDateStr },
        },
        orderBy: { dateStr: 'desc' },
        select: { candlesJson: true },
      });
      if (!row) return null;
      return (JSON.parse(row.candlesJson) as any[]).map((c) => ({
        ...c,
        date: new Date(c.date),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Fetches candles for a specific date+interval from CandleCache only.
   * NO Kite API fallback — safe to use for expired option tokens in historic mode.
   * Returns [] when no cache row exists.
   */
  private async getTodayCandlesFromCache(
    instrumentToken: number,
    dateStr: string,
    interval: string,
  ): Promise<any[]> {
    try {
      const row = await this.prisma.candleCache.findUnique({
        where: {
          instrumentToken_dateStr_interval: {
            instrumentToken,
            dateStr,
            interval,
          },
        },
        select: { candlesJson: true },
      });
      if (!row) return [];
      return (JSON.parse(row.candlesJson) as any[]).map((c) => ({
        ...c,
        date: new Date(c.date),
      }));
    } catch {
      return [];
    }
  }

  async getOptionChartData(
    brokerId: string,
    instrumentToken: string,
    targetDate: string,
    interval: 'minute' | '5minute' | '15minute' | '30minute' | '60minute',
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_SELLING_V4'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY'
      | 'DAY_HIGH_REJECTION'
      | 'DAY_LOW_BREAK'
      | 'EMA_REJECTION'
      | 'SUPER_POWER_PACK'
      | 'DAY_REVERSAL'
      | 'TRIPLE_SYNC',
    marginPoints: number,
  ) {
    this.logger.log(
      `getOptionChartData called with: brokerId=${brokerId}, instrumentToken=${instrumentToken}, targetDate=${targetDate}, interval=${interval}, strategy=${strategy}`,
    );

    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker) {
      this.logger.error(`Broker not found: ${brokerId}`);
      throw new Error('Broker not found');
    }

    if (!broker.accessToken) {
      throw new Error('Broker access token not found');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    const today = new Date(targetDate);
    const todayStr = today.toISOString().split('T')[0];

    // Get yesterday's date (skip weekends)
    const yesterday = new Date(targetDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDay = yesterday.getDay();
    if (yesterdayDay === 0) {
      yesterday.setDate(yesterday.getDate() - 2);
    } else if (yesterdayDay === 6) {
      yesterday.setDate(yesterday.getDate() - 1);
    }
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const todayFrom = `${todayStr} 09:15:00`;
    const todayTo = `${todayStr} 15:30:00`;
    const yesterdayFrom = `${yesterdayStr} 09:15:00`;
    const yesterdayTo = `${yesterdayStr} 15:30:00`;

    // Wide lookback window (7 calendar days) to handle market holidays.
    // Kite will only return candles for actual trading days within this range.
    const prevWindowStart = new Date(targetDate);
    prevWindowStart.setDate(prevWindowStart.getDate() - 7);
    const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;

    // Fetch today's intraday candles
    const candles = await kc.getHistoricalData(
      instrumentToken,
      interval,
      todayFrom,
      todayTo,
    );

    if (!candles || candles.length === 0) {
      throw new Error('No candle data available');
    }

    // Log first candle to check date format
    if (candles.length > 0) {
      this.logger.log(
        `First candle date: ${candles[0].date}, type: ${typeof candles[0].date}, ISO: ${candles[0].date instanceof Date ? candles[0].date.toISOString() : 'N/A'}`,
      );
    }

    const chartData: any = {
      candles: candles.map((c: any) => {
        // Kite returns dates as Date objects in IST (UTC+5:30)
        // We need to adjust timestamps so they display correctly in the chart
        // Since charts typically display in UTC, we add IST offset to preserve the local time
        let timestamp: number;
        if (c.date instanceof Date) {
          // Get the timestamp and add IST offset (5 hours 30 minutes = 19800 seconds)
          timestamp = Math.floor(c.date.getTime() / 1000) + 19800;
        } else if (typeof c.date === 'string') {
          timestamp = Math.floor(new Date(c.date).getTime() / 1000) + 19800;
        } else {
          timestamp = Math.floor(c.date / 1000) + 19800;
        }

        return {
          time: timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        };
      }),
      signals: [],
      ema: [],
      yesterdayHigh: null,
      yesterdayLow: null,
    };

    if (strategy === '20_EMA') {
      // Calculate 20 EMA with pre-seeding from yesterday's data
      // Fetch yesterday's intraday data to pre-seed EMA
      const yesterdayIntraday20EMA = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      this.logger.debug(
        `20_EMA: Fetched ${yesterdayIntraday20EMA?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      let emaValues: (number | null)[];
      if (yesterdayIntraday20EMA && yesterdayIntraday20EMA.length > 0) {
        const yesterdaySeed = yesterdayIntraday20EMA.slice(-25);
        const combinedClosePrices = [
          ...yesterdaySeed.map((c: any) => c.close),
          ...candles.map((c: any) => c.close),
        ];
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        emaValues = combinedEMA.slice(yesterdaySeed.length);
        this.logger.debug(
          `20_EMA: Pre-seeded with ${yesterdaySeed.length} yesterday candles. EMA from first candle.`,
        );
      } else {
        this.logger.warn(
          `20_EMA: No yesterday data available, using standard EMA (will be null for first 19 candles)`,
        );
        const closePrices = candles.map((c: any) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Add EMA line data
      chartData.ema = candles
        .map((c: any, i: number) => {
          const timestamp =
            c.date instanceof Date
              ? Math.floor(c.date.getTime() / 1000) + 19800
              : Math.floor(new Date(c.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: emaValues[i],
          };
        })
        .filter((e: any) => e.value !== null);

      // Determine EMA trend
      let emaTrend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
      if (emaValues.length >= 25) {
        const currentEMA = emaValues[emaValues.length - 1];
        const pastEMA = emaValues[emaValues.length - 6];
        if (currentEMA && pastEMA) {
          if (currentEMA > pastEMA * 1.002) {
            emaTrend = 'UP';
          } else if (currentEMA < pastEMA * 0.998) {
            emaTrend = 'DOWN';
          }
        }
      }

      // === DAILY TRADING LIMITS ===
      let dailyTradesCount = 0;
      let dailyPnL = 0;
      let dailyStopTrading = false;
      const MAX_DAILY_TRADES = 2;
      const MAX_DAILY_LOSS = 35; // points

      // Detect signals
      for (let i = 19; i < candles.length; i++) {
        // === CHECK DAILY LIMITS ===
        if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
          break; // Stop generating new signals for the day
        }

        const candle = candles[i];
        const candleEMA = emaValues[i];

        if (!candleEMA) continue;

        const candleHigh = candle.high;
        const candleLow = candle.low;
        const candleOpen = candle.open;
        const candleClose = candle.close;

        const distanceHighToEMA = Math.abs(candleHigh - candleEMA);
        const distanceLowToEMA = Math.abs(candleLow - candleEMA);
        const distanceCloseToEMA = Math.abs(candleClose - candleEMA);

        const touchedEMA =
          distanceHighToEMA <= marginPoints ||
          distanceLowToEMA <= marginPoints ||
          distanceCloseToEMA <= marginPoints;

        if (touchedEMA) {
          const candleBody = Math.abs(candleClose - candleOpen);
          const upperWick = candleHigh - Math.max(candleOpen, candleClose);
          const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
          const isGreenCandle = candleClose > candleOpen;
          const isRedCandle = candleClose < candleOpen;

          // BUY signals in uptrend
          if (emaTrend === 'UP') {
            const hasLowerWickRejection =
              lowerWick > candleBody * 1.2 &&
              candleClose > candleEMA &&
              candleLow <= candleEMA * 1.01;

            const hasBullishBounce =
              candleOpen < candleEMA &&
              candleClose > candleEMA &&
              isGreenCandle &&
              candleBody > (candleHigh - candleLow) * 0.4;

            if (hasLowerWickRejection || hasBullishBounce) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'BUY',
                  candle,
                );
              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
              chartData.signals.push({
                time: timestamp,
                type: 'BUY',
                price: candleClose,
                stopLoss,
                target,
                text: hasLowerWickRejection
                  ? 'Lower wick rejection'
                  : 'Bullish bounce',
              });

              dailyTradesCount++;

              // Look ahead to check trade outcome
              const risk = Math.abs(candleClose - stopLoss);
              const target1_3 = candleClose + risk * 3;
              const target1_4 = candleClose + risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                if (futureCandle.low <= stopLoss) {
                  dailyPnL -= candleClose - stopLoss;
                  tradeCompleted = true;
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                  }
                  break;
                }

                if (futureCandle.high >= target1_4) {
                  dailyPnL += target1_4 - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.high >= target1_3) {
                  dailyPnL += target1_3 - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.high >= target) {
                  dailyPnL += target - candleClose;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // SELL signals in downtrend
          if (emaTrend === 'DOWN') {
            const hasUpperWickRejection =
              upperWick > candleBody * 1.2 &&
              candleClose < candleEMA &&
              candleHigh >= candleEMA * 0.99;

            const hasBearishRejection =
              candleOpen > candleEMA &&
              candleClose < candleEMA &&
              isRedCandle &&
              candleBody > (candleHigh - candleLow) * 0.4;

            if (hasUpperWickRejection || hasBearishRejection) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'SELL',
                  candle,
                );
              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
              chartData.signals.push({
                time: timestamp,
                type: 'SELL',
                price: candleClose,
                stopLoss,
                target,
                text: hasUpperWickRejection
                  ? 'Upper wick rejection'
                  : 'Bearish rejection',
              });

              dailyTradesCount++;

              // Look ahead to check trade outcome
              const risk = Math.abs(stopLoss - candleClose);
              const target1_3 = candleClose - risk * 3;
              const target1_4 = candleClose - risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                if (futureCandle.high >= stopLoss) {
                  dailyPnL -= stopLoss - candleClose;
                  tradeCompleted = true;
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                  }
                  break;
                }

                if (futureCandle.low <= target1_4) {
                  dailyPnL += candleClose - target1_4;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.low <= target1_3) {
                  dailyPnL += candleClose - target1_3;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                } else if (futureCandle.low <= target) {
                  dailyPnL += candleClose - target;
                  dailyStopTrading = true;
                  tradeCompleted = true;
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;
        }
      }
    } else if (strategy === 'PREV_DAY_HIGH_LOW') {
      // Fetch yesterday's data (use wide window to handle holidays)
      const yesterdayHistorical = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      if (yesterdayHistorical && yesterdayHistorical.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        const yesterdayData =
          yesterdayHistorical[yesterdayHistorical.length - 1];
        chartData.yesterdayHigh = yesterdayData.high;
        chartData.yesterdayLow = yesterdayData.low;

        // === DAILY TRADING LIMITS ===
        let dailyTradesCount = 0;
        let dailyPnL = 0;
        let dailyStopTrading = false;
        const MAX_DAILY_TRADES = 2;
        const MAX_DAILY_LOSS = 35; // points

        // Detect signals at yesterday's high/low
        for (let i = 0; i < candles.length; i++) {
          // === CHECK DAILY LIMITS ===
          if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
            break; // Stop generating new signals for the day
          }

          const candle = candles[i];
          const candleHigh = candle.high;
          const candleLow = candle.low;
          const candleOpen = candle.open;
          const candleClose = candle.close;
          const candleBody = Math.abs(candleClose - candleOpen);
          const upperWick = candleHigh - Math.max(candleOpen, candleClose);
          const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
          const totalCandleRange = candleHigh - candleLow;
          const isRedCandle = candleClose < candleOpen;
          const isGreenCandle = candleClose > candleOpen;

          const distanceHighToYesterdayHigh = Math.abs(
            candleHigh - yesterdayData.high,
          );
          const distanceLowToYesterdayLow = Math.abs(
            candleLow - yesterdayData.low,
          );

          const nearYesterdayHigh = distanceHighToYesterdayHigh <= marginPoints;
          const nearYesterdayLow = distanceLowToYesterdayLow <= marginPoints;

          // SELL signals at yesterday's high - bearish patterns OR rejection signals
          if (nearYesterdayHigh) {
            const pattern = this.indicators.detectBearishPattern(candles, i);

            // Check for rejection at resistance even without perfect pattern
            const hasUpperWickRejection =
              upperWick > candleBody * 1.5 &&
              candleClose < yesterdayData.high &&
              candleHigh >= yesterdayData.high * 0.998;

            const hasBreakoutFailure =
              candleOpen > yesterdayData.high &&
              candleClose < yesterdayData.high &&
              isRedCandle &&
              candleBody > totalCandleRange * 0.5;

            const hasBearishClose =
              isRedCandle &&
              candleHigh >= yesterdayData.high * 0.998 &&
              candleClose < yesterdayData.high * 0.995;

            if (
              pattern ||
              hasUpperWickRejection ||
              hasBreakoutFailure ||
              hasBearishClose
            ) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'SELL',
                  candle,
                );

              let signalText = '';
              if (pattern) {
                signalText = `${pattern} @ Resistance`;
              } else if (hasUpperWickRejection) {
                signalText = 'Rejection @ Resistance';
              } else if (hasBreakoutFailure) {
                signalText = 'Breakout Failure';
              } else {
                signalText = 'Bearish @ Resistance';
              }

              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

              chartData.signals.push({
                time: timestamp,
                type: 'SELL',
                price: candleClose,
                stopLoss,
                target,
                text: signalText,
              });

              dailyTradesCount++;

              // Look ahead to check if this trade hits SL or Target
              const risk = Math.abs(stopLoss - candleClose);
              const target1_3 = candleClose - risk * 3;
              const target1_4 = candleClose - risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                // Check if SL hit (price goes above SL for SELL)
                if (futureCandle.high >= stopLoss) {
                  const loss = stopLoss - candleClose;
                  dailyPnL -= loss;
                  tradeCompleted = true;

                  // Check if max daily loss reached
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                    this.logger.log(
                      `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading.`,
                    );
                  }
                  break;
                }

                // Check targets
                if (futureCandle.low <= target1_4) {
                  dailyPnL += candleClose - target1_4;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:4 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.low <= target1_3) {
                  dailyPnL += candleClose - target1_3;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:3 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.low <= target) {
                  dailyPnL += candleClose - target;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:2 HIT. Stopping trading for the day.',
                  );
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          // Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;

          // BUY signals at yesterday's low - bullish patterns OR rejection signals
          if (nearYesterdayLow) {
            const pattern = this.indicators.detectBullishPattern(candles, i);

            // Check for rejection at support even without perfect pattern
            const hasLowerWickRejection =
              lowerWick > candleBody * 1.5 &&
              candleClose > yesterdayData.low &&
              candleLow <= yesterdayData.low * 1.002;

            const hasBreakdownFailure =
              candleOpen < yesterdayData.low &&
              candleClose > yesterdayData.low &&
              isGreenCandle &&
              candleBody > totalCandleRange * 0.5;

            const hasBullishClose =
              isGreenCandle &&
              candleLow <= yesterdayData.low * 1.002 &&
              candleClose > yesterdayData.low * 1.005;

            if (
              pattern ||
              hasLowerWickRejection ||
              hasBreakdownFailure ||
              hasBullishClose
            ) {
              const { stopLoss, target } =
                this.indicators.calculateStopLossAndTarget(
                  candleClose,
                  'BUY',
                  candle,
                );

              let signalText = '';
              if (pattern) {
                signalText = `${pattern} @ Support`;
              } else if (hasLowerWickRejection) {
                signalText = 'Rejection @ Support';
              } else if (hasBreakdownFailure) {
                signalText = 'Breakdown Failure';
              } else {
                signalText = 'Bullish @ Support';
              }

              const timestamp =
                candle.date instanceof Date
                  ? Math.floor(candle.date.getTime() / 1000) + 19800
                  : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

              chartData.signals.push({
                time: timestamp,
                type: 'BUY',
                price: candleClose,
                stopLoss,
                target,
                text: signalText,
              });

              dailyTradesCount++;

              // Look ahead to check if this trade hits SL or Target
              const risk = Math.abs(candleClose - stopLoss);
              const target1_3 = candleClose + risk * 3;
              const target1_4 = candleClose + risk * 4;
              let tradeCompleted = false;

              for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
                const futureCandle = candles[j];

                // Check if SL hit (price goes below SL for BUY)
                if (futureCandle.low <= stopLoss) {
                  const loss = candleClose - stopLoss;
                  dailyPnL -= loss;
                  tradeCompleted = true;

                  // Check if max daily loss reached
                  if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
                    dailyStopTrading = true;
                    this.logger.log(
                      `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading.`,
                    );
                  }
                  break;
                }

                // Check targets (highest to lowest)
                if (futureCandle.high >= target1_4) {
                  dailyPnL += target1_4 - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:4 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.high >= target1_3) {
                  dailyPnL += target1_3 - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:3 HIT. Stopping trading for the day.',
                  );
                  break;
                } else if (futureCandle.high >= target) {
                  dailyPnL += target - candleClose;
                  tradeCompleted = true;
                  dailyStopTrading = true;
                  this.logger.log(
                    'TARGET 1:2 HIT. Stopping trading for the day.',
                  );
                  break;
                }
              }

              if (dailyStopTrading) break;
            }
          }

          //Break out of main loop if daily stop triggered
          if (dailyStopTrading) break;
        }
      }

      // Compute 20 EMA for the chart (pre-seeded with yesterday intraday for accuracy)
      const pdhlYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let pdhlEmaValues: (number | null)[];
      if (pdhlYestIntraday && pdhlYestIntraday.length >= 10) {
        const seed = pdhlYestIntraday.slice(-25);
        const combined = [...seed, ...candles];
        pdhlEmaValues = this.indicators
          .calculateEMA(
            combined.map((c) => c.close),
            20,
          )
          .slice(seed.length);
      } else {
        pdhlEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = pdhlEmaValues[idx];
          if (ema == null) return null;
          const ts =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: ts, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'DAY_SELLING') {
      // DAY_SELLING Strategy: Only SELL signals using bearish patterns
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHigh = 0;
      let prevDayLow = 0;
      let prevDayClose = 0;
      if (yesterdayDayData && yesterdayDayData.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayHigh = yesterdayDayData[yesterdayDayData.length - 1].high;
        prevDayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
        prevDayClose = yesterdayDayData[yesterdayDayData.length - 1].close;
        chartData.yesterdayHigh = yesterdayHigh;
        this.logger.debug(
          `Yesterday high = ${yesterdayHigh}, prev day low = ${prevDayLow}, prev day close = ${prevDayClose}`,
        );
      }

      // Fetch previous trading days' intraday data to pre-seed EMA calculation
      const yesterdayIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      this.logger.debug(
        `Fetched ${yesterdayIntradayData?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      // Calculate 20 EMA with pre-seeding from yesterday's data
      let emaValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length > 0) {
        // Pre-seed EMA: Combine yesterday's last 25 candles + today's candles
        const yesterdayLast25 = yesterdayIntradayData.slice(-25);
        const combinedCandles = [...yesterdayLast25, ...candles];
        const combinedClosePrices = combinedCandles.map((c) => c.close);

        // Calculate EMA on combined data
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );

        // Extract only today's EMA values (skip yesterday's candles)
        emaValues = combinedEMA.slice(yesterdayLast25.length);

        this.logger.debug(
          `Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
        );
      } else {
        // Fallback: Standard EMA calculation if no yesterday data
        this.logger.warn(
          `No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
        );
        const closePrices = candles.map((c) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // Calculate RSI for signal gating (signals above first candle high allowed only if RSI > 60)
      let rsiValues: (number | null)[];
      if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
        const yesterdayForRSI = yesterdayIntradayData.slice(-30);
        const combinedForRSI = [...yesterdayForRSI, ...candles];
        const combinedRSIClosePrices = combinedForRSI.map((c) => c.close);
        const combinedRSI = this.indicators.calculateRSI(
          combinedRSIClosePrices,
          14,
        );
        rsiValues = combinedRSI.slice(yesterdayForRSI.length);
      } else {
        const closePrices = candles.map((c) => c.close);
        rsiValues = this.indicators.calculateRSI(closePrices, 14);
      }

      // Find swing highs (local peaks)
      const swingHighs: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const candle = candles[i];
        const prevCandles = candles.slice(i - 5, i);
        const nextCandles = candles.slice(i + 1, i + 6);

        const isLocalHigh =
          prevCandles.every((c) => c.high < candle.high) &&
          nextCandles.every((c) => c.high < candle.high);

        if (isLocalHigh) {
          swingHighs.push({ price: candle.high, index: i });
        }
      }

      this.logger.debug(`Found ${swingHighs.length} swing highs`);

      // Chart path: show ALL signals — no trade cap here.
      // Trade capping (max 2/day, daily loss limit) belongs in the simulator only.
      const superTrendData = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );
      // Load sell signal thresholds from user settings (non-blocking)
      const chartInstrument = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbol = this.normalizeSettingsSymbol(
        chartInstrument?.name ?? 'NIFTY',
      );
      const chartSettings = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbol },
          },
        })
        .catch(() => null);
      const chartMinSellRsi = chartSettings?.minSellRsi ?? 45;
      const chartMaxSellRiskPts = chartSettings?.maxSellRiskPts ?? 25;
      const daySellSignals = detectDaySellSignals({
        candles,
        emaValues,
        rsiValues,
        swingHighs,
        yesterdayHigh,
        prevDayLow,
        prevDayClose,
        marginPoints,
        minSellRsi: chartMinSellRsi,
        maxSellRiskPts: chartMaxSellRiskPts,
        superTrendData,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignals) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;

        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V2') {
      // DAY_SELLING_V2: Fresh V2 engine — 3 independent setups
      const yesterdayDayDataV2 = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighV2 = 0;
      let prevDayLowV2 = 0;
      let prevDayCloseV2 = 0;
      if (yesterdayDayDataV2 && yesterdayDayDataV2.length > 0) {
        yesterdayHighV2 =
          yesterdayDayDataV2[yesterdayDayDataV2.length - 1].high;
        prevDayLowV2 = yesterdayDayDataV2[yesterdayDayDataV2.length - 1].low;
        prevDayCloseV2 =
          yesterdayDayDataV2[yesterdayDayDataV2.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighV2;
        this.logger.debug(
          `V2: Yesterday high = ${yesterdayHighV2}, prev day low = ${prevDayLowV2}, prev day close = ${prevDayCloseV2}`,
        );
      }

      const yesterdayIntradayDataV2 = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let emaValuesV2: (number | null)[];
      if (yesterdayIntradayDataV2 && yesterdayIntradayDataV2.length > 0) {
        const seedV2 = yesterdayIntradayDataV2.slice(-25);
        const combinedV2 = [...seedV2, ...candles];
        const combinedEMAV2 = this.indicators.calculateEMA(
          combinedV2.map((c) => c.close),
          20,
        );
        emaValuesV2 = combinedEMAV2.slice(seedV2.length);
      } else {
        emaValuesV2 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesV2[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV2: (number | null)[];
      if (yesterdayIntradayDataV2 && yesterdayIntradayDataV2.length >= 14) {
        const yesterdayForRSIV2 = yesterdayIntradayDataV2.slice(-30);
        const combinedForRSIV2 = [...yesterdayForRSIV2, ...candles];
        const combinedRSIV2 = this.indicators.calculateRSI(
          combinedForRSIV2.map((c) => c.close),
          14,
        );
        rsiValuesV2 = combinedRSIV2.slice(yesterdayForRSIV2.length);
      } else {
        rsiValuesV2 = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV2: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV2.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV2 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV2 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV2 = this.normalizeSettingsSymbol(
        chartInstrumentV2?.name ?? 'NIFTY',
      );
      const chartSettingsV2 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV2 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV2 = chartSettingsV2?.maxSellRiskPts ?? 25;

      const daySellSignalsV2 = detectDaySellSignalsV2({
        candles,
        emaValues: emaValuesV2,
        rsiValues: rsiValuesV2,
        swingHighs: swingHighsV2,
        yesterdayHigh: yesterdayHighV2,
        prevDayLow: prevDayLowV2,
        prevDayClose: prevDayCloseV2,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV2,
        superTrendData: superTrendDataV2,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV2) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V1V2') {
      // DAY_SELLING_V1V2: Combined engine — V1 first, V2 as fallback.
      // Uses the same data as V2 (same pre-seeding, same prev-day levels).
      // Both V1 and V2 receive IDENTICAL data so the comparison is fair.
      const yesterdayDayDataC = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighC = 0;
      let prevDayLowC = 0;
      let prevDayCloseC = 0;
      if (yesterdayDayDataC && yesterdayDayDataC.length > 0) {
        yesterdayHighC = yesterdayDayDataC[yesterdayDayDataC.length - 1].high;
        prevDayLowC = yesterdayDayDataC[yesterdayDayDataC.length - 1].low;
        prevDayCloseC = yesterdayDayDataC[yesterdayDayDataC.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighC;
      }

      const yesterdayIntradayDataC = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // EMA pre-seeding
      let emaValuesC: (number | null)[];
      if (yesterdayIntradayDataC && yesterdayIntradayDataC.length > 0) {
        const seedC = yesterdayIntradayDataC.slice(-25);
        const combinedC = [...seedC, ...candles];
        const combinedEMAC = this.indicators.calculateEMA(
          combinedC.map((c) => c.close),
          20,
        );
        emaValuesC = combinedEMAC.slice(seedC.length);
      } else {
        emaValuesC = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesC[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI pre-seeding
      let rsiValuesC: (number | null)[];
      if (yesterdayIntradayDataC && yesterdayIntradayDataC.length >= 14) {
        const seedForRSIC = yesterdayIntradayDataC.slice(-30);
        const combinedForRSIC = [...seedForRSIC, ...candles];
        const combinedRSIC = this.indicators.calculateRSI(
          combinedForRSIC.map((c) => c.close),
          14,
        );
        rsiValuesC = combinedRSIC.slice(seedForRSIC.length);
      } else {
        rsiValuesC = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsC: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsC.push({ price: c.high, index: i });
        }
      }

      const superTrendDataC = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentC = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolC = this.normalizeSettingsSymbol(
        chartInstrumentC?.name ?? 'NIFTY',
      );
      const chartSettingsC = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolC },
          },
        })
        .catch(() => null);
      const chartMinSellRsiC = chartSettingsC?.minSellRsi ?? 45;
      const chartMaxSellRiskPtsC = chartSettingsC?.maxSellRiskPts ?? 25;

      const combinedSignals = detectDaySellSignalsCombined({
        candles,
        emaValues: emaValuesC,
        rsiValues: rsiValuesC,
        swingHighs: swingHighsC,
        yesterdayHigh: yesterdayHighC,
        prevDayLow: prevDayLowC,
        prevDayClose: prevDayCloseC,
        marginPoints,
        minSellRsi: chartMinSellRsiC,
        maxSellRiskPts: chartMaxSellRiskPtsC,
        superTrendData: superTrendDataC,
        instrumentName: instrumentToken,
      });

      for (const sig of combinedSignals) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V3') {
      // DAY_SELLING_V3: 4-engine strategy — First Candle Breakdown | Resistance Rejection
      //                                     | EMA Rejection | Lower High Breakdown
      const yesterdayDayDataV3 = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHighV3 = 0;
      let prevDayLowV3 = 0;
      let prevDayCloseV3 = 0;
      if (yesterdayDayDataV3 && yesterdayDayDataV3.length > 0) {
        yesterdayHighV3 =
          yesterdayDayDataV3[yesterdayDayDataV3.length - 1].high;
        prevDayLowV3 = yesterdayDayDataV3[yesterdayDayDataV3.length - 1].low;
        prevDayCloseV3 =
          yesterdayDayDataV3[yesterdayDayDataV3.length - 1].close;
        chartData.yesterdayHigh = yesterdayHighV3;
        this.logger.debug(
          `V3: Yesterday high = ${yesterdayHighV3}, prev day low = ${prevDayLowV3}, prev day close = ${prevDayCloseV3}`,
        );
      }

      const yesterdayIntradayDataV3 = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let emaValuesV3: (number | null)[];
      if (yesterdayIntradayDataV3 && yesterdayIntradayDataV3.length > 0) {
        const seedV3 = yesterdayIntradayDataV3.slice(-25);
        const combinedV3 = [...seedV3, ...candles];
        const combinedEMAV3 = this.indicators.calculateEMA(
          combinedV3.map((c) => c.close),
          20,
        );
        emaValuesV3 = combinedEMAV3.slice(seedV3.length);
      } else {
        emaValuesV3 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // Build EMA chart data
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValuesV3[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV3: (number | null)[];
      if (yesterdayIntradayDataV3 && yesterdayIntradayDataV3.length >= 14) {
        const yesterdayForRSIV3 = yesterdayIntradayDataV3.slice(-30);
        const combinedForRSIV3 = [...yesterdayForRSIV3, ...candles];
        const combinedRSIV3 = this.indicators.calculateRSI(
          combinedForRSIV3.map((c) => c.close),
          14,
        );
        rsiValuesV3 = combinedRSIV3.slice(yesterdayForRSIV3.length);
      } else {
        rsiValuesV3 = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV3: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV3.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV3 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV3 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV3 = this.normalizeSettingsSymbol(
        chartInstrumentV3?.name ?? 'NIFTY',
      );
      const chartSettingsV3 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV3 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV3 = chartSettingsV3?.maxSellRiskPts ?? 35;

      const daySellSignalsV3 = detectDaySellSignalsV3({
        candles,
        emaValues: emaValuesV3,
        rsiValues: rsiValuesV3,
        swingHighs: swingHighsV3,
        yesterdayHigh: yesterdayHighV3,
        prevDayLow: prevDayLowV3,
        prevDayClose: prevDayCloseV3,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV3,
        superTrendData: superTrendDataV3,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV3) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_SELLING_V4') {
      // DAY_SELLING_V4: 6-scenario sell signal detection on option candle data.
      // Works purely on option chart — no NIFTY-spot dependency.
      const v4YestDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      if (v4YestDayData && v4YestDayData.length > 0) {
        chartData.yesterdayHigh = v4YestDayData[v4YestDayData.length - 1].high;
      }

      const v4YestIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let ema20ValuesV4: (number | null)[];
      if (v4YestIntradayData && v4YestIntradayData.length > 0) {
        const seedV4 = v4YestIntradayData.slice(-25);
        const combinedV4 = [...seedV4, ...candles];
        ema20ValuesV4 = this.indicators
          .calculateEMA(
            combinedV4.map((c) => c.close),
            20,
          )
          .slice(seedV4.length);
      } else {
        ema20ValuesV4 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // 8 EMA with pre-seeding
      let ema8ValuesV4: (number | null)[];
      if (v4YestIntradayData && v4YestIntradayData.length > 0) {
        const seedV4 = v4YestIntradayData.slice(-15);
        const combinedV4 = [...seedV4, ...candles];
        ema8ValuesV4 = this.indicators
          .calculateEMA(
            combinedV4.map((c) => c.close),
            8,
          )
          .slice(seedV4.length);
      } else {
        ema8ValuesV4 = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          8,
        );
      }

      // Build EMA chart data (20 EMA)
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = ema20ValuesV4[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // VWAP (today's candles only, no pre-seeding)
      const vwapValuesV4 = this.indicators.calculateVWAP(
        candles.map((c) => ({
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        })),
      );

      const superTrendDataV4 = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV4 = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV4 = this.normalizeSettingsSymbol(
        chartInstrumentV4?.name ?? 'NIFTY',
      );
      const chartSettingsV4 = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV4 },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV4 = chartSettingsV4?.maxSellRiskPts ?? 40;

      const daySellSignalsV4 = detectDaySellSignalsV4({
        candles,
        ema8Values: ema8ValuesV4,
        ema20Values: ema20ValuesV4,
        vwapValues: vwapValuesV4,
        superTrendData: superTrendDataV4,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV4,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV4) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_HIGH_REJECTION') {
      // DAY_HIGH_REJECTION: standalone day-high rejection sell signals on option chart data.

      // Fetch yesterday's intraday to compute EMA20 session gate (same logic as optionMonitor).
      const dhrYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let dhrEma20Chart: number | undefined;
      let dhrEmaValues: (number | null)[];
      if (dhrYestIntraday && dhrYestIntraday.length >= 10) {
        const seed = dhrYestIntraday.slice(-25);
        const combined = [...seed, ...candles];
        const emaAll = this.indicators.calculateEMA(
          combined.map((c) => c.close),
          20,
        );
        // EMA value at the last yesterday candle = session gate reference
        dhrEma20Chart = emaAll[seed.length - 1] ?? undefined;
        dhrEmaValues = emaAll.slice(seed.length);
      } else {
        dhrEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      const dhrChartConfig = await this.loadDhrConfig();
      const dhrSignals = detectDayHighRejectionOnly(candles, {
        touchTolerance: Math.max(5, Math.round(marginPoints * 1.5)),
        stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
        requireNextCandleConfirmation: false,
        ...dhrChartConfig,
        ema20: dhrEma20Chart,
        debug: false,
      });

      for (const sig of dhrSignals) {
        const idx = sig.confirmIndex ?? sig.setupIndex;
        const c = candles[idx];
        const ts =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;
        const risk = sig.stopLoss - sig.entryPrice;
        const target = sig.entryPrice - risk * 2;
        chartData.signals.push({
          time: ts,
          type: 'SELL',
          price: sig.entryPrice,
          stopLoss: sig.stopLoss,
          target,
          text: `${sig.reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }

      chartData.ema = candles
        .map((candle, idx) => {
          const ema = dhrEmaValues[idx];
          if (ema == null) return null;
          const ts =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: ts, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'DAY_LOW_BREAK') {
      // DAY_LOW_BREAK: standalone day-low break sell signals on option chart data.
      // Needs 1-minute candles for the 1m confirmation step.
      const dlb1mCandles =
        interval === 'minute'
          ? candles
          : await kc.getHistoricalData(
              instrumentToken,
              'minute',
              todayFrom,
              todayTo,
            );

      // Fetch yesterday's intraday data to compute EMA20 session gate
      const dlbYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let dlbEma20Chart: number | undefined;
      let dlbEmaValues: (number | null)[];
      if (dlbYestIntraday && dlbYestIntraday.length >= 10) {
        const dlbSeed = dlbYestIntraday.slice(-25);
        const dlbCombined = [...dlbSeed, ...candles];
        const dlbEmaAll = this.indicators.calculateEMA(
          dlbCombined.map((c) => c.close),
          20,
        );
        // EMA value at last yesterday candle = the session-open EMA reference
        dlbEma20Chart = dlbEmaAll[dlbSeed.length - 1] ?? undefined;
        dlbEmaValues = dlbEmaAll.slice(dlbSeed.length);
      } else {
        dlbEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      const dlbSignals = detectDayLowBreakOnly(
        candles,
        {
          stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
          min5mBreakdownBodyRatio: 0.3,
          oneMinuteConfirmationWindow: 10,
          minRRRatio: 1.5,
          ema20: dlbEma20Chart,
          ema20Series: dlbEmaValues,
          debug: false,
        },
        dlb1mCandles ?? [],
      );

      for (const sig of dlbSignals) {
        const c = candles[sig.setupIndex];
        const sigTs =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;
        const risk = sig.stopLoss - sig.entryPrice;
        const target = sig.entryPrice - risk * 2;
        chartData.signals.push({
          time: sigTs,
          type: 'SELL',
          price: sig.entryPrice,
          stopLoss: sig.stopLoss,
          target,
          text: `${sig.reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }

      // EMA values already computed above (dlbEmaValues) — use for chart overlay
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = dlbEmaValues[idx];
          if (ema == null) return null;
          const dlbEmaTs =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: dlbEmaTs, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'DAY_REVERSAL') {
      // DAY_REVERSAL: day peak reversal sell signals on option chart data.
      // Pure 5-minute scan — no 1m confirmation needed.
      const drYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let drEmaValues: (number | null)[];
      let drEma20: number | undefined;
      if (drYestIntraday && drYestIntraday.length >= 10) {
        const drSeed = drYestIntraday.slice(-25);
        const drCombined = [...drSeed, ...candles];
        const drEmaAll = this.indicators.calculateEMA(
          drCombined.map((c) => c.close),
          20,
        );
        drEma20 = drEmaAll[drSeed.length - 1] ?? undefined;
        drEmaValues = drEmaAll.slice(drSeed.length);
      } else {
        drEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      const drSignals = detectDayReversalOnly(candles, {
        stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
        minRallyPoints: Math.max(15, marginPoints),
        minRRRatio: 0,
        ema20: drEma20,
        debug: false,
      });

      for (const sig of drSignals) {
        const c = candles[sig.setupIndex];
        const sigTs =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;
        const risk = sig.stopLoss - sig.entryPrice;
        chartData.signals.push({
          time: sigTs,
          type: 'SELL',
          price: sig.entryPrice,
          stopLoss: sig.stopLoss,
          target: sig.t2,
          text: `${sig.reason} (SL: ${risk.toFixed(1)}pts, T1: ${risk.toFixed(1)}pts, T2: ${(risk * 2).toFixed(1)}pts)`,
        });
      }

      chartData.ema = candles
        .map((candle, idx) => {
          const ema = drEmaValues[idx];
          if (ema == null) return null;
          const drEmaTs =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: drEmaTs, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'EMA_REJECTION') {
      // EMA_REJECTION: 20 EMA rejection sell signals on option chart data.
      // Needs 1-minute candles for optional precision confirmation.
      const emaRej1mCandles =
        interval === 'minute'
          ? candles
          : await kc.getHistoricalData(
              instrumentToken,
              'minute',
              todayFrom,
              todayTo,
            );

      // Pre-seed 20 EMA with yesterday's last 25 candles for accuracy from day open
      const emaRejYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let emaRejEmaValues: (number | null)[];
      if (emaRejYestIntraday && emaRejYestIntraday.length >= 10) {
        const seed = emaRejYestIntraday.slice(-25);
        const combined = [...seed, ...candles];
        emaRejEmaValues = this.indicators
          .calculateEMA(
            combined.map((c) => c.close),
            20,
          )
          .slice(seed.length);
      } else {
        emaRejEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      const emaRejSignals = detectEmaRejectionOnly(
        candles,
        emaRejEmaValues,
        {
          emaTouchBufferPts: Math.max(3, Math.round(marginPoints * 0.5)),
          emaBreakTolerancePts: Math.max(5, Math.round(marginPoints)),
          stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
          minRiskRewardReference: 1.5,
          // Chart display shows all valid setups — SL-width filtering
          // is handled in the execution path (paper/live batch).
          maxAllowedSLReference: Infinity,
          enableDiagLog: true,
          debug: false,
        },
        emaRej1mCandles ?? [],
      );

      for (const sig of emaRejSignals) {
        const idx = sig.confirmIndex >= 0 ? sig.setupIndex : sig.setupIndex;
        const c = candles[idx];
        const ts =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;
        const risk = sig.stopLoss - sig.entryPrice;
        const target = sig.entryPrice - risk * 2;
        chartData.signals.push({
          time: ts,
          type: 'SELL',
          price: sig.entryPrice,
          stopLoss: sig.stopLoss,
          target,
          text: `${sig.reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }

      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaRejEmaValues[idx];
          if (ema == null) return null;
          const emaRejTs =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: emaRejTs, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'SUPER_POWER_PACK') {
      // SUPER_POWER_PACK: DHR + DLB + 20 EMA Rejection combined strategy.
      // Shares the same data pipeline as EMA_REJECTION (1m candles + seeded EMA).
      const spppYestIntraday = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      let spppEma20Chart: number | undefined;
      let spppEmaValues: (number | null)[];
      if (spppYestIntraday && spppYestIntraday.length >= 10) {
        const seed = spppYestIntraday.slice(-25);
        const combined = [...seed, ...candles];
        const emaAll = this.indicators.calculateEMA(
          combined.map((c) => c.close),
          20,
        );
        // Session-level EMA: EMA at last yesterday candle
        spppEma20Chart = emaAll[seed.length - 1] ?? undefined;
        spppEmaValues = emaAll.slice(seed.length);
      } else {
        spppEmaValues = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      const sppp1mCandles =
        interval === 'minute'
          ? candles
          : await kc.getHistoricalData(
              instrumentToken,
              'minute',
              todayFrom,
              todayTo,
            );

      const spppSignals = detectSuperPowerPackSignals({
        candles,
        candles1m: sppp1mCandles ?? [],
        ema20: spppEma20Chart,
        ema20Series: spppEmaValues,
        marginPoints,
        dlbConfig: { maxEmaDistancePts: Infinity },
      });

      for (const sig of spppSignals) {
        const timeIdx =
          sig.source === 'DHR'
            ? sig.oneMinuteConfirmIndex != null
              ? sig.setupIndex
              : (sig.confirmIndex ?? sig.setupIndex)
            : sig.setupIndex;
        const c = candles[timeIdx];
        const ts =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;
        const risk = sig.stopLoss - sig.entryPrice;
        const target = sig.entryPrice - risk * 2;
        chartData.signals.push({
          time: ts,
          type: 'SELL',
          price: sig.entryPrice,
          stopLoss: sig.stopLoss,
          target,
          text: `[${sig.source}] ${sig.reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }

      chartData.ema = candles
        .map((candle, idx) => {
          const ema = spppEmaValues[idx];
          if (ema == null) return null;
          const spppTs =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: spppTs, value: ema };
        })
        .filter((e: any) => e !== null);
    } else if (strategy === 'TRIPLE_SYNC') {
      // TRIPLE_SYNC: 200 EMA + ADX + SuperTrend alignment on 5-minute candles.
      // Always uses 5m candles regardless of the UI interval selector.
      // Fetches prior-session 5m candles to warm up the 200 EMA.
      const ts5mPrior = await kc.getHistoricalData(
        instrumentToken,
        '5minute',
        prevWindowFrom,
        yesterdayTo,
      );

      const ts5mToday = await kc.getHistoricalData(
        instrumentToken,
        '5minute',
        todayFrom,
        todayTo,
      );

      if (!ts5mToday || ts5mToday.length === 0) {
        // Fall through — no data, signals will be empty
      } else {
        const seedCandles = ts5mPrior && ts5mPrior.length > 0 ? ts5mPrior : [];
        const allCandles = [...seedCandles, ...ts5mToday];
        const seedCount = seedCandles.length;

        const tsSignals = detectTripleSyncSignals(allCandles, {
          debug: false,
          enableDiagLog: false,
        });

        for (const sig of tsSignals) {
          // Only emit signals that fell within today's candles
          if (sig.candleIndex < seedCount) continue;

          const c = allCandles[sig.candleIndex];
          const sigTs =
            c.date instanceof Date
              ? Math.floor(c.date.getTime() / 1000) + 19800
              : Math.floor(new Date(c.date as any).getTime() / 1000) + 19800;

          chartData.signals.push({
            time: sigTs,
            type: sig.signalType,
            price: sig.entryPrice,
            stopLoss: sig.stopLoss,
            target: sig.target1,
            text: sig.reason,
          });
        }

        // Build 200 EMA overlay aligned to today's candles only
        // Re-derive closes from allCandles for the EMA series
        const tsEmaFull = this.indicators.calculateEMA(
          allCandles.map((c) => c.close),
          200,
        );
        chartData.ema = ts5mToday
          .map((candle: any, idx: number) => {
            const ema = tsEmaFull[seedCount + idx];
            if (ema == null) return null;
            const tTs =
              candle.date instanceof Date
                ? Math.floor(candle.date.getTime() / 1000) + 19800
                : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
            return { time: tTs, value: ema };
          })
          .filter((e: any) => e !== null);
      }
    } else if (strategy === 'DAY_SELLING_V2_ENHANCED') {
      // DAY_SELLING_V2_ENHANCED: v2 upgraded with v4 quality filters.
      // Needs both 20 EMA + 8 EMA (for sideways detection), RSI, prev-day levels.
      const v2eYestDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let v2eYestHigh = 0;
      let v2ePrevDayLow = 0;
      let v2ePrevDayClose = 0;
      if (v2eYestDayData && v2eYestDayData.length > 0) {
        v2eYestHigh = v2eYestDayData[v2eYestDayData.length - 1].high;
        v2ePrevDayLow = v2eYestDayData[v2eYestDayData.length - 1].low;
        v2ePrevDayClose = v2eYestDayData[v2eYestDayData.length - 1].close;
        chartData.yesterdayHigh = v2eYestHigh;
      }

      const v2eYestIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      // 20 EMA with pre-seeding
      let ema20ValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
        const seedV2e = v2eYestIntradayData.slice(-25);
        const combinedV2e = [...seedV2e, ...candles];
        ema20ValuesV2e = this.indicators
          .calculateEMA(
            combinedV2e.map((c) => c.close),
            20,
          )
          .slice(seedV2e.length);
      } else {
        ema20ValuesV2e = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          20,
        );
      }

      // 8 EMA with pre-seeding
      let ema8ValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
        const seedV2e8 = v2eYestIntradayData.slice(-15);
        const combinedV2e8 = [...seedV2e8, ...candles];
        ema8ValuesV2e = this.indicators
          .calculateEMA(
            combinedV2e8.map((c) => c.close),
            8,
          )
          .slice(seedV2e8.length);
      } else {
        ema8ValuesV2e = this.indicators.calculateEMA(
          candles.map((c) => c.close),
          8,
        );
      }

      // Build EMA chart data (20 EMA)
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = ema20ValuesV2e[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return { time: timestamp, value: ema };
        })
        .filter((e: any) => e !== null);

      // RSI with pre-seeding
      let rsiValuesV2e: (number | null)[];
      if (v2eYestIntradayData && v2eYestIntradayData.length >= 14) {
        const seedRsiV2e = v2eYestIntradayData.slice(-30);
        const combinedRsiV2e = [...seedRsiV2e, ...candles];
        rsiValuesV2e = this.indicators
          .calculateRSI(
            combinedRsiV2e.map((c) => c.close),
            14,
          )
          .slice(seedRsiV2e.length);
      } else {
        rsiValuesV2e = this.indicators.calculateRSI(
          candles.map((c) => c.close),
          14,
        );
      }

      // Swing highs
      const swingHighsV2e: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const c = candles[i];
        const prev5 = candles.slice(i - 5, i);
        const next5 = candles.slice(i + 1, i + 6);
        if (
          prev5.every((p) => p.high < c.high) &&
          next5.every((n) => n.high < c.high)
        ) {
          swingHighsV2e.push({ price: c.high, index: i });
        }
      }

      const superTrendDataV2e = this.indicators.calculateSuperTrend(
        candles,
        10,
        2,
      );

      const chartInstrumentV2e = await this.prisma.instrument
        .findFirst({
          where: { instrumentToken: Number(instrumentToken) },
          select: { name: true },
        })
        .catch(() => null);
      const chartSymbolV2e = this.normalizeSettingsSymbol(
        chartInstrumentV2e?.name ?? 'NIFTY',
      );
      const chartSettingsV2e = await this.prisma.tradingSettings
        .findUnique({
          where: {
            userId_symbol: { userId: broker.userId, symbol: chartSymbolV2e },
          },
        })
        .catch(() => null);
      const chartMaxSellRiskPtsV2e = chartSettingsV2e?.maxSellRiskPts ?? 30;

      const daySellSignalsV2e = detectDaySellSignalsV2Enhanced({
        candles,
        ema20Values: ema20ValuesV2e,
        ema8Values: ema8ValuesV2e,
        rsiValues: rsiValuesV2e,
        swingHighs: swingHighsV2e,
        yesterdayHigh: v2eYestHigh,
        prevDayLow: v2ePrevDayLow,
        prevDayClose: v2ePrevDayClose,
        marginPoints,
        maxSellRiskPts: chartMaxSellRiskPtsV2e,
        superTrendData: superTrendDataV2e,
        instrumentName: instrumentToken,
      });

      for (const sig of daySellSignalsV2e) {
        const { unixTimestamp, reason, entryPrice, stopLoss, risk } = sig;
        const target = entryPrice - risk * 2;
        chartData.signals.push({
          time: unixTimestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${reason} (SL: ${risk.toFixed(1)}pts, Target: ${(risk * 2).toFixed(1)}pts)`,
        });
      }
    } else if (strategy === 'DAY_BUYING') {
      // DAY_BUYING Strategy: Only BUY signals using bullish patterns
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayDayData = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayLow = 0;
      if (yesterdayDayData && yesterdayDayData.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
        chartData.yesterdayLow = yesterdayLow;
        this.logger.debug(`Yesterday low = ${yesterdayLow}`);
      }

      // Fetch previous trading days' intraday data to pre-seed EMA calculation
      const yesterdayIntradayData = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );

      this.logger.debug(
        `Fetched ${yesterdayIntradayData?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      // Calculate 20 EMA with pre-seeding from yesterday's data
      let emaValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length > 0) {
        const yesterdayLast25 = yesterdayIntradayData.slice(-25);
        const combinedCandles = [...yesterdayLast25, ...candles];
        const combinedClosePrices = combinedCandles.map((c) => c.close);
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        emaValues = combinedEMA.slice(yesterdayLast25.length);
        this.logger.debug(
          `Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
        );
      } else {
        this.logger.warn(
          `No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
        );
        const closePrices = candles.map((c) => c.close);
        emaValues = this.indicators.calculateEMA(closePrices, 20);
      }

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const time =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: time,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // First candle low (9:15 AM)
      const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
      if (firstCandleLow > 0) {
        this.logger.debug(
          `First Candle Low (9:15 AM) = ${firstCandleLow.toFixed(2)} (BUY signals must be ABOVE this)`,
        );
      }

      // Calculate RSI for filtering (only BUY when RSI < 60)
      let rsiValues: (number | null)[];

      if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
        // Pre-seed RSI: Combine yesterday's candles + today's candles
        const yesterdayForRSI = yesterdayIntradayData.slice(-30);
        const combinedCandles = [...yesterdayForRSI, ...candles];
        const combinedClosePrices = combinedCandles.map((c: any) => c.close);

        // Calculate RSI on combined data
        const combinedRSI = this.indicators.calculateRSI(
          combinedClosePrices,
          14,
        );

        // Extract only today's RSI values
        rsiValues = combinedRSI.slice(yesterdayForRSI.length);

        this.logger.debug(
          `Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
        );
      } else {
        // Fallback: Standard RSI calculation
        const closePrices = candles.map((c: any) => c.close);
        rsiValues = this.indicators.calculateRSI(closePrices, 14);
      }

      // MAIN SIGNAL DETECTION LOOP
      for (let i = 3; i < candles.length; i++) {
        const candle = candles[i];
        const candleIST = new Date(candle.date);
        const candleHours = candleIST.getHours();
        const candleMinutes = candleIST.getMinutes();

        // Time filter: 9:30 AM - 2:30 PM
        if (candleHours < 9 || (candleHours === 9 && candleMinutes < 30)) {
          continue;
        }
        if (candleHours > 14 || (candleHours === 14 && candleMinutes >= 30)) {
          break;
        }

        const candleEMA = emaValues[i] ?? 0;
        const prev1 = i >= 1 ? candles[i - 1] : null;
        const prev2 = i >= 2 ? candles[i - 2] : null;

        const actualCandleOpen = candle.open;
        const actualCandleClose = candle.close;
        const actualCandleHigh = candle.high;
        const actualCandleLow = candle.low;
        const actualCandleBody = Math.abs(actualCandleClose - actualCandleOpen);
        const actualTotalRange = actualCandleHigh - actualCandleLow;
        const actualLowerWick =
          Math.min(actualCandleOpen, actualCandleClose) - actualCandleLow;
        const actualUpperWick =
          actualCandleHigh - Math.max(actualCandleOpen, actualCandleClose);

        const actualIsGreenCandle = actualCandleClose > actualCandleOpen;

        // EMA trend filter
        const trendMarginPoints = 35;
        const isAboveEMA = actualCandleClose > candleEMA;
        const isFarBelowEMA = actualCandleClose < candleEMA - trendMarginPoints;

        if (!isAboveEMA && !isFarBelowEMA && candleEMA > 0) {
          continue;
        }

        // Support detection
        const marginPoints = 5;
        const nearEMA =
          Math.abs(actualCandleLow - candleEMA) <= marginPoints &&
          candleEMA > 0;
        const nearYesterdayLow =
          Math.abs(actualCandleLow - yesterdayLow) <= marginPoints &&
          yesterdayLow > 0;

        let signalDetected = false;
        let signalReason = '';
        const candleRSI = rsiValues[i];

        // Two separate buy signal scenarios:

        // Scenario 1: Oversold Green Candle (any green candle when RSI < 40)
        if (actualIsGreenCandle && candleRSI != null && candleRSI < 40) {
          signalDetected = true;
          signalReason = `Oversold Green Candle (RSI ${candleRSI.toFixed(1)})`;
          this.logger.debug(
            `🔍 Scenario 1: Oversold green candle at ${i} (${candleIST.toLocaleTimeString('en-IN')}) | RSI: ${candleRSI.toFixed(1)} < 40`,
          );
        }

        // Scenario 2: EMA Crossover (opens below EMA, closes above EMA, RSI < 60)
        else if (
          actualCandleOpen < candleEMA &&
          actualCandleClose > candleEMA &&
          candleEMA > 0 &&
          candleRSI != null &&
          candleRSI < 60
        ) {
          signalDetected = true;
          signalReason = `EMA Crossover (RSI ${candleRSI.toFixed(1)})`;
          this.logger.debug(
            `🔍 Scenario 2: EMA crossover at ${i} (${candleIST.toLocaleTimeString('en-IN')}) | Open: ${actualCandleOpen.toFixed(2)} < EMA: ${candleEMA.toFixed(2)} < Close: ${actualCandleClose.toFixed(2)} | RSI: ${candleRSI.toFixed(1)} < 60`,
          );
        }

        if (signalDetected) {
          const entryPrice = actualCandleClose;

          this.logger.debug(
            `✅ BUY SIGNAL: ${signalReason} at ${actualCandleClose.toFixed(2)}`,
          );

          const stopLoss = actualCandleLow - 7;
          const risk = entryPrice - stopLoss;
          const target = entryPrice + risk * 2;

          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

          const buySignal = {
            time: timestamp,
            type: 'BUY',
            price: entryPrice,
            stopLoss,
            target,
            text: `${signalReason} (RSI ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'})`,
          };

          chartData.signals.push(buySignal);

          this.logger.log(
            `✅ BUY SIGNAL (${signalReason}) | RSI: ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | Target: ${target.toFixed(2)} | Time: ${timestamp}`,
          );
          this.logger.debug(`Signal object:`, JSON.stringify(buySignal));

          break; // Only one signal per chart
        }
      }
    } else if (strategy === 'SMART_SELL') {
      // SMART_SELL Strategy: Enhanced DAY_SELLING with RSI + Volume + Time filters
      // Fetch previous trading day data (wide window to handle holidays)
      const yesterdayHistorical = await kc.getHistoricalData(
        instrumentToken,
        'day',
        prevWindowFrom,
        yesterdayTo,
      );

      let yesterdayHigh = 0;
      if (yesterdayHistorical && yesterdayHistorical.length > 0) {
        // Take last element — the most recent trading day (handles holidays)
        yesterdayHigh =
          yesterdayHistorical[yesterdayHistorical.length - 1].high;
        chartData.yesterdayHigh = yesterdayHigh;
        this.logger.debug(`Yesterday high = ${yesterdayHigh}`);
      }

      // Calculate 20 EMA with pre-seeding from previous trading days
      const yesterdaySmartSell = await kc.getHistoricalData(
        instrumentToken,
        interval,
        prevWindowFrom,
        yesterdayTo,
      );
      this.logger.debug(
        `SMART_SELL: Fetched ${yesterdaySmartSell?.length || 0} candles from yesterday for EMA pre-seeding`,
      );

      let smartSellEmaValues: (number | null)[];
      let smartSellClosePrices: number[];
      if (yesterdaySmartSell && yesterdaySmartSell.length > 0) {
        const yesterdaySeed = yesterdaySmartSell.slice(-25);
        const combinedClosePrices = [
          ...yesterdaySeed.map((c: any) => c.close),
          ...candles.map((c) => c.close),
        ];
        const combinedEMA = this.indicators.calculateEMA(
          combinedClosePrices,
          20,
        );
        smartSellEmaValues = combinedEMA.slice(yesterdaySeed.length);
        this.logger.debug(
          `SMART_SELL: Pre-seeded EMA with ${yesterdaySeed.length} yesterday candles.`,
        );
      } else {
        this.logger.warn(
          `SMART_SELL: No yesterday data, using standard EMA calculation`,
        );
        smartSellClosePrices = candles.map((c) => c.close);
        smartSellEmaValues = this.indicators.calculateEMA(
          smartSellClosePrices,
          20,
        );
      }
      const emaValues = smartSellEmaValues;
      const closePrices = candles.map((c) => c.close);

      // Build EMA data for chart
      chartData.ema = candles
        .map((candle, idx) => {
          const ema = emaValues[idx];
          if (ema == null) return null;
          const timestamp =
            candle.date instanceof Date
              ? Math.floor(candle.date.getTime() / 1000) + 19800
              : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;
          return {
            time: timestamp,
            value: ema,
          };
        })
        .filter((e: any) => e !== null);

      // Calculate RSI (14-period)
      const rsiValues = this.indicators.calculateRSI(closePrices, 14);

      // Find swing highs (local peaks)
      const swingHighs: Array<{ price: number; index: number }> = [];
      for (let i = 5; i < candles.length - 5; i++) {
        const candle = candles[i];
        const prevCandles = candles.slice(i - 5, i);
        const nextCandles = candles.slice(i + 1, i + 6);

        const isLocalHigh =
          prevCandles.every((c) => c.high < candle.high) &&
          nextCandles.every((c) => c.high < candle.high);

        if (isLocalHigh) {
          swingHighs.push({ price: candle.high, index: i });
        }
      }

      this.logger.debug(`Found ${swingHighs.length} swing highs`);

      let lastSignalSL = 0;

      // === DAILY TRADING LIMITS ===
      let dailyTradesCount = 0;
      let dailyPnL = 0;
      let dailyStopTrading = false;
      const MAX_DAILY_TRADES = 2;
      const MAX_DAILY_LOSS = 35; // points

      // Scan for SELL signals (same patterns as DAY_SELLING but with filters)
      for (let i = 25; i < candles.length; i++) {
        // === CHECK DAILY LIMITS ===
        if (dailyStopTrading || dailyTradesCount >= MAX_DAILY_TRADES) {
          break; // Stop generating new signals for the day
        }

        const candle = candles[i];
        const candleOpen = candle.open;
        const candleHigh = candle.high;
        const candleLow = candle.low;
        const candleClose = candle.close;

        // ===== SMART_SELL FILTERS =====
        // Filter 1: Time window (10:30 AM - 2:30 PM)
        const candleDate =
          candle.date instanceof Date ? candle.date : new Date(candle.date);
        const candleHour = candleDate.getHours();
        const candleMinute = candleDate.getMinutes();
        const candleTimeInMinutes = candleHour * 60 + candleMinute;
        const timeFilterStart = 10 * 60 + 30; // 10:30 AM
        const timeFilterEnd = 14 * 60 + 30; // 2:30 PM

        if (
          candleTimeInMinutes < timeFilterStart ||
          candleTimeInMinutes > timeFilterEnd
        ) {
          continue; // Skip candles outside time window
        }

        // Filter 2: RSI > 60 (overbought)
        if (!rsiValues[i] || rsiValues[i]! <= 60) {
          continue;
        }

        // Filter 3: Volume confirmation
        const volumes = candles
          .slice(Math.max(0, i - 5), i)
          .map((c) => c.volume);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const volumeRatio = candle.volume / avgVolume;
        if (volumeRatio < 1.2) {
          continue; // Need at least 1.2x average volume
        }

        // Continue with pattern detection (same as DAY_SELLING)
        const candleBody = Math.abs(candleClose - candleOpen);
        const upperWick = candleHigh - Math.max(candleOpen, candleClose);
        const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
        const totalRange = candleHigh - candleLow;
        const isRedCandle = candleClose < candleOpen;
        const isGreenCandle = candleClose > candleOpen;

        const emaValue = emaValues[i];
        const prev1 = i > 0 ? candles[i - 1] : null;
        const prev2 = i > 1 ? candles[i - 2] : null;

        const entryPrice = candleClose;

        if (entryPrice <= lastSignalSL) {
          continue; // Skip if already signaled
        }

        const nearEMA =
          emaValue &&
          candleHigh >= emaValue * 0.995 && // widen: catch high touching EMA from below
          candleHigh <= emaValue * 1.015;
        const nearYesterdayHigh =
          yesterdayHigh > 0 &&
          candleHigh >= yesterdayHigh * 0.998 &&
          candleHigh <= yesterdayHigh * 1.01;

        let nearSwingHigh = false;
        for (const swingHigh of swingHighs) {
          if (
            candleHigh >= swingHigh.price * 0.998 &&
            candleHigh <= swingHigh.price * 1.01
          ) {
            nearSwingHigh = true;
            break;
          }
        }

        if (!nearEMA && !nearYesterdayHigh && !nearSwingHigh) {
          continue;
        }

        // Count pattern confirmations
        let confirmations = 0;
        const patterns: string[] = [];

        // Pattern 1: Weak close at resistance
        let resistanceTests = 0;
        for (let j = Math.max(0, i - 10); j < i; j++) {
          const testCandle = candles[j];
          if (
            (nearEMA && testCandle.high >= emaValue * 0.998) ||
            (nearYesterdayHigh && testCandle.high >= yesterdayHigh * 0.998) ||
            (nearSwingHigh &&
              swingHighs.some(
                (sh) =>
                  testCandle.high >= sh.price * 0.998 &&
                  testCandle.high <= sh.price * 1.01,
              ))
          ) {
            resistanceTests++;
          }
        }
        const weakCloseAtResistance =
          (isGreenCandle
            ? candleClose < candleOpen + candleBody * 0.5
            : true) && resistanceTests >= 2;
        if (weakCloseAtResistance) {
          confirmations++;
          patterns.push(`Weak Close (${resistanceTests} tests)`);
        }

        // Pattern 2: Early rejection
        const earlyRejection =
          (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
          upperWick > candleBody * 1.2 &&
          upperWick > totalRange * 0.4 &&
          candleClose < candleHigh * 0.99;
        if (earlyRejection) {
          confirmations++;
          patterns.push('Early Rejection');
        }

        // Pattern 3: Momentum slowing
        let momentumSlowing = false;
        if (prev2 && prev1) {
          const body2 = Math.abs(prev2.close - prev2.open);
          const body1 = Math.abs(prev1.close - prev1.open);
          momentumSlowing =
            candleBody < body1 && body1 < body2 && resistanceTests >= 2;
          if (momentumSlowing) {
            confirmations++;
            patterns.push('Momentum Slowing');
          }
        }

        // Pattern 4: Shooting star (red or green — green SS at EMA is valid with next red confirmation)
        const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
        const nextIsRed = nextCandle
          ? nextCandle.close < nextCandle.open
          : false;
        const isShootingStar =
          upperWick > candleBody * 2 &&
          lowerWick < candleBody * 0.5 &&
          upperWick > totalRange * 0.6 &&
          (isRedCandle || nextIsRed); // green SS valid only if followed by red confirmation
        if (isShootingStar) {
          confirmations++;
          patterns.push(isRedCandle ? 'Shooting Star' : 'Green Shooting Star');
        }

        // Pattern 5: Bearish engulfing
        const isBearishEngulfing =
          prev1 &&
          prev1.close > prev1.open &&
          candleOpen > prev1.close &&
          candleClose < prev1.open &&
          isRedCandle;
        if (isBearishEngulfing) {
          confirmations++;
          patterns.push('Bearish Engulfing');
        }

        // Pattern 6: Strong rejection
        const hasStrongRejection =
          isRedCandle &&
          upperWick > candleBody * 2 &&
          upperWick > totalRange * 0.5 &&
          candleClose < candleOpen * 0.98;
        if (hasStrongRejection) {
          confirmations++;
          patterns.push('Strong Rejection');
        }

        // Filter 4: Need at least 2 pattern confirmations
        if (confirmations < 2) {
          continue;
        }

        // Generate signal
        const stopLoss = candleHigh + 7;
        const risk = stopLoss - entryPrice;
        const target = entryPrice - risk * 2;
        const target1_3 = entryPrice - risk * 3;
        const target1_4 = entryPrice - risk * 4;

        const timestamp =
          candle.date instanceof Date
            ? Math.floor(candle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

        const signalReason = `${patterns.slice(0, 2).join(' + ')} | RSI:${Math.round(rsiValues[i]!)} | Vol:${volumeRatio.toFixed(1)}x`;

        chartData.signals.push({
          time: timestamp,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target,
          text: `${signalReason} (SL: ${risk.toFixed(1)}pts)`,
        });

        lastSignalSL = stopLoss;
        dailyTradesCount++; // Increment daily trades count

        this.logger.debug(
          `SMART_SELL signal ${dailyTradesCount}: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)}`,
        );

        // Look ahead to check if this trade hits SL or Target
        let tradeCompleted = false;
        for (let j = i + 1; j < candles.length && !tradeCompleted; j++) {
          const futureCandle = candles[j];

          // Check if SL hit (price goes above SL for SELL)
          if (futureCandle.high >= stopLoss) {
            const loss = stopLoss - entryPrice;
            dailyPnL -= loss;
            tradeCompleted = true;

            this.logger.debug(
              `Trade ${dailyTradesCount} SL HIT at ${stopLoss.toFixed(2)}, Loss: ${loss.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );

            // Check if max daily loss reached (30-35 points)
            if (Math.abs(dailyPnL) >= MAX_DAILY_LOSS) {
              dailyStopTrading = true;
              this.logger.log(
                `MAX DAILY LOSS REACHED: ${Math.abs(dailyPnL).toFixed(1)} pts. Stopping trading for the day.`,
              );
            }
            break;
          }

          // Check targets (highest to lowest for better profit)
          if (futureCandle.low <= target1_4) {
            const profit = entryPrice - target1_4;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:4 HIT at ${target1_4.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          } else if (futureCandle.low <= target1_3) {
            const profit = entryPrice - target1_3;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:3 HIT at ${target1_3.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          } else if (futureCandle.low <= target) {
            const profit = entryPrice - target;
            dailyPnL += profit;
            tradeCompleted = true;
            this.logger.debug(
              `Trade ${dailyTradesCount} TARGET 1:2 HIT at ${target.toFixed(2)}, Profit: ${profit.toFixed(1)} pts, Daily P/L: ${dailyPnL.toFixed(1)} pts`,
            );
            dailyStopTrading = true; // Stop trading after hitting any target
            this.logger.log('TARGET HIT. Stopping trading for the day.');
            break;
          }
        }

        // If daily stop triggered, break out of main loop
        if (dailyStopTrading) {
          break;
        }
      }
    } else if (strategy === 'TREND_NIFTY') {
      // TREND_NIFTY Chart: SELL signal at first candle >= 9:30 IST
      // SL = entry + SL_PTS, T1 (1:2) → breakeven, T2/T3 trail
      const SL_PTS = marginPoints > 0 ? marginPoints : 30;

      let signalCandle: any = null;
      let signalIndex = -1;
      for (let i = 0; i < candles.length; i++) {
        const t =
          candles[i].date instanceof Date
            ? candles[i].date
            : new Date(candles[i].date);
        const istMinutes =
          (t.getUTCHours() * 60 + t.getUTCMinutes() + 330) % 1440;
        const istHour = Math.floor(istMinutes / 60);
        const istMin = istMinutes % 60;
        if (istHour > 9 || (istHour === 9 && istMin >= 30)) {
          signalCandle = candles[i];
          signalIndex = i;
          break;
        }
      }

      if (signalCandle) {
        const entryPrice = signalCandle.close;
        const stopLoss = entryPrice + SL_PTS;
        const t1_2 = entryPrice - SL_PTS * 2;
        const ts =
          signalCandle.date instanceof Date
            ? Math.floor(signalCandle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(signalCandle.date).getTime() / 1000) + 19800;

        chartData.signals.push({
          time: ts,
          type: 'SELL',
          price: entryPrice,
          stopLoss,
          target: t1_2,
          text: `TREND NIFTY SELL \u2014 SL:+${SL_PTS}pts | T1:${SL_PTS * 2}pts | T2:${SL_PTS * 3}pts | T3:${SL_PTS * 4}pts`,
        });

        // Simulate SL / target management across remaining candles
        let activeSL = stopLoss;
        let t1Hit = false;
        let trailLow = entryPrice;
        for (let j = signalIndex + 1; j < candles.length; j++) {
          const fc = candles[j];
          if (fc.high >= activeSL) break; // SL hit
          if (fc.low <= entryPrice - SL_PTS * 4) break; // T3 exit
          if (fc.low <= entryPrice - SL_PTS * 3) break; // T2 exit
          if (!t1Hit && fc.low <= t1_2) {
            t1Hit = true;
            activeSL = entryPrice; // Move to breakeven
            trailLow = fc.low;
          }
          if (t1Hit && fc.low < trailLow) {
            trailLow = fc.low;
            activeSL = Math.min(activeSL, trailLow + 10); // Trail SL
          }
        }
      }
    }

    // Calculate trade statistics with detailed trade information
    let slHits = 0;
    let targetHits = 0;
    let totalProfit = 0;
    const detailedTrades: any[] = [];

    chartData.signals.forEach((signal: any, index: number) => {
      const signalIndex = candles.findIndex((c: any) => {
        const candleTimestamp =
          c.date instanceof Date
            ? Math.floor(c.date.getTime() / 1000) + 19800
            : Math.floor(new Date(c.date).getTime() / 1000) + 19800;
        return candleTimestamp === signal.time;
      });

      if (signalIndex === -1) return;

      const trade: any = {
        entryLogic: signal.text || 'Signal detected',
        entryPrice: signal.price,
        exitPrice: null,
        exitReason: 'OPEN',
        profitLoss: 0,
        entryTime: signal.time,
        exitTime: null,
      };

      // Check subsequent candles to see if SL or Target was hit
      for (let i = signalIndex + 1; i < candles.length; i++) {
        const candle = candles[i];
        const candleTimestamp =
          candle.date instanceof Date
            ? Math.floor(candle.date.getTime() / 1000) + 19800
            : Math.floor(new Date(candle.date).getTime() / 1000) + 19800;

        if (signal.type === 'BUY') {
          // Check if SL hit (price goes below SL)
          if (candle.low <= signal.stopLoss) {
            slHits++;
            const loss = signal.price - signal.stopLoss;
            totalProfit -= loss;
            trade.exitPrice = signal.stopLoss;
            trade.exitReason = 'SL_HIT';
            trade.profitLoss = -loss;
            trade.exitTime = candleTimestamp;
            break;
          }
          // Check if Target hit (price goes above Target)
          if (candle.high >= signal.target) {
            targetHits++;
            const profit = signal.target - signal.price;
            totalProfit += profit;
            trade.exitPrice = signal.target;
            trade.exitReason = 'TARGET_HIT';
            trade.profitLoss = profit;
            trade.exitTime = candleTimestamp;
            break;
          }
        } else {
          // SELL trade
          // Check if SL hit (price goes above SL)
          if (candle.high >= signal.stopLoss) {
            slHits++;
            const loss = signal.stopLoss - signal.price;
            totalProfit -= loss;
            trade.exitPrice = signal.stopLoss;
            trade.exitReason = 'SL_HIT';
            trade.profitLoss = -loss;
            trade.exitTime = candleTimestamp;
            break;
          }
          // Check if Target hit (price goes below Target)
          if (candle.low <= signal.target) {
            targetHits++;
            const profit = signal.price - signal.target;
            totalProfit += profit;
            trade.exitPrice = signal.target;
            trade.exitReason = 'TARGET_HIT';
            trade.profitLoss = profit;
            trade.exitTime = candleTimestamp;
            break;
          }
        }
      }

      detailedTrades.push(trade);
    });

    const openTrades = chartData.signals.length - slHits - targetHits;

    const buySignals = chartData.signals.filter(
      (s: any) => s.type === 'BUY',
    ).length;
    const sellSignals = chartData.signals.filter(
      (s: any) => s.type === 'SELL',
    ).length;

    chartData.statistics = {
      totalTrades: chartData.signals.length,
      slHits,
      targetHits,
      openTrades,
      totalProfitPerLot: Math.round(totalProfit * 100) / 100, // Round to 2 decimals
      trades: detailedTrades, // Detailed trade-by-trade information
    };

    this.logger.log(
      `Returning chart data: ${chartData.candles.length} candles, ${chartData.signals.length} signals (${buySignals} BUY, ${sellSignals} SELL), EMA points: ${chartData.ema.length}`,
    );
    this.logger.log(
      `Trade Statistics: Total=${chartData.statistics.totalTrades}, SL Hits=${chartData.statistics.slHits}, Target Hits=${chartData.statistics.targetHits}, Profit/Lot=${chartData.statistics.totalProfitPerLot}`,
    );

    // Debug log for signals
    if (chartData.signals.length > 0) {
      this.logger.debug(
        `📊 Signals in response: ${JSON.stringify(chartData.signals.map((s: any) => ({ type: s.type, time: s.time, text: s.text })))}`,
      );
    }

    return chartData;
  }

  /**
   * Returns the nearest NIFTY option expiry date on or after `dateStr` by
   * querying the Instrument DB table (updated daily from Kite instruments download).
   */
  private async getSimulationExpiry(dateStr: string): Promise<string> {
    const row = await this.prisma.instrument.findFirst({
      where: {
        tradingsymbol: { startsWith: 'NIFTY' },
        segment: { in: ['NFO-OPT', 'NFO'] },
        instrumentType: { in: ['CE', 'PE'] },
        expiry: { not: null, gte: dateStr },
      },
      select: { expiry: true },
      orderBy: { expiry: 'asc' },
    });

    if (!row?.expiry) {
      throw new Error(
        `[SIM] No NIFTY expiry found in Instrument DB for date ${dateStr}. ` +
          `Make sure instruments are downloaded and include contracts expiring on or after ${dateStr}.`,
      );
    }

    return row.expiry;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Strategies that use the single-strike (1 CE + 1 PE) lock mechanism.
   * Strike selection is persisted in the StrikeSelection table so all scans
   * throughout the day (and for past dates) use the exact same instruments.
   */
  static readonly STRIKE_LOCK_STRATEGIES = [
    'DAY_SELLING',
    'DAY_SELLING_V2',
    'DAY_SELLING_V2_ENHANCED',
    'DAY_SELLING_V1V2',
    'DAY_SELLING_V3',
    'DAY_SELLING_V4',
    'DAY_HIGH_REJECTION',
    'DAY_LOW_BREAK',
    'EMA_REJECTION',
    'SUPER_POWER_PACK',
    'TRIPLE_SYNC',
    'DAY_REVERSAL',
  ] as const;

  /**
   * Selects the ATM-based CE + PE option instruments for the given broker,
   * symbol, and trading date, then persists the result to the StrikeSelection
   * table (upsert).  Returns the CE and PE instrument objects that can be
   * passed directly to optionMonitor as limitedInstruments.
   *
   * The spot price used is always the 9:15 AM candle OPEN for the given date
   * (fetched from Kite historical API), ensuring that past-date replays use
   * the actual opening price rather than today's live price.
   *
   * If the record already exists in the DB the existing row is returned
   * without re-fetching historical data.
   */
  async selectAndSaveStrike(
    brokerId: string,
    symbol: string,
    date: string, // "YYYY-MM-DD"
    expiry: string, // "YYYY-MM-DD"
    instrumentSource: 'live' | 'db' = 'live',
  ): Promise<{ ceInstrument: any; peInstrument: any } | null> {
    try {
      // ── 1. Check if already saved ─────────────────────────────────────────
      const existing = await this.prisma.strikeSelection.findUnique({
        where: { brokerId_symbol_date: { brokerId, symbol, date } },
      });
      if (existing) {
        this.logger.log(
          `[StrikeSelection] Cache hit for ${symbol} on ${date}: ` +
            `CE ${existing.ceTradingSymbol} / PE ${existing.peTradingSymbol}`,
        );
        // Return lightweight instrument objects the same shape optionMonitor expects
        const ce = {
          instrument_token: existing.ceInstrumentToken,
          tradingsymbol: existing.ceTradingSymbol,
          strike: existing.ceStrike,
          instrument_type: 'CE',
          name: symbol,
          expiry: existing.expiry,
          exchange: symbol === 'SENSEX' ? 'BFO' : 'NFO',
          segment: symbol === 'SENSEX' ? 'BFO-OPT' : 'NFO-OPT',
          lot_size: symbol === 'BANKNIFTY' ? 30 : symbol === 'SENSEX' ? 20 : 65,
          tick_size: 0.05,
          last_price: 0,
          exchange_token: 0,
        };
        const pe = {
          instrument_token: existing.peInstrumentToken,
          tradingsymbol: existing.peTradingSymbol,
          strike: existing.peStrike,
          instrument_type: 'PE',
          name: symbol,
          expiry: existing.expiry,
          exchange: symbol === 'SENSEX' ? 'BFO' : 'NFO',
          segment: symbol === 'SENSEX' ? 'BFO-OPT' : 'NFO-OPT',
          lot_size: symbol === 'BANKNIFTY' ? 30 : symbol === 'SENSEX' ? 20 : 65,
          tick_size: 0.05,
          last_price: 0,
          exchange_token: 0,
        };
        return { ceInstrument: ce, peInstrument: pe };
      }

      // ── 2. Get broker + create KiteConnect ────────────────────────────────
      const broker = await this.prisma.broker.findUnique({
        where: { id: brokerId },
      });
      if (!broker?.apiKey || !broker.accessToken) {
        this.logger.warn(
          `[StrikeSelection] Broker ${brokerId} not found or missing credentials`,
        );
        return null;
      }
      const kc = new KiteConnect({ api_key: broker.apiKey });
      kc.setAccessToken(broker.accessToken);

      // ── 3. Find index instrument token ────────────────────────────────────
      const instruments = await this.kiteService.getInstruments();
      const indexInstrument = instruments.find(
        (i) =>
          i.segment === 'INDICES' &&
          ((symbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
            (symbol === 'BANKNIFTY' && i.tradingsymbol === 'NIFTY BANK') ||
            (symbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
            (symbol === 'SENSEX' && i.tradingsymbol === 'SENSEX') ||
            (symbol === 'MIDCPNIFTY' &&
              i.tradingsymbol === 'NIFTY MIDCAP SELECT')),
      );
      if (!indexInstrument) {
        this.logger.warn(
          `[StrikeSelection] Could not find index instrument for ${symbol}`,
        );
        return null;
      }

      // ── 4. Fetch 9:15 AM 5-minute candle to get opening spot price ────────
      let spotAtOpen = 0;

      if (instrumentSource === 'db') {
        // In DB (historic) mode: get 9:15 open from CandleCache for the index token.
        // Fall back to midpoint of available option strikes if index not cached.
        try {
          const row = await this.prisma.candleCache.findUnique({
            where: {
              instrumentToken_dateStr_interval: {
                instrumentToken: indexInstrument.instrument_token,
                dateStr: date,
                interval: '5minute',
              },
            },
            select: { candlesJson: true },
          });
          if (row) {
            const candles = JSON.parse(row.candlesJson) as any[];
            if (candles.length > 0) {
              spotAtOpen = candles[0].open;
              this.logger.log(
                `[StrikeSelection] ${symbol} 9:15 open on ${date} (CandleCache): ${spotAtOpen}`,
              );
            }
          }
        } catch {
          // ignore — will fall back to instrument midpoint below
        }

        if (spotAtOpen === 0) {
          // Derive ATM from midpoint of available option strikes in DB
          const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';
          const strikeRows = await this.prisma.instrument
            .findMany({
              where: {
                tradingsymbol: { startsWith: symbol },
                exchange,
                instrumentType: { in: ['CE', 'PE'] },
                expiry,
              },
              select: { strike: true },
            })
            .catch(() => []);
          const strikes = strikeRows.map((r) => r.strike).filter((s) => s > 0);
          if (strikes.length > 0) {
            spotAtOpen = (Math.min(...strikes) + Math.max(...strikes)) / 2;
            this.logger.warn(
              `[StrikeSelection] No 9:15 candle for ${symbol} index in CandleCache — ` +
                `using strike midpoint as ATM approximation: ${spotAtOpen}`,
            );
          }
        }
      } else {
        try {
          const candles = await kc.getHistoricalData(
            indexInstrument.instrument_token,
            '5minute',
            `${date} 09:15:00`,
            `${date} 09:20:00`,
          );
          if (candles && candles.length > 0) {
            spotAtOpen = candles[0].open;
            this.logger.log(
              `[StrikeSelection] ${symbol} 9:15 open on ${date}: ${spotAtOpen}`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `[StrikeSelection] Could not fetch 9:15 candle for ${symbol} on ${date}: ${err.message}`,
          );
        }
      }

      if (spotAtOpen === 0) {
        this.logger.warn(
          `[StrikeSelection] No spot price for ${symbol} on ${date} — cannot select strike`,
        );
        return null;
      }

      // ── 5. Compute ATM, CE strike, PE strike ──────────────────────────────
      const strikeInterval =
        symbol === 'BANKNIFTY' || symbol === 'SENSEX' ? 100 : 50;
      const atmStrike =
        Math.round(spotAtOpen / strikeInterval) * strikeInterval;
      const ceStrike = atmStrike - strikeInterval * 2;
      const peStrike = atmStrike + strikeInterval * 2;

      this.logger.log(
        `[StrikeSelection] ${symbol} on ${date}: spot=${spotAtOpen} ATM=${atmStrike} CE=${ceStrike} PE=${peStrike} expiry=${expiry}`,
      );

      // ── 6. Look up CE + PE instruments from DB ────────────────────────────
      const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';

      const findNearest = async (type: 'CE' | 'PE', targetStrike: number) => {
        const rows = await this.prisma.instrument.findMany({
          where: {
            tradingsymbol: { startsWith: symbol },
            exchange,
            instrumentType: type,
            expiry,
          },
          select: {
            instrumentToken: true,
            tradingsymbol: true,
            strike: true,
            expiry: true,
            lotSize: true,
            tickSize: true,
            instrumentType: true,
            segment: true,
            exchange: true,
            exchangeToken: true,
            name: true,
            lastPrice: true,
          },
        });
        if (rows.length === 0) return null;
        const exact = rows.find((r) => r.strike === targetStrike);
        if (exact) return exact;
        return rows.reduce((best, curr) =>
          Math.abs(curr.strike - targetStrike) <
          Math.abs(best.strike - targetStrike)
            ? curr
            : best,
        );
      };

      const [ceRow, peRow] = await Promise.all([
        findNearest('CE', ceStrike),
        findNearest('PE', peStrike),
      ]);

      if (!ceRow || !peRow) {
        this.logger.warn(
          `[StrikeSelection] Could not find CE(${ceStrike}) or PE(${peStrike}) ` +
            `for ${symbol} expiry ${expiry} in DB. Run instrument sync first.`,
        );
        return null;
      }

      if (ceRow.strike !== ceStrike) {
        this.logger.warn(
          `[StrikeSelection] CE exact strike ${ceStrike} not in DB — using nearest: ${ceRow.strike} (${ceRow.tradingsymbol})`,
        );
      }
      if (peRow.strike !== peStrike) {
        this.logger.warn(
          `[StrikeSelection] PE exact strike ${peStrike} not in DB — using nearest: ${peRow.strike} (${peRow.tradingsymbol})`,
        );
      }

      // ── 7. Upsert StrikeSelection DB record ───────────────────────────────
      await this.prisma.strikeSelection.upsert({
        where: { brokerId_symbol_date: { brokerId, symbol, date } },
        create: {
          brokerId,
          symbol,
          date,
          expiry,
          niftySpotAtOpen: spotAtOpen,
          atmStrike,
          ceTradingSymbol: ceRow.tradingsymbol,
          ceStrike: ceRow.strike,
          ceInstrumentToken: ceRow.instrumentToken,
          peTradingSymbol: peRow.tradingsymbol,
          peStrike: peRow.strike,
          peInstrumentToken: peRow.instrumentToken,
        },
        update: {
          expiry,
          niftySpotAtOpen: spotAtOpen,
          atmStrike,
          ceTradingSymbol: ceRow.tradingsymbol,
          ceStrike: ceRow.strike,
          ceInstrumentToken: ceRow.instrumentToken,
          peTradingSymbol: peRow.tradingsymbol,
          peStrike: peRow.strike,
          peInstrumentToken: peRow.instrumentToken,
          selectedAt: new Date(),
        },
      });

      this.logger.log(
        `[StrikeSelection] Saved: ${symbol} ${date} CE=${ceRow.tradingsymbol} PE=${peRow.tradingsymbol}`,
      );

      // ── 8. Return instrument objects (same shape as Kite API response) ────
      const mapRow = (r: typeof ceRow) => ({
        instrument_token: r.instrumentToken,
        exchange_token: r.exchangeToken,
        tradingsymbol: r.tradingsymbol,
        name: r.name ?? symbol,
        last_price: r.lastPrice,
        expiry: r.expiry ?? expiry,
        strike: r.strike,
        tick_size: r.tickSize,
        lot_size: r.lotSize,
        instrument_type: r.instrumentType,
        segment: r.segment,
        exchange: r.exchange,
      });

      return { ceInstrument: mapRow(ceRow), peInstrument: mapRow(peRow) };
    } catch (err) {
      this.logger.error(
        `[StrikeSelection] Error in selectAndSaveStrike: ${err.message}`,
        err.stack,
      );
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Option Monitor: Find options using selected trading strategy.
   *
   * Strategies:
   * - PREV_DAY_HIGH_LOW: Find options near yesterday's high or low (IMPLEMENTED)
   * - 20_EMA: Find options based on 20 EMA rejection (TODO: To be implemented next)
   */
  async optionMonitor(
    brokerId: string,
    symbol: string,
    expiry: string,
    marginPoints: number,
    targetDate: string,
    interval:
      | 'day'
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute',
    specificTime: string,
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_SELLING_V4'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY'
      | 'DAY_HIGH_REJECTION'
      | 'DAY_LOW_BREAK'
      | 'EMA_REJECTION'
      | 'SUPER_POWER_PACK'
      | 'DAY_REVERSAL'
      | 'TRIPLE_SYNC' = 'PREV_DAY_HIGH_LOW',
    realtimeMode: boolean = false,
    instrumentSource: 'live' | 'db' = 'live',
    lockedInstruments?: any[],
  ): Promise<{ options: any[]; selectedInstruments?: any[] }> {
    try {
      const broker = await this.prisma.broker.findUnique({
        where: { id: brokerId },
      });

      if (!broker) {
        throw new Error('Broker not found. Please add a broker first.');
      }

      if (!broker.apiKey) {
        throw new Error('API key not configured for this broker.');
      }

      if (!broker.accessToken) {
        throw new Error(
          'Access token missing. Please reconnect your broker account.',
        );
      }

      const kc = new KiteConnect({ api_key: broker.apiKey });
      kc.setAccessToken(broker.accessToken);

      // ── TREND_NIFTY: dedicated early-return path ─────────────────────────
      if (strategy === 'TREND_NIFTY') {
        const instruments = await this.kiteService.getInstruments();
        return executeTrendNiftyStrategy(
          kc,
          marginPoints,
          targetDate,
          instruments,
          this.indicators,
          this.logger,
          interval,
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      this.logger.log(
        `Option Monitor: Using strategy=${strategy} for ${symbol} expiry=${expiry}`,
      );

      // Canonical lot sizes — these are the current NSE/BSE contract sizes.
      // `inst.lot_size` from the instruments CSV is authoritative for live mode,
      // but may be stale in DB mode (expired rows keep the lot size from the
      // day they were last synced).  Always prefer the canonical map for known
      // symbols and fall back to inst.lot_size for anything else.
      const canonicalLotSize = (sym: string, instLot: number): number => {
        const map: Record<string, number> = {
          NIFTY: 65,
          BANKNIFTY: 30,
          FINNIFTY: 65,
          SENSEX: 20,
          MIDCPNIFTY: 75,
        };
        return map[sym] ?? instLot ?? 1;
      };

      // Get instruments for the symbol and expiry
      const instruments = await this.kiteService.getInstruments();

      // ── SPOT MODE: run strategy directly on the index instrument (no options) ──
      if (symbol.endsWith('_SPOT')) {
        const baseSymbol = symbol.replace('_SPOT', '');
        const indexInst = instruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            ((baseSymbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
              (baseSymbol === 'BANKNIFTY' &&
                i.tradingsymbol === 'NIFTY BANK') ||
              (baseSymbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
              (baseSymbol === 'SENSEX' && i.tradingsymbol === 'SENSEX') ||
              (baseSymbol === 'MIDCPNIFTY' &&
                i.tradingsymbol === 'NIFTY MIDCAP SELECT')),
        );
        if (!indexInst) {
          this.logger.warn(
            `[SPOT] Could not find index instrument for ${baseSymbol}`,
          );
          return { options: [] };
        }

        const todayStr = new Date(targetDate).toISOString().split('T')[0];
        const todayFrom = `${todayStr} 09:15:00`;
        const todayTo = `${todayStr} 15:30:00`;
        const prevWindowStart = new Date(targetDate);
        prevWindowStart.setDate(prevWindowStart.getDate() - 7);
        const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;
        const prevWindowEnd = new Date(targetDate);
        prevWindowEnd.setDate(prevWindowEnd.getDate() - 1);
        const yesterdayTo = `${prevWindowEnd.toISOString().split('T')[0]} 15:30:00`;

        this.logger.log(
          `[SPOT] ${baseSymbol} token=${indexInst.instrument_token}, date=${todayStr}, interval=${interval}, strategy=${strategy}`,
        );

        // ── TRIPLE_SYNC: dedicated 5-minute path ─────────────────────────────
        if (strategy === 'TRIPLE_SYNC') {
          // Detect direction signals on NIFTY SPOT 5m candles.
          //   BUY signal  → buy  CE  (profit when CE price rises)
          //   SELL signal → buy  PE  (profit when PE price rises, i.e. index falls)
          //
          // Instruments are resolved from the DB-locked strike (STRIKE_LOCK mechanism).
          // selectAndSaveStrike returns the cached DB record immediately if it exists.
          const tsStrikes = await this.selectAndSaveStrike(
            brokerId,
            baseSymbol,
            todayStr,
            expiry || '',
            instrumentSource,
          );

          if (!tsStrikes) {
            this.logger.warn(
              `[SPOT][TRIPLE_SYNC] No locked CE/PE instruments found for ${baseSymbol} on ${todayStr} — ` +
                `please select a strike via the Trade Finder lock button first.`,
            );
            return { options: [] };
          }

          const tsLockedCE = tsStrikes.ceInstrument;
          const tsLockedPE = tsStrikes.peInstrument;

          const TS_CE_TOKEN: number = tsLockedCE.instrument_token;
          const TS_CE_SYMBOL: string = tsLockedCE.tradingsymbol;
          const TS_CE_STRIKE: number = tsLockedCE.strike;
          const TS_PE_TOKEN: number = tsLockedPE.instrument_token;
          const TS_PE_SYMBOL: string = tsLockedPE.tradingsymbol;
          const TS_PE_STRIKE: number = tsLockedPE.strike;

          // ── Fetch NIFTY SPOT 5m candles (prior window for 200 EMA warmup) ──
          const ts5mPrior = await kc.getHistoricalData(
            indexInst.instrument_token,
            '5minute',
            prevWindowFrom,
            yesterdayTo,
          );
          const ts5mToday = await kc.getHistoricalData(
            indexInst.instrument_token,
            '5minute',
            todayFrom,
            todayTo,
          );

          if (!ts5mToday || ts5mToday.length < 5) {
            this.logger.warn(
              `[SPOT][TRIPLE_SYNC] Not enough 5m candles for ${baseSymbol}`,
            );
            return { options: [] };
          }

          // ── Fetch CE and PE option 5m candles for the same day ──────────
          const [tsCeRaw, tsPeRaw] = await Promise.all([
            kc
              .getHistoricalData(TS_CE_TOKEN, '5minute', todayFrom, todayTo)
              .catch(() => []),
            kc
              .getHistoricalData(TS_PE_TOKEN, '5minute', todayFrom, todayTo)
              .catch(() => []),
          ]);

          // ── Filter all to specificTime window ─────────────────────────────
          const [tsTargetHour, tsTargetMin] = specificTime
            .split(':')
            .map(Number);
          const tsTimeFilter = (c: any) => {
            const d = new Date(c.date);
            return (
              d.getHours() < tsTargetHour ||
              (d.getHours() === tsTargetHour && d.getMinutes() <= tsTargetMin)
            );
          };
          const ts5mUpToTime = ts5mToday.filter(tsTimeFilter);
          const tsCeUpToTime: any[] = (tsCeRaw as any[]).filter(tsTimeFilter);
          const tsPeUpToTime: any[] = (tsPeRaw as any[]).filter(tsTimeFilter);

          // ── Build time→index maps for CE and PE candles (key: "HH:MM") ──
          const buildTimeMap = (candles: any[]): Map<string, number> => {
            const map = new Map<string, number>();
            candles.forEach((c: any, idx: number) => {
              const d = new Date(c.date);
              const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
              map.set(key, idx);
            });
            return map;
          };
          const tsCeTimeMap = buildTimeMap(tsCeUpToTime);
          const tsPeTimeMap = buildTimeMap(tsPeUpToTime);

          // Helper: resolve option candle index aligned to a spot candle index
          const optIdxAt = (
            spotIdx: number,
            timeMap: Map<string, number>,
          ): number => {
            const sc = ts5mUpToTime[spotIdx];
            if (!sc) return -1;
            const d = new Date(sc.date);
            const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return timeMap.get(key) ?? -1;
          };

          // ── Signal detection on SPOT candles ──────────────────────────────
          const tsSeedCandles =
            ts5mPrior && ts5mPrior.length > 0 ? ts5mPrior : [];
          const tsAllCandles = [...tsSeedCandles, ...ts5mUpToTime];
          const tsSeedCount = tsSeedCandles.length;

          const tsSignals = detectTripleSyncSignals(tsAllCandles, {
            debug: false,
            enableDiagLog: true,
          });
          const tsTodaySignals = tsSignals.filter(
            (s) => s.candleIndex >= tsSeedCount,
          );

          // ── Lot / qty setup ───────────────────────────────────────────────
          const tsPaperSettings = await this.prisma.tradingSettings
            .findUnique({
              where: {
                userId_symbol: { userId: broker.userId, symbol: baseSymbol },
              },
            })
            .catch(() => null);
          const tsLotSizes: Record<string, number> = {
            NIFTY: 65,
            BANKNIFTY: 30,
            FINNIFTY: 65,
            SENSEX: 20,
            MIDCPNIFTY: 75,
          };
          const tsLotSize = tsLotSizes[baseSymbol] ?? 1;
          const tsPaperLots = tsPaperSettings?.paperLots ?? 1;
          const tsTotalQty = tsPaperLots * tsLotSize;
          const tsHalfQty = Math.floor(tsTotalQty / 2);
          const tsRemainingQty = tsTotalQty - tsHalfQty;
          // EOD option close (per option type) — used when trade is still OPEN at session end
          const tsEodCeClose =
            tsCeUpToTime.length > 0
              ? tsCeUpToTime[tsCeUpToTime.length - 1].close
              : 0;
          const tsEodPeClose =
            tsPeUpToTime.length > 0
              ? tsPeUpToTime[tsPeUpToTime.length - 1].close
              : 0;

          // ── Per-signal loop ───────────────────────────────────────────────
          const tsOutputSignals: any[] = [];
          // One trade at a time per direction — new signal skipped until active
          // trade in that direction resolves (SL / target / EOD).
          let activeBuyClosedAt = -1; // spot candle index at which last BUY closed
          let activeSellClosedAt = -1; // spot candle index at which last SELL closed

          for (const sig of tsTodaySignals) {
            const {
              entryPrice: spotEntry,
              stopLoss,
              risk,
              target1: t1,
              target2: t2,
              target3: t3,
              signalType,
              candleTime,
              candleDate,
              reason: sigReason,
              candleIndex,
            } = sig;
            const actualIdx = candleIndex - tsSeedCount; // index into ts5mUpToTime
            const isBuy = signalType === 'BUY';

            // Gate: skip if same-direction trade is still open
            if (isBuy && activeBuyClosedAt >= actualIdx) continue;
            if (!isBuy && activeSellClosedAt >= actualIdx) continue;

            // Option entry price at signal candle close
            // BUY signal → use CE; SELL signal → use PE
            const tsOptUpToTime = isBuy ? tsCeUpToTime : tsPeUpToTime;
            const tsOptTimeMap = isBuy ? tsCeTimeMap : tsPeTimeMap;
            const tsEodOptClose = isBuy ? tsEodCeClose : tsEodPeClose;
            const tsOptSymbol = isBuy ? TS_CE_SYMBOL : TS_PE_SYMBOL;

            const optEntryIdx = optIdxAt(actualIdx, tsOptTimeMap);
            const optEntryPrice =
              optEntryIdx >= 0 ? tsOptUpToTime[optEntryIdx].close : null;

            // ── Outcome simulation on SPOT price ──────────────────────────
            let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
            let t1HitSpotIdx = -1;
            let closeSpotIdx = ts5mUpToTime.length - 1; // EOD default

            for (let j = actualIdx + 1; j < ts5mUpToTime.length; j++) {
              const fc = ts5mUpToTime[j];
              const t1Hit = isBuy ? fc.high >= t1 : fc.low <= t1;
              const slHit = isBuy ? fc.low <= stopLoss : fc.high >= stopLoss;
              if (t1Hit) {
                t1HitSpotIdx = j;
                break;
              }
              if (slHit) {
                outcome = 'SL';
                closeSpotIdx = j;
                break;
              }
            }
            if (t1HitSpotIdx >= 0) {
              let phase2Done = false;
              for (let j = t1HitSpotIdx; j < ts5mUpToTime.length; j++) {
                const fc = ts5mUpToTime[j];
                const beHit = isBuy
                  ? fc.low <= spotEntry
                  : fc.high >= spotEntry;
                const t3Hit = isBuy ? fc.high >= t3 : fc.low <= t3;
                const t2Hit = isBuy ? fc.high >= t2 : fc.low <= t2;
                if (beHit) {
                  outcome = 'BE';
                  closeSpotIdx = j;
                  phase2Done = true;
                  break;
                }
                if (t3Hit) {
                  outcome = 'T3';
                  closeSpotIdx = j;
                  phase2Done = true;
                  break;
                }
                if (t2Hit) {
                  outcome = 'T2';
                  closeSpotIdx = j;
                  phase2Done = true;
                  break;
                }
              }
              if (!phase2Done) {
                outcome = 'T1';
                closeSpotIdx = t1HitSpotIdx;
              }
            }

            if (isBuy) activeBuyClosedAt = closeSpotIdx;
            else activeSellClosedAt = closeSpotIdx;

            // ── Option P&L using CE premium candles ───────────────────────
            // BUY CE:  profit = exitPrice − entryPrice  (CE rose)
            // SELL CE: profit = entryPrice − exitPrice  (CE fell)
            let pnl = 0;
            // Option-level SL price (option premium at the spot SL candle).
            // Stored as stopLoss in the output so the UI shows a meaningful
            // option-price SL instead of the raw NIFTY spot SL level.
            let optionLevelSL: number | null = null;
            if (optEntryPrice !== null && optEntryPrice > 0) {
              // Get option candle price at a given spot candle index.
              // Both BUY (CE) and SELL (PE) are long-option positions, so:
              //   favourable exit uses candle high; adverse uses candle low.
              const optPriceAt = (
                spotIdx: number,
                favourable: boolean,
              ): number => {
                const oi = optIdxAt(spotIdx, tsOptTimeMap);
                if (oi < 0) return tsEodOptClose || optEntryPrice;
                const oc = tsOptUpToTime[oi];
                // Always long option: favourable = high (premium rose), adverse = low
                return favourable ? oc.high : oc.low;
              };

              if (outcome === 'SL') {
                // Adverse move: option premium fell → use low
                const optSLPrice = optPriceAt(closeSpotIdx, false);
                pnl = (optSLPrice - optEntryPrice) * tsTotalQty;
                // Capture option-level SL for display (avoids showing spot SL in UI)
                optionLevelSL = optSLPrice;
              } else if (outcome === 'BE' && t1HitSpotIdx >= 0) {
                // Half qty exits at T1 (profit), remaining exits at approx entry (breakeven)
                const optT1Price = optPriceAt(t1HitSpotIdx, true);
                pnl = (optT1Price - optEntryPrice) * tsHalfQty;
              } else if (t1HitSpotIdx >= 0) {
                // T1 / T2 / T3: half qty at T1, remaining at final close
                const optT1Price = optPriceAt(t1HitSpotIdx, true);
                const optFinalPrice = optPriceAt(closeSpotIdx, true);
                pnl =
                  (optT1Price - optEntryPrice) * tsHalfQty +
                  (optFinalPrice - optEntryPrice) * tsRemainingQty;
              } else {
                // OPEN: full position closed at EOD option price
                const optFinalPrice = tsEodOptClose || optEntryPrice;
                pnl = (optFinalPrice - optEntryPrice) * tsTotalQty;
              }
            }

            const optEntryStr =
              optEntryPrice !== null
                ? `@ ₹${optEntryPrice.toFixed(2)}`
                : '(option data N/A)';

            tsOutputSignals.push({
              time: candleTime,
              date: candleDate,
              timestamp:
                Math.floor(new Date(candleDate).getTime() / 1000) + 19800,
              recommendation: signalType,
              reason: `${isBuy ? 'BUY CE' : 'BUY PE'} ${tsOptSymbol} ${optEntryStr} | NIFTY ${isBuy ? 'bullish' : 'bearish'}: EMA ${sig.indicators.ema200.toFixed(2)}, ADX ${sig.indicators.adx.toFixed(1)}, RRR ${sig.rrr.toFixed(2)} (Spot risk: ${risk.toFixed(1)}pts)`,
              price: optEntryPrice ?? spotEntry,
              // stopLoss is the option premium at the spot SL candle (not the
              // raw NIFTY spot SL level) so that the UI can display meaningful
              // "SL ₹xx · yy pts" relative to the option entry price.
              stopLoss: optionLevelSL ?? undefined,
              target1: t1,
              target2: t2,
              target3: t3,
              patternName: sigReason,
              outcome,
              pnl: Math.round(pnl),
            });
          }

          const tsCeLtp =
            tsCeUpToTime.length > 0
              ? tsCeUpToTime[tsCeUpToTime.length - 1].close
              : 0;
          const tsPeLtp =
            tsPeUpToTime.length > 0
              ? tsPeUpToTime[tsPeUpToTime.length - 1].close
              : 0;

          const tsOutputOptions: any[] = [];
          if (tsOutputSignals.length > 0) {
            // Group signals by option symbol they reference
            const ceSigs = tsOutputSignals.filter((s) =>
              s.reason.startsWith('BUY CE'),
            );
            const peSigs = tsOutputSignals.filter((s) =>
              s.reason.startsWith('BUY PE'),
            );
            if (ceSigs.length > 0) {
              tsOutputOptions.push({
                symbol: TS_CE_SYMBOL,
                strike: TS_CE_STRIKE,
                optionType: 'CE',
                tradingsymbol: TS_CE_SYMBOL,
                instrumentToken: TS_CE_TOKEN,
                signals: ceSigs,
                ltp: tsCeLtp,
              });
            }
            if (peSigs.length > 0) {
              tsOutputOptions.push({
                symbol: TS_PE_SYMBOL,
                strike: TS_PE_STRIKE,
                optionType: 'PE',
                tradingsymbol: TS_PE_SYMBOL,
                instrumentToken: TS_PE_TOKEN,
                signals: peSigs,
                ltp: tsPeLtp,
              });
            }
          }

          return { options: tsOutputOptions };
        }
        // ─────────────────────────────────────────────────────────────────────

        if (
          strategy === 'DAY_SELLING' ||
          strategy === 'DAY_SELLING_V2' ||
          strategy === 'DAY_SELLING_V2_ENHANCED' ||
          strategy === 'DAY_SELLING_V1V2' ||
          strategy === 'DAY_SELLING_V3' ||
          strategy === 'DAY_SELLING_V4' ||
          strategy === 'DAY_HIGH_REJECTION' ||
          strategy === 'DAY_LOW_BREAK' ||
          strategy === 'EMA_REJECTION' ||
          strategy === 'SUPER_POWER_PACK' ||
          strategy === 'DAY_REVERSAL'
        ) {
          const intradayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            interval,
            todayFrom,
            todayTo,
          );
          if (!intradayData || intradayData.length < 20) {
            this.logger.warn(
              `[SPOT] Not enough intraday candles for ${baseSymbol}`,
            );
            return { options: [] };
          }

          const [targetHour, targetMin] = specificTime.split(':').map(Number);
          const candlesUpToTime = intradayData.filter((c: any) => {
            const d = new Date(c.date);
            return (
              d.getHours() < targetHour ||
              (d.getHours() === targetHour && d.getMinutes() <= targetMin)
            );
          });

          const prevDayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            'day',
            prevWindowFrom,
            yesterdayTo,
          );
          const yesterdayHigh =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].high
              : 0;
          const prevDayLow =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].low
              : 0;
          const spotPrevDayClose =
            prevDayData && prevDayData.length > 0
              ? prevDayData[prevDayData.length - 1].close
              : 0;

          const prevIntradayData = await kc.getHistoricalData(
            indexInst.instrument_token,
            interval,
            prevWindowFrom,
            yesterdayTo,
          );

          // EMA pre-seeding (same pattern as per-option processing)
          let emaValues: (number | null)[];
          if (prevIntradayData && prevIntradayData.length >= 20) {
            const seed = prevIntradayData.slice(-25);
            const combined = [...seed, ...candlesUpToTime];
            emaValues = this.indicators
              .calculateEMA(
                combined.map((c: any) => c.close),
                20,
              )
              .slice(seed.length);
          } else {
            emaValues = this.indicators.calculateEMA(
              candlesUpToTime.map((c: any) => c.close),
              20,
            );
          }

          // RSI pre-seeding
          let rsiValues: (number | null)[];
          if (prevIntradayData && prevIntradayData.length >= 14) {
            const seed = prevIntradayData.slice(-30);
            const combined = [...seed, ...candlesUpToTime];
            rsiValues = this.indicators
              .calculateRSI(
                combined.map((c: any) => c.close),
                14,
              )
              .slice(seed.length);
          } else {
            rsiValues = this.indicators.calculateRSI(
              candlesUpToTime.map((c: any) => c.close),
              14,
            );
          }

          // Swing highs
          const swingHighs: Array<{ price: number; index: number }> = [];
          for (let i = 5; i < candlesUpToTime.length - 5; i++) {
            const c = candlesUpToTime[i];
            const prev = candlesUpToTime.slice(i - 5, i);
            const next = candlesUpToTime.slice(i + 1, i + 6);
            if (
              prev.every((p: any) => p.high < c.high) &&
              next.every((n: any) => n.high < c.high)
            ) {
              swingHighs.push({ price: c.high, index: i });
            }
          }

          const superTrendData = this.indicators.calculateSuperTrend(
            candlesUpToTime,
            10,
            2,
          );

          // 8 EMA (required for V4)
          let spotEma8Values: (number | null)[];
          if (prevIntradayData && prevIntradayData.length > 0) {
            const seed8 = prevIntradayData.slice(-15);
            const combined8 = [...seed8, ...candlesUpToTime];
            spotEma8Values = this.indicators
              .calculateEMA(
                combined8.map((c: any) => c.close),
                8,
              )
              .slice(seed8.length);
          } else {
            spotEma8Values = this.indicators.calculateEMA(
              candlesUpToTime.map((c: any) => c.close),
              8,
            );
          }

          // VWAP (today's candles only, no pre-seeding)
          const spotVwapValues = this.indicators.calculateVWAP(
            candlesUpToTime.map((c: any) => ({
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume ?? 0,
            })),
          );

          // P&L setup for spot path
          const spotLotSizes: Record<string, number> = {
            NIFTY: 65,
            BANKNIFTY: 30,
            FINNIFTY: 65,
            SENSEX: 20,
            MIDCPNIFTY: 75,
          };
          const spotLotSize = spotLotSizes[baseSymbol] ?? 1;
          const spotPaperSettings = await this.prisma.tradingSettings
            .findUnique({
              where: {
                userId_symbol: { userId: broker.userId, symbol: baseSymbol },
              },
            })
            .catch(() => null);
          const spotPaperLots = spotPaperSettings?.paperLots ?? 1;
          const spotMinSellRsi = spotPaperSettings?.minSellRsi ?? 45;
          const spotMaxSellRiskPts = spotPaperSettings?.maxSellRiskPts ?? 30;

          // Fetch 1-minute candles for DLB / EMA_REJECTION / SUPER_POWER_PACK confirmation (SPOT path)
          let dlbSpot1mCandles: any[] = [];
          if (
            strategy === 'DAY_LOW_BREAK' ||
            strategy === 'EMA_REJECTION' ||
            strategy === 'SUPER_POWER_PACK'
            // DAY_REVERSAL is pure 5m — no 1m candles needed
          ) {
            const dlbSpot1mData =
              interval === 'minute'
                ? intradayData
                : await kc.getHistoricalData(
                    indexInst.instrument_token,
                    'minute',
                    todayFrom,
                    todayTo,
                  );
            dlbSpot1mCandles = (dlbSpot1mData ?? []).filter((c: any) => {
              const d = new Date(c.date);
              return (
                d.getHours() < targetHour ||
                (d.getHours() === targetHour && d.getMinutes() <= targetMin)
              );
            });
          }

          // EMA20 session gate for DHR / SUPER_POWER_PACK spot path
          // Same calculation as optionMonitor: EMA value at last yesterday candle.
          let dhrSpotEma20: number | undefined;
          if (
            (strategy === 'DAY_HIGH_REJECTION' ||
              strategy === 'SUPER_POWER_PACK') &&
            prevIntradayData &&
            prevIntradayData.length >= 20
          ) {
            const dhrSeed = prevIntradayData.slice(-25);
            const dhrCombined = [...dhrSeed, ...candlesUpToTime];
            const dhrEmaAll = this.indicators.calculateEMA(
              dhrCombined.map((c: any) => c.close),
              20,
            );
            dhrSpotEma20 = dhrEmaAll[dhrSeed.length - 1] ?? undefined;
          }

          // Pre-seeded EMA values for EMA_REJECTION / SUPER_POWER_PACK SPOT path
          let emaRejSpotEmaValues: (number | null)[] = [];
          if (
            (strategy === 'EMA_REJECTION' || strategy === 'SUPER_POWER_PACK') &&
            prevIntradayData &&
            prevIntradayData.length >= 10
          ) {
            const emaRejSeed = prevIntradayData.slice(-25);
            const emaRejCombined = [...emaRejSeed, ...candlesUpToTime];
            emaRejSpotEmaValues = this.indicators
              .calculateEMA(
                emaRejCombined.map((c: any) => c.close),
                20,
              )
              .slice(emaRejSeed.length);
          } else if (
            strategy === 'EMA_REJECTION' ||
            strategy === 'SUPER_POWER_PACK'
          ) {
            emaRejSpotEmaValues = this.indicators.calculateEMA(
              candlesUpToTime.map((c: any) => c.close),
              20,
            );
          }

          const daySellCandidates =
            strategy === 'DAY_HIGH_REJECTION'
              ? detectDayHighRejectionOnly(candlesUpToTime, {
                  touchTolerance: Math.max(5, Math.round(marginPoints * 1.5)),
                  stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
                  requireNextCandleConfirmation: false,
                  ...(await this.loadDhrConfig()),
                  ema20: dhrSpotEma20,
                  debug: false,
                }).map((s) => {
                  const idx = s.confirmIndex ?? s.setupIndex;
                  const c = candlesUpToTime[idx];
                  const d = c.date instanceof Date ? c.date : new Date(c.date);
                  const h12 = d.getHours() % 12 || 12;
                  const mm = String(d.getMinutes()).padStart(2, '0');
                  const ampm = d.getHours() < 12 ? 'am' : 'pm';
                  return {
                    candleIndex: idx,
                    actualCandleIndex: idx,
                    candleTime: `${String(h12).padStart(2, '0')}:${mm} ${ampm}`,
                    candleDate: d,
                    unixTimestamp: Math.floor(d.getTime() / 1000) + 19800,
                    reason: s.reason,
                    entryPrice: s.entryPrice,
                    stopLoss: s.stopLoss,
                    risk: s.stopLoss - s.entryPrice,
                    candleRSI: null as number | null,
                    isDayHighZoneRejection: true,
                    nearDayHighZone: true,
                    isNearDailyHigh: true,
                  };
                })
              : strategy === 'DAY_SELLING_V4'
                ? detectDaySellSignalsV4({
                    candles: candlesUpToTime,
                    ema8Values: spotEma8Values,
                    ema20Values: emaValues,
                    vwapValues: spotVwapValues,
                    superTrendData,
                    marginPoints,
                    maxSellRiskPts: spotMaxSellRiskPts,
                    realtimeMode,
                    instrumentName: indexInst.tradingsymbol,
                  })
                : strategy === 'DAY_SELLING_V2_ENHANCED'
                  ? detectDaySellSignalsV2Enhanced({
                      candles: candlesUpToTime,
                      ema20Values: emaValues,
                      ema8Values: spotEma8Values,
                      rsiValues,
                      swingHighs,
                      yesterdayHigh,
                      prevDayLow,
                      prevDayClose: spotPrevDayClose,
                      marginPoints,
                      maxSellRiskPts: spotMaxSellRiskPts,
                      realtimeMode,
                      instrumentName: indexInst.tradingsymbol,
                      superTrendData,
                    })
                  : strategy === 'DAY_SELLING_V3'
                    ? detectDaySellSignalsV3({
                        candles: candlesUpToTime,
                        emaValues,
                        rsiValues,
                        swingHighs,
                        yesterdayHigh,
                        prevDayLow,
                        prevDayClose: spotPrevDayClose,
                        marginPoints,
                        maxSellRiskPts: spotMaxSellRiskPts,
                        realtimeMode,
                        instrumentName: indexInst.tradingsymbol,
                        superTrendData,
                      })
                    : strategy === 'DAY_LOW_BREAK'
                      ? detectDayLowBreakOnly(
                          candlesUpToTime,
                          {
                            stopLossBuffer: Math.max(
                              3,
                              Math.round(marginPoints / 4),
                            ),
                            min5mBreakdownBodyRatio: 0.3,
                            oneMinuteConfirmationWindow: 10,
                            minRRRatio: 1.5,
                            debug: false,
                          },
                          dlbSpot1mCandles,
                        ).map((s) => {
                          // Use 1m confirmation candle time when available
                          const c1m =
                            dlbSpot1mCandles[s.confirmIndex] ??
                            candlesUpToTime[s.setupIndex];
                          const d =
                            c1m.date instanceof Date
                              ? c1m.date
                              : new Date(c1m.date);
                          const h12 = d.getHours() % 12 || 12;
                          const mm = String(d.getMinutes()).padStart(2, '0');
                          const ampm = d.getHours() < 12 ? 'am' : 'pm';
                          return {
                            candleIndex: s.setupIndex,
                            actualCandleIndex: s.setupIndex,
                            candleTime: `${String(h12).padStart(2, '0')}:${mm} ${ampm}`,
                            candleDate: d,
                            unixTimestamp:
                              Math.floor(d.getTime() / 1000) + 19800,
                            reason: s.reason,
                            entryPrice: s.entryPrice,
                            stopLoss: s.stopLoss,
                            risk: s.stopLoss - s.entryPrice,
                            candleRSI: null as number | null,
                          };
                        })
                      : strategy === 'EMA_REJECTION'
                        ? detectEmaRejectionOnly(
                            candlesUpToTime,
                            emaRejSpotEmaValues,
                            {
                              emaTouchBufferPts: Math.max(
                                3,
                                Math.round(marginPoints * 0.5),
                              ),
                              emaBreakTolerancePts: Math.max(
                                5,
                                Math.round(marginPoints),
                              ),
                              stopLossBuffer: Math.max(
                                3,
                                Math.round(marginPoints / 4),
                              ),
                              minRiskRewardReference: 1.5,
                              // SPOT monitor display shows all signals regardless of SL width
                              maxAllowedSLReference: Infinity,
                              enableDiagLog: true,
                              debug: false,
                            },
                            dlbSpot1mCandles,
                          ).map((s) => {
                            // Use 1m confirmation candle time when available
                            const c1m =
                              s.confirmIndex >= 0
                                ? (dlbSpot1mCandles[s.confirmIndex] ??
                                  candlesUpToTime[s.setupIndex])
                                : candlesUpToTime[s.setupIndex];
                            const d =
                              c1m.date instanceof Date
                                ? c1m.date
                                : new Date(c1m.date);
                            const h12 = d.getHours() % 12 || 12;
                            const mm = String(d.getMinutes()).padStart(2, '0');
                            const ampm = d.getHours() < 12 ? 'am' : 'pm';
                            return {
                              candleIndex: s.setupIndex,
                              actualCandleIndex: s.setupIndex,
                              candleTime: `${String(h12).padStart(2, '0')}:${mm} ${ampm}`,
                              candleDate: d,
                              unixTimestamp:
                                Math.floor(d.getTime() / 1000) + 19800,
                              reason: s.reason,
                              entryPrice: s.entryPrice,
                              stopLoss: s.stopLoss,
                              risk: s.stopLoss - s.entryPrice,
                              candleRSI: null as number | null,
                            };
                          })
                        : strategy === 'SUPER_POWER_PACK'
                          ? detectSuperPowerPackSignals({
                              candles: candlesUpToTime,
                              candles1m: dlbSpot1mCandles,
                              ema20: dhrSpotEma20,
                              ema20Series: emaRejSpotEmaValues,
                              marginPoints,
                              dlbConfig: { maxEmaDistancePts: Infinity },
                            }).map((s) => {
                              // Choose entry-time candle by source
                              const c1m =
                                s.source === 'DHR'
                                  ? s.oneMinuteConfirmIndex != null &&
                                    dlbSpot1mCandles[s.oneMinuteConfirmIndex]
                                    ? dlbSpot1mCandles[s.oneMinuteConfirmIndex]
                                    : candlesUpToTime[
                                        s.confirmIndex ?? s.setupIndex
                                      ]
                                  : s.source === 'DAY_REVERSAL'
                                    ? candlesUpToTime[s.setupIndex]
                                    : (
                                          s as {
                                            confirmIndex?: number;
                                            setupIndex: number;
                                          }
                                        ).confirmIndex != null &&
                                        (
                                          s as {
                                            confirmIndex?: number;
                                            setupIndex: number;
                                          }
                                        ).confirmIndex! >= 0
                                      ? (dlbSpot1mCandles[
                                          (
                                            s as {
                                              confirmIndex?: number;
                                              setupIndex: number;
                                            }
                                          ).confirmIndex!
                                        ] ?? candlesUpToTime[s.setupIndex])
                                      : candlesUpToTime[s.setupIndex];
                              const baseD =
                                c1m.date instanceof Date
                                  ? c1m.date
                                  : new Date(c1m.date);
                              // DAY_REVERSAL has no 1-min confirmation: signal fires on
                              // candle CLOSE. Shift by interval so the reported time is
                              // the candle close time (= actual entry time), not candle open.
                              const intervalMins =
                                interval === 'minute'
                                  ? 1
                                  : parseInt(interval) || 5;
                              const d =
                                s.source === 'DAY_REVERSAL'
                                  ? new Date(
                                      baseD.getTime() + intervalMins * 60_000,
                                    )
                                  : baseD;
                              const h12 = d.getHours() % 12 || 12;
                              const mm = String(d.getMinutes()).padStart(
                                2,
                                '0',
                              );
                              const ampm = d.getHours() < 12 ? 'am' : 'pm';
                              return {
                                candleIndex: s.setupIndex,
                                actualCandleIndex: s.setupIndex,
                                candleTime: `${String(h12).padStart(2, '0')}:${mm} ${ampm}`,
                                candleDate: d,
                                unixTimestamp:
                                  Math.floor(d.getTime() / 1000) + 19800,
                                reason: `[${s.source}] ${s.reason}`,
                                entryPrice: s.entryPrice,
                                stopLoss: s.stopLoss,
                                risk: s.stopLoss - s.entryPrice,
                                candleRSI: null as number | null,
                              };
                            })
                          : strategy === 'DAY_REVERSAL'
                            ? detectDayReversalOnly(candlesUpToTime, {
                                stopLossBuffer: Math.max(
                                  3,
                                  Math.round(marginPoints / 4),
                                ),
                                minRallyPoints: Math.max(15, marginPoints),
                                minRRRatio: 0,
                                debug: false,
                              }).map((s) => {
                                const c = candlesUpToTime[s.setupIndex];
                                const baseD =
                                  c.date instanceof Date
                                    ? c.date
                                    : new Date(c.date);
                                // Signal fires on candle CLOSE — shift by interval
                                // so the reported time is the candle close time
                                // (= actual entry time), not the candle open time.
                                const intervalMins =
                                  interval === 'minute'
                                    ? 1
                                    : parseInt(interval) || 5;
                                const d = new Date(
                                  baseD.getTime() + intervalMins * 60_000,
                                );
                                const h12 = d.getHours() % 12 || 12;
                                const mm = String(d.getMinutes()).padStart(
                                  2,
                                  '0',
                                );
                                const ampm = d.getHours() < 12 ? 'am' : 'pm';
                                return {
                                  candleIndex: s.setupIndex,
                                  actualCandleIndex: s.setupIndex,
                                  candleTime: `${String(h12).padStart(2, '0')}:${mm} ${ampm}`,
                                  candleDate: d,
                                  unixTimestamp:
                                    Math.floor(d.getTime() / 1000) + 19800,
                                  reason: s.reason,
                                  entryPrice: s.entryPrice,
                                  stopLoss: s.stopLoss,
                                  risk: s.stopLoss - s.entryPrice,
                                  candleRSI: null as number | null,
                                };
                              })
                            : detectDaySellSignals({
                                candles: candlesUpToTime,
                                emaValues,
                                rsiValues,
                                swingHighs,
                                yesterdayHigh,
                                prevDayLow,
                                prevDayClose: spotPrevDayClose,
                                marginPoints,
                                minSellRsi: spotMinSellRsi,
                                maxSellRiskPts: spotMaxSellRiskPts,
                                realtimeMode,
                                instrumentName: indexInst.tradingsymbol,
                                superTrendData,
                              });
          const spotTotalQty = spotPaperLots * spotLotSize;
          const spotHalfQty = Math.floor(spotTotalQty / 2);
          const spotRemainingQty = spotTotalQty - spotHalfQty;
          const spotEodClose =
            candlesUpToTime[candlesUpToTime.length - 1]?.close ?? 0;

          const sellSignals: any[] = [];
          let activeTradeClosed = true;
          let consecutiveSLHits = 0; // Rule 2: stop after 2 back-to-back SL hits
          let dailyStopTrading = false; // Rule 2+3: halt flag
          for (const sig of daySellCandidates) {
            if (dailyStopTrading) break; // stop generating new signals for the day
            if (!activeTradeClosed) continue;
            const {
              actualCandleIndex,
              candleTime,
              candleDate,
              unixTimestamp,
              reason: signalReason,
              entryPrice,
              stopLoss,
              risk,
              candleRSI,
            } = sig;
            // DLB + SUPER_POWER_PACK + DAY_REVERSAL use 1:1 RR as T1 (entry − risk × 1); all others use 1:2 RR.
            const target1 =
              strategy === 'DAY_LOW_BREAK' ||
              strategy === 'SUPER_POWER_PACK' ||
              strategy === 'DAY_REVERSAL'
                ? entryPrice - risk
                : entryPrice - risk * 2;
            const target2 =
              strategy === 'DAY_LOW_BREAK' ||
              strategy === 'SUPER_POWER_PACK' ||
              strategy === 'DAY_REVERSAL'
                ? entryPrice - risk * 2
                : entryPrice - risk * 3;
            const target3 =
              strategy === 'DAY_LOW_BREAK' ||
              strategy === 'SUPER_POWER_PACK' ||
              strategy === 'DAY_REVERSAL'
                ? entryPrice - risk * 3
                : entryPrice - risk * 4;
            const rsiText =
              candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

            // Phase 1: scan for SL hit or T1 hit.
            // Check T1 before SL: on expiry-day candles the option can dip to T1
            // then reverse past SL in the same bar. Checking T1 first allows the
            // intrabar T1→BE sequence to be captured correctly in phase 2.
            let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
            activeTradeClosed = false;
            let t1HitIndex = -1;
            for (
              let j = actualCandleIndex + 1;
              j < candlesUpToTime.length;
              j++
            ) {
              const fc = candlesUpToTime[j];
              if (fc.low <= target1) {
                t1HitIndex = j;
                break;
              }
              if (fc.high >= stopLoss) {
                outcome = 'SL';
                activeTradeClosed = true;
                break;
              }
            }

            // Phase 2: T1 hit — track remaining 50% with BE-adjusted SL.
            // Start from the T1 candle itself so that a candle that dips to T1
            // and immediately reverses past entry is correctly counted as BE.
            if (t1HitIndex >= 0) {
              let phase2Done = false;
              for (let j = t1HitIndex; j < candlesUpToTime.length; j++) {
                const fc = candlesUpToTime[j];
                if (fc.high >= entryPrice) {
                  outcome = 'BE';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                }
                if (fc.low <= target3) {
                  outcome = 'T3';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                } else if (fc.low <= target2) {
                  outcome = 'T2';
                  activeTradeClosed = true;
                  phase2Done = true;
                  break;
                }
              }
              if (!phase2Done) {
                outcome = 'T1';
                activeTradeClosed = true;
              }
            }

            // P&L calculation (SELL: profit = entry - exit per unit)
            let pnl: number;
            if (outcome === 'SL') {
              pnl = (entryPrice - stopLoss) * spotTotalQty;
            } else if (t1HitIndex >= 0) {
              const t1Profit = (entryPrice - target1) * spotHalfQty;
              if (outcome === 'BE') {
                pnl = t1Profit; // remaining 50% exits at entry → 0 P&L
              } else if (outcome === 'T2') {
                pnl = t1Profit + (entryPrice - target2) * spotRemainingQty;
              } else if (outcome === 'T3') {
                pnl = t1Profit + (entryPrice - target3) * spotRemainingQty;
              } else {
                // T1: remaining 50% closed at EOD
                pnl = t1Profit + (entryPrice - spotEodClose) * spotRemainingQty;
              }
            } else {
              // OPEN: no T1 hit, full position closed at EOD
              pnl = (entryPrice - spotEodClose) * spotTotalQty;
            }

            // === DAILY STOP RULES ===
            // Rule 2: 2 consecutive SL hits → max daily loss reached (2 × 30 pts = 60 pts)
            // Rule 3: Target or BE hit → protect the gain, stop for the day
            if (outcome === 'SL') {
              consecutiveSLHits++;
              if (consecutiveSLHits >= 2) dailyStopTrading = true;
            } else if (outcome !== 'OPEN') {
              // T1 / T2 / T3 / BE — a profitable close → stop trading for the day
              consecutiveSLHits = 0;
              dailyStopTrading = true;
            }

            sellSignals.push({
              time: candleTime,
              date: candleDate,
              timestamp: unixTimestamp,
              recommendation: 'SELL',
              reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
              price: entryPrice,
              stopLoss,
              target1,
              target2,
              target3,
              patternName: signalReason,
              outcome,
              pnl: Math.round(pnl),
            });
          }

          const ltp = candlesUpToTime[candlesUpToTime.length - 1]?.close || 0;
          return {
            options:
              sellSignals.length > 0
                ? [
                    {
                      symbol: baseSymbol,
                      strike: 0,
                      optionType: 'IDX',
                      tradingsymbol: indexInst.tradingsymbol,
                      instrumentToken: indexInst.instrument_token,
                      signals: sellSignals,
                      ltp,
                    },
                  ]
                : [],
          };
        }

        // DAY_BUYING and other strategies on spot: not yet supported
        return { options: [] };
      }
      // ─────────────────────────────────────────────────────────────────────────

      // SENSEX trades on BFO (BSE), others on NFO (NSE)
      const exchange = symbol === 'SENSEX' ? 'BFO' : 'NFO';

      this.logger.log(
        `Filtering instruments: symbol=${symbol}, exchange=${exchange}, expiry=${expiry}`,
      );

      const optionInstruments = instruments.filter((inst) => {
        // Strip quotes from name field (e.g., "NIFTY" -> NIFTY)
        let instName = inst.name;
        if (instName && instName.startsWith('"') && instName.endsWith('"')) {
          instName = instName.slice(1, -1);
        }

        if (instName !== symbol) return false;
        if (inst.exchange !== exchange) return false;
        if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE')
          return false;

        // Handle expiry comparison - could be Date object or string
        let instExpiry = inst.expiry;
        if (typeof instExpiry === 'object' && instExpiry !== null) {
          instExpiry = (instExpiry as any).toISOString().split('T')[0];
        }

        return instExpiry === expiry;
      });

      this.logger.log(
        `Found ${optionInstruments.length} live API instruments for ${symbol} expiry ${expiry}`,
      );

      // ── Resolve option instruments: DB (historical) vs Live API ────────────
      let resolvedInstruments: typeof optionInstruments;

      const dbInstrumentSelect = {
        instrumentToken: true,
        exchangeToken: true,
        tradingsymbol: true,
        name: true,
        lastPrice: true,
        expiry: true,
        strike: true,
        tickSize: true,
        lotSize: true,
        instrumentType: true,
        segment: true,
        exchange: true,
      } as const;

      const mapDbRow = (r: {
        instrumentToken: number;
        exchangeToken: number;
        tradingsymbol: string;
        name: string | null;
        lastPrice: number;
        expiry: string | null;
        strike: number;
        tickSize: number;
        lotSize: number;
        instrumentType: string;
        segment: string;
        exchange: string;
      }) => ({
        instrument_token: r.instrumentToken,
        exchange_token: r.exchangeToken,
        tradingsymbol: r.tradingsymbol,
        name: r.name ?? symbol,
        last_price: r.lastPrice,
        expiry: r.expiry ?? expiry,
        strike: r.strike,
        tick_size: r.tickSize,
        lot_size: r.lotSize,
        instrument_type: r.instrumentType,
        segment: r.segment,
        exchange: r.exchange,
      });

      if (instrumentSource === 'db') {
        // ── HISTORICAL MODE: query Instrument DB directly ─────────────────
        // Expired contracts are no longer in Kite's live feed but persist in
        // our DB (daily sync inserts, never deletes old rows).
        this.logger.log(
          `[optionMonitor] DB mode — loading instruments from DB for ${symbol} expiry ${expiry}`,
        );
        const dbRows = await this.prisma.instrument.findMany({
          where: {
            tradingsymbol: { startsWith: symbol },
            exchange: exchange,
            instrumentType: { in: ['CE', 'PE'] },
            expiry: expiry,
          },
          select: dbInstrumentSelect,
        });
        this.logger.log(
          `[optionMonitor] DB found ${dbRows.length} instruments for ${symbol} expiry ${expiry}`,
        );
        if (dbRows.length === 0) {
          this.logger.warn(
            `[optionMonitor] No instruments in DB for ${symbol} expiry ${expiry}. ` +
              `Make sure instruments were downloaded for this date range.`,
          );
          return { options: [] };
        }
        resolvedInstruments = dbRows.map(mapDbRow);
        // Use DB-stored tokens directly — Kite historical data endpoint supports
        // expired option tokens, provided the token was captured before expiry.
      } else {
        // ── LIVE MODE: use fresh instruments from Kite API ────────────────
        resolvedInstruments = optionInstruments;
        if (optionInstruments.length === 0) {
          const availableExpiries = new Set<string>();
          instruments
            .filter((inst) => {
              let instName = inst.name;
              if (instName?.startsWith('"') && instName?.endsWith('"')) {
                instName = instName.slice(1, -1);
              }
              return (
                instName === symbol &&
                inst.exchange === exchange &&
                (inst.instrument_type === 'CE' || inst.instrument_type === 'PE')
              );
            })
            .forEach((inst) => {
              let instExpiry = inst.expiry;
              if (typeof instExpiry === 'object' && instExpiry !== null) {
                instExpiry = (instExpiry as any).toISOString().split('T')[0];
              }
              availableExpiries.add(instExpiry);
            });
          this.logger.warn(
            `[optionMonitor] No live instruments for ${symbol} expiry ${expiry}. ` +
              `Available expiries: ${Array.from(availableExpiries).sort().join(', ')}. ` +
              `Switch to Historical mode for past dates.`,
          );
          return { options: [] };
        }
      }

      // Get target date and previous trading day's dates
      const today = new Date(targetDate);
      const todayStr = today.toISOString().split('T')[0];

      // Calculate previous trading day (skip weekends)
      const yesterday = new Date(targetDate);
      let daysToSubtract = 1;
      yesterday.setDate(yesterday.getDate() - daysToSubtract);

      // If yesterday is Sunday (0), go back to Friday (subtract 2 more days = 3 total)
      // If yesterday is Saturday (6), go back to Friday (subtract 1 more day = 2 total)
      const yesterdayDay = yesterday.getDay();
      if (yesterdayDay === 0) {
        // Sunday - go back 2 more days to Friday
        yesterday.setDate(yesterday.getDate() - 2);
        this.logger.debug(
          `Target date is Monday, using Friday as previous trading day`,
        );
      } else if (yesterdayDay === 6) {
        // Saturday - go back 1 more day to Friday
        yesterday.setDate(yesterday.getDate() - 1);
        this.logger.debug(
          `Target date is Sunday, using Friday as previous trading day`,
        );
      }

      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // Kite API requires yyyy-mm-dd hh:mm:ss format
      const todayFrom = `${todayStr} 09:15:00`;
      const todayTo = `${todayStr} 15:30:00`;
      const yesterdayFrom = `${yesterdayStr} 09:15:00`;
      const yesterdayTo = `${yesterdayStr} 15:30:00`;

      // Wide 7-day lookback window — same as getOptionChartData.
      // This is critical: if the calendar day before targetDate is a market holiday
      // (e.g. Holi on 2026-03-03 when targetDate = 2026-03-04), yesterdayFrom/To
      // returns zero candles.  The wide window lets Kite return the actual last
      // trading day within the range, so EMA pre-seeding and yesterdayHigh are
      // always correct regardless of holidays.
      const prevWindowStart = new Date(targetDate);
      prevWindowStart.setDate(prevWindowStart.getDate() - 7);
      const prevWindowFrom = `${prevWindowStart.toISOString().split('T')[0]} 09:15:00`;

      this.logger.log(
        `Comparing target date's (${todayStr}) high/low with previous trading day's (${yesterdayStr}) high/low. Interval: ${interval}, Time: ${specificTime}`,
      );

      // ── Select instruments to scan ──────────────────────────────────────────
      // STRIKE_LOCK strategies: look up (or lazily create) the persistent
      // StrikeSelection DB record keyed on (brokerId, symbol, date).
      // selectAndSaveStrike() fetches the 9:15 AM candle OPEN for that date
      // so that past-date replays always use the actual opening price.
      // All other strategies: fetch the day-close spot price and select ATM±N.
      let limitedInstruments: any[] = [];

      if (
        (TradingService.STRIKE_LOCK_STRATEGIES as readonly string[]).includes(
          strategy,
        )
      ) {
        const selected = await this.selectAndSaveStrike(
          brokerId,
          symbol,
          todayStr,
          expiry,
          instrumentSource,
        );
        if (selected) {
          // Prefer full instrument records from resolvedInstruments (correct lot_size etc.);
          // fall back to the lightweight objects from selectAndSaveStrike.
          const ceFromResolved = resolvedInstruments.find(
            (i) =>
              i.instrument_token === selected.ceInstrument.instrument_token,
          );
          const peFromResolved = resolvedInstruments.find(
            (i) =>
              i.instrument_token === selected.peInstrument.instrument_token,
          );
          limitedInstruments = [
            ceFromResolved ?? selected.ceInstrument,
            peFromResolved ?? selected.peInstrument,
          ];
          this.logger.log(
            `[option-monitor] StrikeSelection (${strategy}): ` +
              limitedInstruments.map((i) => i.tradingsymbol).join(' / '),
          );
        } else {
          this.logger.warn(
            `[option-monitor] selectAndSaveStrike returned null for ${strategy} ` +
              `on ${todayStr} — falling back to live ATM selection`,
          );
        }
      }

      // Live ATM selection: used for non-STRIKE_LOCK strategies and as a
      // fallback when selectAndSaveStrike cannot produce a result.
      let spotPrice = 0; // declared here so DAY_BUYING filter can reference it below
      if (limitedInstruments.length === 0) {
        try {
          // Find the index instrument for the symbol
          let indexInstrument = instruments.find(
            (i) =>
              i.segment === 'INDICES' &&
              ((symbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
                (symbol === 'BANKNIFTY' && i.tradingsymbol === 'NIFTY BANK') ||
                (symbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
                (symbol === 'SENSEX' &&
                  (i.tradingsymbol === 'SENSEX' ||
                    i.name.includes('SENSEX'))) ||
                (symbol === 'MIDCPNIFTY' &&
                  (i.tradingsymbol === 'NIFTY MIDCAP SELECT' ||
                    i.tradingsymbol.includes('MIDCAP')))),
          );

          // Fallback: try to find by tradingsymbol match
          if (!indexInstrument) {
            indexInstrument = instruments.find(
              (i) =>
                (i.segment === 'INDICES' || i.exchange === 'NSE') &&
                i.tradingsymbol === symbol,
            );
          }

          if (indexInstrument) {
            this.logger.log(
              `Found index instrument: ${indexInstrument.tradingsymbol} (token: ${indexInstrument.instrument_token})`,
            );

            // Fetch historical data for the target date
            const indexHistorical = await kc.getHistoricalData(
              indexInstrument.instrument_token,
              'day',
              todayFrom,
              todayTo,
            );

            if (indexHistorical && indexHistorical.length > 0) {
              // Use close price from historical data
              spotPrice =
                indexHistorical[0].close || indexHistorical[0].high || 0;
              this.logger.log(
                `Historical spot price for ${symbol} on ${todayStr}: ${spotPrice}`,
              );
            } else {
              this.logger.warn(
                `No historical data for ${symbol} on ${todayStr}, trying live price as fallback`,
              );
              // Fallback to live price if no historical data (e.g., future date or holiday)
              // Use exact Kite index tradingsymbols, NOT the short symbol name
              const spotSymbol =
                symbol === 'SENSEX'
                  ? 'BSE:SENSEX'
                  : symbol === 'BANKNIFTY'
                    ? 'NSE:NIFTY BANK'
                    : symbol === 'FINNIFTY'
                      ? 'NSE:FINNIFTY'
                      : symbol === 'MIDCPNIFTY'
                        ? 'NSE:NIFTY MIDCAP SELECT'
                        : 'NSE:NIFTY 50'; // NIFTY — must NOT be 'NSE:NIFTY'
              const spotQuote = await kc.getQuote([spotSymbol]);
              if (spotQuote && spotQuote[spotSymbol]) {
                spotPrice = spotQuote[spotSymbol].last_price;
                this.logger.log(
                  `Using live spot price for ${symbol} (${spotSymbol}): ${spotPrice}`,
                );
              }
            }
          } else {
            this.logger.warn(
              `Could not find index instrument for ${symbol}, using live price`,
            );
            const spotSymbol =
              symbol === 'SENSEX'
                ? 'BSE:SENSEX'
                : symbol === 'BANKNIFTY'
                  ? 'NSE:NIFTY BANK'
                  : symbol === 'FINNIFTY'
                    ? 'NSE:FINNIFTY'
                    : symbol === 'MIDCPNIFTY'
                      ? 'NSE:NIFTY MIDCAP SELECT'
                      : 'NSE:NIFTY 50';
            const spotQuote = await kc.getQuote([spotSymbol]);
            if (spotQuote && spotQuote[spotSymbol]) {
              spotPrice = spotQuote[spotSymbol].last_price;
              this.logger.log(
                `Using live spot price for ${symbol} (${spotSymbol}): ${spotPrice}`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(
            `Could not fetch spot price for ${symbol}: ${err.message}`,
          );
        }

        // Last-resort: if all spot price fetches failed, derive ATM from the
        // midpoint of available DB option strikes.  This is a safe approximation
        // because Kite lists strikes symmetrically around ATM (equal number OTM
        // on each side), so the midpoint of min/max strike ≈ ATM.
        if (spotPrice === 0 && resolvedInstruments.length > 0) {
          const allStrikes = resolvedInstruments
            .map((i) => i.strike)
            .filter((s) => s > 0);
          if (allStrikes.length > 0) {
            const minS = Math.min(...allStrikes);
            const maxS = Math.max(...allStrikes);
            spotPrice = (minS + maxS) / 2;
            this.logger.warn(
              `[optionMonitor] Spot price fetch failed — deriving ATM from DB strike midpoint: (${minS}+${maxS})/2 = ${spotPrice}. ` +
                `Live API may be down or access token invalid.`,
            );
          }
        }

        // Select specific strikes based on strategy (ATM±N multi-strike)
        // — used for non-STRIKE_LOCK strategies and as a fallback.
        // STRIKE_LOCK strategies always use just ATM CE + ATM PE (1+1).
        const isStrikeLock = (
          TradingService.STRIKE_LOCK_STRATEGIES as readonly string[]
        ).includes(strategy);

        if (spotPrice > 0) {
          // Determine strike interval (50 for NIFTY, 100 for BANKNIFTY/SENSEX)
          const strikeInterval =
            symbol === 'BANKNIFTY' || symbol === 'SENSEX' ? 100 : 50;

          // Round spot to nearest ATM strike
          const atmStrike =
            Math.round(spotPrice / strikeInterval) * strikeInterval;

          // STRIKE_LOCK fallback: only ATM CE + ATM PE (same as normal lock path)
          // Non-STRIKE_LOCK: ATM and 3 strikes ITM for CE and PE
          const ceStrikes = isStrikeLock
            ? [atmStrike]
            : [
                atmStrike, // ATM
                atmStrike - strikeInterval, // 1 strike ITM
                atmStrike - strikeInterval * 2, // 2 strikes ITM
                atmStrike - strikeInterval * 3, // 3 strikes ITM
              ];

          const peStrikes = isStrikeLock
            ? [atmStrike]
            : [
                atmStrike, // ATM
                atmStrike + strikeInterval, // 1 strike ITM
                atmStrike + strikeInterval * 2, // 2 strikes ITM
                atmStrike + strikeInterval * 3, // 3 strikes ITM
              ];

          this.logger.log(
            `Spot: ${spotPrice}, ATM: ${atmStrike}, CE strikes: ${ceStrikes.join(', ')}, PE strikes: ${peStrikes.join(', ')}${isStrikeLock ? ' (STRIKE_LOCK fallback — ATM only)' : ''}`,
          );

          const ceOptions = ceStrikes
            .map((strike) =>
              resolvedInstruments.find(
                (inst) =>
                  inst.strike === strike && inst.instrument_type === 'CE',
              ),
            )
            .filter((inst) => inst !== undefined);

          const peOptions = peStrikes
            .map((strike) =>
              resolvedInstruments.find(
                (inst) =>
                  inst.strike === strike && inst.instrument_type === 'PE',
              ),
            )
            .filter((inst) => inst !== undefined);

          limitedInstruments = [...ceOptions, ...peOptions];

          this.logger.log(
            `Selected ${ceOptions.length} CE and ${peOptions.length} PE options (Total: ${limitedInstruments.length})`,
          );
        } else {
          // No spot price: for STRIKE_LOCK take ATM-ish 1 CE + 1 PE; others take 4+4
          if (isStrikeLock) {
            const ceOption = resolvedInstruments.find(
              (inst) => inst.instrument_type === 'CE',
            );
            const peOption = resolvedInstruments.find(
              (inst) => inst.instrument_type === 'PE',
            );
            limitedInstruments = [ceOption, peOption].filter(Boolean);
            this.logger.warn(
              `No spot price (STRIKE_LOCK fallback) — using first CE + first PE`,
            );
          } else {
            const ceOptions = resolvedInstruments
              .filter((inst) => inst.instrument_type === 'CE')
              .slice(0, 4);
            const peOptions = resolvedInstruments
              .filter((inst) => inst.instrument_type === 'PE')
              .slice(0, 4);
            limitedInstruments = [...ceOptions, ...peOptions];
            this.logger.warn(
              `No spot price, using first 4 CE and 4 PE instruments`,
            );
          }
        }
      } // end if (limitedInstruments.length === 0)

      // ── TRIPLE_SYNC: run signal detection on SPOT index candles, map to locked options ──
      // The TRIPLE_SYNC strategy analyses the underlying index (e.g. NIFTY 50) using
      // 200 EMA + ADX + SuperTrend on 5-minute candles. It does NOT scan individual
      // option instrument candles, so we handle it here with an early return before
      // the per-instrument batch loop (which has no TRIPLE_SYNC branch).
      if (strategy === 'TRIPLE_SYNC') {
        if (limitedInstruments.length < 2) {
          this.logger.warn(
            `[TRIPLE_SYNC] Strike lock missing for ${symbol} on ${todayStr} — ` +
              `please select a strike via the Trade Finder lock button first, ` +
              `or ensure the expiry date is set correctly so selectAndSaveStrike can run.`,
          );
          return { options: [] };
        }

        // Find the underlying index instrument token
        const tsIndexInst = instruments.find(
          (i) =>
            i.segment === 'INDICES' &&
            ((symbol === 'NIFTY' && i.tradingsymbol === 'NIFTY 50') ||
              (symbol === 'BANKNIFTY' && i.tradingsymbol === 'NIFTY BANK') ||
              (symbol === 'FINNIFTY' && i.tradingsymbol === 'FINNIFTY') ||
              (symbol === 'SENSEX' && i.tradingsymbol === 'SENSEX') ||
              (symbol === 'MIDCPNIFTY' &&
                i.tradingsymbol === 'NIFTY MIDCAP SELECT')),
        );
        if (!tsIndexInst) {
          this.logger.warn(
            `[TRIPLE_SYNC] Could not find index instrument for ${symbol}`,
          );
          return { options: [] };
        }

        const tsLockedCE = limitedInstruments.find(
          (i: any) => i.instrument_type === 'CE',
        );
        const tsLockedPE = limitedInstruments.find(
          (i: any) => i.instrument_type === 'PE',
        );
        if (!tsLockedCE || !tsLockedPE) {
          this.logger.warn(
            `[TRIPLE_SYNC] Missing CE or PE instrument in limitedInstruments`,
          );
          return { options: [] };
        }

        const TS_CE_TOKEN: number = tsLockedCE.instrument_token;
        const TS_CE_SYMBOL: string = tsLockedCE.tradingsymbol;
        const TS_CE_STRIKE: number = tsLockedCE.strike;
        const TS_PE_TOKEN: number = tsLockedPE.instrument_token;
        const TS_PE_SYMBOL: string = tsLockedPE.tradingsymbol;
        const TS_PE_STRIKE: number = tsLockedPE.strike;

        // Fetch NIFTY SPOT 5m candles (prior window for 200 EMA warmup + today)
        const ts5mPrior = await kc.getHistoricalData(
          tsIndexInst.instrument_token,
          '5minute',
          prevWindowFrom,
          yesterdayTo,
        );
        const ts5mToday = await kc.getHistoricalData(
          tsIndexInst.instrument_token,
          '5minute',
          todayFrom,
          todayTo,
        );

        if (!ts5mToday || ts5mToday.length < 5) {
          this.logger.warn(
            `[TRIPLE_SYNC] Not enough 5m candles for ${symbol} on ${todayStr}`,
          );
          return { options: [] };
        }

        // Fetch CE and PE option 5m candles for the same day
        const [tsCeRaw, tsPeRaw] = await Promise.all([
          kc
            .getHistoricalData(TS_CE_TOKEN, '5minute', todayFrom, todayTo)
            .catch(() => []),
          kc
            .getHistoricalData(TS_PE_TOKEN, '5minute', todayFrom, todayTo)
            .catch(() => []),
        ]);

        // Filter all to specificTime window
        const [tsTargetHour, tsTargetMin] = specificTime.split(':').map(Number);
        const tsTimeFilter = (c: any) => {
          const d = new Date(c.date);
          return (
            d.getHours() < tsTargetHour ||
            (d.getHours() === tsTargetHour && d.getMinutes() <= tsTargetMin)
          );
        };
        const ts5mUpToTime = ts5mToday.filter(tsTimeFilter);
        const tsCeUpToTime: any[] = (tsCeRaw as any[]).filter(tsTimeFilter);
        const tsPeUpToTime: any[] = (tsPeRaw as any[]).filter(tsTimeFilter);

        // Build time→index maps for CE and PE candles (key: "HH:MM")
        const tsNonSpotBuildTimeMap = (candles: any[]): Map<string, number> => {
          const map = new Map<string, number>();
          candles.forEach((c: any, idx: number) => {
            const d = new Date(c.date);
            const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            map.set(key, idx);
          });
          return map;
        };
        const tsCeTimeMap = tsNonSpotBuildTimeMap(tsCeUpToTime);
        const tsPeTimeMap = tsNonSpotBuildTimeMap(tsPeUpToTime);

        const tsNonSpotOptIdxAt = (
          spotIdx: number,
          timeMap: Map<string, number>,
        ): number => {
          const sc = ts5mUpToTime[spotIdx];
          if (!sc) return -1;
          const d = new Date(sc.date);
          const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return timeMap.get(key) ?? -1;
        };

        // Signal detection on SPOT candles
        const tsSeedCandles =
          ts5mPrior && ts5mPrior.length > 0 ? ts5mPrior : [];
        const tsAllCandles = [...tsSeedCandles, ...ts5mUpToTime];
        const tsSeedCount = tsSeedCandles.length;

        const tsSignals = detectTripleSyncSignals(tsAllCandles, {
          debug: false,
          enableDiagLog: true,
        });
        const tsTodaySignals = tsSignals.filter(
          (s) => s.candleIndex >= tsSeedCount,
        );

        // Lot / qty setup
        const tsPaperSettings = await this.prisma.tradingSettings
          .findUnique({
            where: { userId_symbol: { userId: broker.userId, symbol } },
          })
          .catch(() => null);
        const tsLotSizes: Record<string, number> = {
          NIFTY: 65,
          BANKNIFTY: 30,
          FINNIFTY: 65,
          SENSEX: 20,
          MIDCPNIFTY: 75,
        };
        const tsLotSize = tsLotSizes[symbol] ?? 1;
        const tsPaperLots = tsPaperSettings?.paperLots ?? 1;
        const tsTotalQty = tsPaperLots * tsLotSize;
        const tsHalfQty = Math.floor(tsTotalQty / 2);
        const tsRemainingQty = tsTotalQty - tsHalfQty;
        const tsEodCeClose =
          tsCeUpToTime.length > 0
            ? tsCeUpToTime[tsCeUpToTime.length - 1].close
            : 0;
        const tsEodPeClose =
          tsPeUpToTime.length > 0
            ? tsPeUpToTime[tsPeUpToTime.length - 1].close
            : 0;

        // Per-signal loop — one active trade at a time per direction
        const tsOutputSignals: any[] = [];
        let activeBuyClosedAt = -1;
        let activeSellClosedAt = -1;

        for (const sig of tsTodaySignals) {
          const {
            entryPrice: spotEntry,
            stopLoss,
            risk,
            target1: t1,
            target2: t2,
            target3: t3,
            signalType,
            candleTime,
            candleDate,
            reason: sigReason,
            candleIndex,
          } = sig;
          const actualIdx = candleIndex - tsSeedCount;
          const isBuy = signalType === 'BUY';

          if (isBuy && activeBuyClosedAt >= actualIdx) continue;
          if (!isBuy && activeSellClosedAt >= actualIdx) continue;

          const tsOptUpToTime = isBuy ? tsCeUpToTime : tsPeUpToTime;
          const tsOptTimeMap = isBuy ? tsCeTimeMap : tsPeTimeMap;
          const tsEodOptClose = isBuy ? tsEodCeClose : tsEodPeClose;
          const tsOptSymbol = isBuy ? TS_CE_SYMBOL : TS_PE_SYMBOL;

          const optEntryIdx = tsNonSpotOptIdxAt(actualIdx, tsOptTimeMap);
          const optEntryPrice =
            optEntryIdx >= 0 ? tsOptUpToTime[optEntryIdx].close : null;

          // Outcome simulation on SPOT price
          let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
          let t1HitSpotIdx = -1;
          let closeSpotIdx = ts5mUpToTime.length - 1;

          for (let j = actualIdx + 1; j < ts5mUpToTime.length; j++) {
            const fc = ts5mUpToTime[j];
            const t1Hit = isBuy ? fc.high >= t1 : fc.low <= t1;
            const slHit = isBuy ? fc.low <= stopLoss : fc.high >= stopLoss;
            if (t1Hit) {
              t1HitSpotIdx = j;
              break;
            }
            if (slHit) {
              outcome = 'SL';
              closeSpotIdx = j;
              break;
            }
          }
          if (t1HitSpotIdx >= 0) {
            let phase2Done = false;
            for (let j = t1HitSpotIdx; j < ts5mUpToTime.length; j++) {
              const fc = ts5mUpToTime[j];
              const beHit = isBuy ? fc.low <= spotEntry : fc.high >= spotEntry;
              const t3Hit = isBuy ? fc.high >= t3 : fc.low <= t3;
              const t2Hit = isBuy ? fc.high >= t2 : fc.low <= t2;
              if (beHit) {
                outcome = 'BE';
                closeSpotIdx = j;
                phase2Done = true;
                break;
              }
              if (t3Hit) {
                outcome = 'T3';
                closeSpotIdx = j;
                phase2Done = true;
                break;
              }
              if (t2Hit) {
                outcome = 'T2';
                closeSpotIdx = j;
                phase2Done = true;
                break;
              }
            }
            if (!phase2Done) {
              outcome = 'T1';
              closeSpotIdx = t1HitSpotIdx;
            }
          }

          if (isBuy) activeBuyClosedAt = closeSpotIdx;
          else activeSellClosedAt = closeSpotIdx;

          // Option P&L
          let pnl = 0;
          if (optEntryPrice !== null && optEntryPrice > 0) {
            const tsNonSpotOptPriceAt = (
              spotIdx: number,
              favourable: boolean,
            ): number => {
              const oi = tsNonSpotOptIdxAt(spotIdx, tsOptTimeMap);
              if (oi < 0) return tsEodOptClose || optEntryPrice;
              const oc = tsOptUpToTime[oi];
              return favourable ? oc.high : oc.low;
            };

            if (outcome === 'SL') {
              pnl =
                (tsNonSpotOptPriceAt(closeSpotIdx, false) - optEntryPrice) *
                tsTotalQty;
            } else if (outcome === 'BE' && t1HitSpotIdx >= 0) {
              pnl =
                (tsNonSpotOptPriceAt(t1HitSpotIdx, true) - optEntryPrice) *
                tsHalfQty;
            } else if (t1HitSpotIdx >= 0) {
              pnl =
                (tsNonSpotOptPriceAt(t1HitSpotIdx, true) - optEntryPrice) *
                  tsHalfQty +
                (tsNonSpotOptPriceAt(closeSpotIdx, true) - optEntryPrice) *
                  tsRemainingQty;
            } else {
              pnl =
                ((tsEodOptClose || optEntryPrice) - optEntryPrice) * tsTotalQty;
            }
          }

          const optEntryStr =
            optEntryPrice !== null
              ? `@ ₹${optEntryPrice.toFixed(2)}`
              : '(option data N/A)';

          tsOutputSignals.push({
            time: candleTime,
            date: candleDate,
            timestamp:
              Math.floor(new Date(candleDate).getTime() / 1000) + 19800,
            recommendation: signalType,
            reason: `${isBuy ? 'BUY CE' : 'BUY PE'} ${tsOptSymbol} ${optEntryStr} | ${symbol} ${isBuy ? 'bullish' : 'bearish'}: EMA ${sig.indicators.ema200.toFixed(2)}, ADX ${sig.indicators.adx.toFixed(1)}, RRR ${sig.rrr.toFixed(2)} (Spot risk: ${risk.toFixed(1)}pts)`,
            price: optEntryPrice ?? spotEntry,
            stopLoss,
            target1: t1,
            target2: t2,
            target3: t3,
            patternName: sigReason,
            outcome,
            pnl: Math.round(pnl),
          });
        }

        const tsCeLtp =
          tsCeUpToTime.length > 0
            ? tsCeUpToTime[tsCeUpToTime.length - 1].close
            : 0;
        const tsPeLtp =
          tsPeUpToTime.length > 0
            ? tsPeUpToTime[tsPeUpToTime.length - 1].close
            : 0;

        const tsOutputOptions: any[] = [];
        const ceSigs = tsOutputSignals.filter((s) =>
          s.reason.startsWith('BUY CE'),
        );
        const peSigs = tsOutputSignals.filter((s) =>
          s.reason.startsWith('BUY PE'),
        );
        if (ceSigs.length > 0) {
          tsOutputOptions.push({
            symbol: TS_CE_SYMBOL,
            strike: TS_CE_STRIKE,
            optionType: 'CE',
            tradingsymbol: TS_CE_SYMBOL,
            instrumentToken: TS_CE_TOKEN,
            signals: ceSigs,
            ltp: tsCeLtp,
          });
        }
        if (peSigs.length > 0) {
          tsOutputOptions.push({
            symbol: TS_PE_SYMBOL,
            strike: TS_PE_STRIKE,
            optionType: 'PE',
            tradingsymbol: TS_PE_SYMBOL,
            instrumentToken: TS_PE_TOKEN,
            signals: peSigs,
            ltp: tsPeLtp,
          });
        }

        this.logger.log(
          `[TRIPLE_SYNC] ${symbol} on ${todayStr}: ${tsTodaySignals.length} spot signals → ` +
            `${ceSigs.length} CE / ${peSigs.length} PE option signals`,
        );
        return { options: tsOutputOptions };
      }
      // ─────────────────────────────────────────────────────────────────────

      // Fetch paper trade settings for P&L calculation (once, before batch)
      const paperTradeSettings = await this.prisma.tradingSettings
        .findUnique({
          where: { userId_symbol: { userId: broker.userId, symbol } },
        })
        .catch(() => null);
      const paperLots = paperTradeSettings?.paperLots ?? 1;
      const minSellRsi = paperTradeSettings?.minSellRsi ?? 45;
      const maxSellRiskPts = paperTradeSettings?.maxSellRiskPts ?? 30;
      const placeQtyBasedOnSL = paperTradeSettings?.placeQtyBasedOnSL ?? false;
      const perTradeLoss = paperTradeSettings?.perTradeLoss ?? 20000;
      const perDayLoss = paperTradeSettings?.perDayLoss ?? 40000;
      const enableNiftyTrendFilter =
        paperTradeSettings?.enableNiftyTrendFilter ?? false;
      const enableConfluenceChecker =
        paperTradeSettings?.enableConfluenceChecker ?? false;

      const results: any[] = [];

      this.logger.log(
        `Starting to fetch data for ${limitedInstruments.length} instruments`,
      );

      // Fetch historical data for each option (simplified - no filtering yet)
      // Process in batches to avoid rate limits
      const batchSize = 5;
      for (let i = 0; i < limitedInstruments.length; i += batchSize) {
        const batch = limitedInstruments.slice(i, i + batchSize);

        this.logger.log(
          `Processing batch ${i / batchSize + 1}, instruments: ${batch.map((b) => b.tradingsymbol).join(', ')}`,
        );

        const batchPromises = batch.map(async (inst) => {
          try {
            // Clean symbol name by removing quotes
            let cleanSymbol = inst.name;
            if (
              cleanSymbol &&
              cleanSymbol.startsWith('"') &&
              cleanSymbol.endsWith('"')
            ) {
              cleanSymbol = cleanSymbol.slice(1, -1);
            }

            // ============ DAY_SELLING STRATEGY ============
            if (strategy === 'DAY_SELLING') {
              // DAY_SELLING: Look for SELL signals only (bearish patterns)
              // - 20 EMA rejection at resistance
              // - Yesterday's high rejection
              // - Swing high rejection
              // - Bearish candlestick patterns
              // - Max loss: 30 points, Targets: 60, 90, 120 points (1:2, 1:3, 1:4)

              this.logger.debug(
                `[DAY_SELLING] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles (cache-first: replays from CandleCache for expired options)
              const intradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              this.logger.debug(
                `[DAY_SELLING] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 20`,
                );
                return null;
              }

              // Fetch yesterday's day data for high level.
              // In DB (historic) mode, derive from the previous day's CandleCache 5-minute
              // data so we never touch the live Kite API (access token may be expired).
              // Live mode: fall back to the wide 7-day window to handle holidays.
              let yesterdayDayData: any[];
              if (instrumentSource === 'db') {
                const prevCandles = await this.getPrevDayCandlesFromCache(
                  inst.instrument_token,
                  todayStr,
                  '5minute',
                );
                if (prevCandles && prevCandles.length > 0) {
                  yesterdayDayData = [
                    {
                      date: prevCandles[0].date,
                      open: prevCandles[0].open,
                      high: Math.max(...prevCandles.map((c: any) => c.high)),
                      low: Math.min(...prevCandles.map((c: any) => c.low)),
                      close: prevCandles[prevCandles.length - 1].close,
                      volume: prevCandles.reduce(
                        (s: number, c: any) => s + (c.volume || 0),
                        0,
                      ),
                    },
                  ];
                } else {
                  yesterdayDayData = [];
                }
              } else {
                yesterdayDayData = await kc.getHistoricalData(
                  inst.instrument_token,
                  'day',
                  prevWindowFrom,
                  yesterdayTo,
                );
              }

              let yesterdayHigh = 0;
              let prevDayLow = 0;
              let perOptPrevDayClose = 0;
              if (yesterdayDayData && yesterdayDayData.length > 0) {
                // Use LAST entry — most recent trading day (handles multi-day window for holidays)
                yesterdayHigh =
                  yesterdayDayData[yesterdayDayData.length - 1].high;
                prevDayLow = yesterdayDayData[yesterdayDayData.length - 1].low;
                perOptPrevDayClose =
                  yesterdayDayData[yesterdayDayData.length - 1].close;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday high = ${yesterdayHigh}, prev day low = ${prevDayLow}, prev day close = ${perOptPrevDayClose}`,
                );
              }

              // Fetch yesterday's intraday data to pre-seed EMA/RSI/SuperTrend.
              // In DB (historic) mode, read from CandleCache for the previous day
              // instead of calling the live Kite API.
              let yesterdayIntradayData: any[];
              if (instrumentSource === 'db') {
                yesterdayIntradayData =
                  (await this.getPrevDayCandlesFromCache(
                    inst.instrument_token,
                    todayStr,
                    interval,
                  )) ?? [];
              } else {
                yesterdayIntradayData = await kc.getHistoricalData(
                  inst.instrument_token,
                  interval,
                  prevWindowFrom,
                  yesterdayTo,
                );
              }

              this.logger.debug(
                `${inst.tradingsymbol}: Fetched ${yesterdayIntradayData?.length || 0} candles from prev window (${prevWindowFrom} → ${yesterdayTo})`,
              );

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 1) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA with pre-seeding from yesterday's data
              let emaValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 20) {
                // Pre-seed EMA: Combine yesterday's last 25 candles + today's candles
                const yesterdayLast25 = yesterdayIntradayData.slice(-25);
                const combinedCandles = [
                  ...yesterdayLast25,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map((c) => c.close);

                // Calculate EMA on combined data
                const combinedEMA = this.indicators.calculateEMA(
                  combinedClosePrices,
                  20,
                );

                // Extract only today's EMA values (skip yesterday's candles)
                emaValues = combinedEMA.slice(yesterdayLast25.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday. EMA available from first candle.`,
                );
              } else {
                // Fallback: Standard EMA calculation if no yesterday data
                this.logger.warn(
                  `${inst.tradingsymbol}: No sufficient yesterday data for EMA pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c) => c.close);
                emaValues = this.indicators.calculateEMA(closePrices, 20);
              }

              // Calculate RSI (for display only, doesn't affect signal generation)
              // Pre-seed RSI with yesterday's data for better accuracy
              let rsiValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
                // Pre-seed RSI: Combine yesterday's candles + today's candles
                const yesterdayForRSI = yesterdayIntradayData.slice(-30); // Use more data for RSI smoothing
                const combinedCandles = [
                  ...yesterdayForRSI,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map((c) => c.close);

                // Calculate RSI on combined data
                const combinedRSI = this.indicators.calculateRSI(
                  combinedClosePrices,
                  14,
                );

                // Extract only today's RSI values (skip yesterday's candles)
                rsiValues = combinedRSI.slice(yesterdayForRSI.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
                );
              } else {
                // Fallback: Standard RSI calculation if no yesterday data
                this.logger.debug(
                  `${inst.tradingsymbol}: No sufficient yesterday data for RSI pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c) => c.close);
                rsiValues = this.indicators.calculateRSI(closePrices, 14);
              }

              // ── SuperTrend multi-timeframe filter setup ───────────────────────────────
              // SuperTrend(7,3) on primary interval candles (pre-seeded with yesterday)
              let stValues1min: Array<{
                superTrend: number;
                trend: 'up' | 'down';
              } | null> = [];
              {
                const stSeedOffset =
                  yesterdayIntradayData && yesterdayIntradayData.length >= 10
                    ? Math.min(20, yesterdayIntradayData.length)
                    : 0;
                const stSeedCandles =
                  stSeedOffset > 0
                    ? [
                        ...yesterdayIntradayData.slice(-stSeedOffset),
                        ...candlesUpToTime,
                      ]
                    : candlesUpToTime;
                const fullST1 = this.indicators.calculateSuperTrend(
                  stSeedCandles,
                  10,
                  4,
                );
                stValues1min =
                  stSeedOffset > 0 ? fullST1.slice(stSeedOffset) : fullST1;
              }

              // 5min double-check only when primary interval is 1min
              const need5minSTCheck = interval === 'minute';
              let intraday5min: any[] = [];
              let ema5min: (number | null)[] = [];
              let st5minValues: Array<{
                superTrend: number;
                trend: 'up' | 'down';
              } | null> = [];
              if (need5minSTCheck) {
                try {
                  const [hist5min, yest5min] = await Promise.all([
                    this.getCandlesWithCache(
                      kc,
                      inst.instrument_token,
                      '5minute',
                      todayFrom,
                      todayTo,
                      instrumentSource === 'db',
                    ),
                    instrumentSource === 'db'
                      ? Promise.resolve([])
                      : kc.getHistoricalData(
                          inst.instrument_token,
                          '5minute',
                          yesterdayFrom,
                          yesterdayTo,
                        ),
                  ]);
                  if (hist5min && hist5min.length >= 3) {
                    intraday5min = hist5min;
                    const seed5Offset =
                      yest5min && yest5min.length >= 10
                        ? Math.min(20, yest5min.length)
                        : 0;
                    const seed5 =
                      seed5Offset > 0
                        ? [...yest5min.slice(-seed5Offset), ...hist5min]
                        : hist5min;
                    ema5min = this.indicators
                      .calculateEMA(
                        seed5.map((c) => c.close),
                        20,
                      )
                      .slice(seed5Offset);
                    st5minValues = this.indicators
                      .calculateSuperTrend(seed5, 10, 4)
                      .slice(seed5Offset);
                    this.logger.debug(
                      `${inst.tradingsymbol}: Fetched ${hist5min.length} × 5min candles for ST filter`,
                    );
                  }
                } catch (e: any) {
                  this.logger.warn(
                    `${inst.tradingsymbol}: Failed to fetch 5min data for ST filter — ${e.message}`,
                  );
                }
              }

              // Find swing highs (local peaks in the session)
              const swingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < candlesUpToTime.length - 5; i++) {
                const candle = candlesUpToTime[i];
                const prevCandles = candlesUpToTime.slice(i - 5, i);
                const nextCandles = candlesUpToTime.slice(i + 1, i + 6);

                const isLocalHigh =
                  prevCandles.every((c) => c.high < candle.high) &&
                  nextCandles.every((c) => c.high < candle.high);

                if (isLocalHigh) {
                  swingHighs.push({ price: candle.high, index: i });
                }
              }

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${swingHighs.length} swing highs`,
              );

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;
              const eodClose = lastCandle.close ?? 0;

              // Per-instrument P&L quantities (paperLots from outer scope, lotSize from instrument)
              const instLotSize = canonicalLotSize(symbol, inst.lot_size);
              const instTotalQty = paperLots * instLotSize;
              const instHalfQty = Math.floor(instTotalQty / 2);
              const instRemainingQty = instTotalQty - instHalfQty;

              // Check ALL candles for SELL signals using shared engine
              const sellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              const superTrendData = this.indicators.calculateSuperTrend(
                candlesUpToTime,
                10,
                2,
              );
              const daySellCandidates = detectDaySellSignals({
                candles: candlesUpToTime,
                emaValues,
                rsiValues,
                swingHighs,
                yesterdayHigh,
                prevDayLow,
                prevDayClose: perOptPrevDayClose,
                marginPoints,
                minSellRsi,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData,
              });

              let activeTradeClosed = true;
              let consecutiveSLHits = 0; // Rule 2: stop after 2 back-to-back SL hits
              let dailyStopTrading = false; // Rule 2+3: halt flag
              for (const sig of daySellCandidates) {
                // One trade at a time: skip if previous trade is still open
                if (dailyStopTrading) break; // stop generating new signals for the day
                if (!activeTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: candleTimestamp,
                  reason: signalReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                // No extra ST/RSI filtering here — detectDaySellSignals already applies
                // all quality gates (EMA filter, resistance check, pattern validation, risk cap).
                // Adding extra filters only here (not in getOptionChartData) causes listing vs
                // chart inconsistency. Both paths now use identical signal criteria.

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                // Phase 1: scan for SL hit or T1 hit
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                activeTradeClosed = false;
                let t1HitIndex = -1;
                for (
                  let j = actualCandleIndex + 1;
                  j < candlesUpToTime.length;
                  j++
                ) {
                  const fc = candlesUpToTime[j];
                  // Check T1 before SL: on expiry-day volatile candles, the option
                  // may dip to T1 and then reverse past SL in the same 5m candle.
                  // Checking T1 first ensures intrabar T1→BE sequences are
                  // correctly captured in phase 2 rather than being called SL.
                  if (fc.low <= target1) {
                    t1HitIndex = j;
                    this.logger.debug(
                      `${inst.tradingsymbol}: T1 HIT at ${target1.toFixed(2)}, entering phase 2.`,
                    );
                    break;
                  }
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    activeTradeClosed = true;
                    this.logger.debug(
                      `${inst.tradingsymbol}: SL HIT at ${stopLoss.toFixed(2)}.`,
                    );
                    break;
                  }
                }

                // Phase 2: T1 hit — track remaining 50% with BE-adjusted SL.
                // Start from the T1 candle itself: if the same candle that hit T1
                // also has high >= entryPrice, that counts as BE.
                if (t1HitIndex >= 0) {
                  let phase2Done = false;
                  for (let j = t1HitIndex; j < candlesUpToTime.length; j++) {
                    const fc = candlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: BREAK EVEN triggered, remaining 50% exits at ${entryPrice.toFixed(2)}.`,
                      );
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: TARGET 1:4 HIT at ${target3.toFixed(2)}.`,
                      );
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      activeTradeClosed = true;
                      phase2Done = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: TARGET 1:3 HIT at ${target2.toFixed(2)}.`,
                      );
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    activeTradeClosed = true;
                    this.logger.debug(
                      `${inst.tradingsymbol}: T1 outcome — market closed before T2/BE, remaining 50% at EOD.`,
                    );
                  }
                }

                // P&L calculation (SELL: profit = entry - exit per unit)
                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * instTotalQty;
                } else if (t1HitIndex >= 0) {
                  const t1Profit = (entryPrice - target1) * instHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit; // remaining 50% exits at entry → 0
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * instRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * instRemainingQty;
                  } else {
                    // T1: remaining 50% closed at EOD
                    pnl = t1Profit + (entryPrice - eodClose) * instRemainingQty;
                  }
                } else {
                  // OPEN: no T1 hit, full position closed at EOD
                  pnl = (entryPrice - eodClose) * instTotalQty;
                }

                // === DAILY STOP RULES ===
                // Rule 2: 2 consecutive SL hits → max daily loss reached (2 × 30 pts = 60 pts)
                // Rule 3: Target or BE hit → protect the gain, stop for the day
                if (outcome === 'SL') {
                  consecutiveSLHits++;
                  if (consecutiveSLHits >= 2) dailyStopTrading = true;
                } else if (outcome !== 'OPEN') {
                  // T1 / T2 / T3 / BE — a profitable close → stop trading for the day
                  consecutiveSLHits = 0;
                  dailyStopTrading = true;
                }

                sellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: candleTimestamp,
                  recommendation: 'SELL',
                  reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: signalReason,
                  outcome,
                  pnl: Math.round(pnl),
                });

                this.logger.debug(
                  `${inst.tradingsymbol}: SELL signal at ${candleTime}, Reason: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)} (Risk: ${risk.toFixed(1)}pts), T1: ${target1.toFixed(2)}, Outcome: ${outcome}`,
                );

                if (!activeTradeClosed) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: Trade still OPEN at end of day.`,
                  );
                }
              }
              if (sellSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No SELL signals found`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${sellSignals.length} SELL signal(s)`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: sellSignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime, // Include candles for historical trade closure
              };
            }

            // ============ DAY_SELLING_V2 STRATEGY ============
            if (strategy === 'DAY_SELLING_V2') {
              this.logger.debug(
                `[DAY_SELLING_V2] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V2.`,
                );
                return null;
              }

              const intradayHistoricalV2 = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!intradayHistoricalV2 || intradayHistoricalV2.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V2 (${intradayHistoricalV2?.length || 0})`,
                );
                return null;
              }

              const yesterday2DayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      prevWindowFrom,
                      yesterdayTo,
                    );

              let v2YestHigh = 0;
              let v2PrevDayLow = 0;
              let v2PrevDayClose = 0;
              if (yesterday2DayData && yesterday2DayData.length > 0) {
                v2YestHigh =
                  yesterday2DayData[yesterday2DayData.length - 1].high;
                v2PrevDayLow =
                  yesterday2DayData[yesterday2DayData.length - 1].low;
                v2PrevDayClose =
                  yesterday2DayData[yesterday2DayData.length - 1].close;
              }

              const yesterday2IntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );

              const [v2TargetHour, v2TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v2CandlesUpToTime = intradayHistoricalV2.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v2TargetHour ||
                    (d.getHours() === v2TargetHour &&
                      d.getMinutes() <= v2TargetMin)
                  );
                },
              );

              if (v2CandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let v2EmaValues: (number | null)[];
              if (
                yesterday2IntradayData &&
                yesterday2IntradayData.length >= 20
              ) {
                const seed = yesterday2IntradayData.slice(-25);
                const combined = [...seed, ...v2CandlesUpToTime];
                v2EmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v2EmaValues = this.indicators.calculateEMA(
                  v2CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let v2RsiValues: (number | null)[];
              if (
                yesterday2IntradayData &&
                yesterday2IntradayData.length >= 14
              ) {
                const seed = yesterday2IntradayData.slice(-30);
                const combined = [...seed, ...v2CandlesUpToTime];
                v2RsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v2RsiValues = this.indicators.calculateRSI(
                  v2CandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v2SwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v2CandlesUpToTime.length - 5; i++) {
                const c = v2CandlesUpToTime[i];
                const prev5 = v2CandlesUpToTime.slice(i - 5, i);
                const next5 = v2CandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v2SwingHighs.push({ price: c.high, index: i });
                }
              }

              const v2SuperTrend = this.indicators.calculateSuperTrend(
                v2CandlesUpToTime,
                10,
                2,
              );

              const v2LastCandle =
                v2CandlesUpToTime[v2CandlesUpToTime.length - 1];
              const v2Ltp = v2LastCandle.close || 0;
              const v2EodClose = v2LastCandle.close ?? 0;
              const v2LotSize = canonicalLotSize(symbol, inst.lot_size);
              const v2TotalQty = paperLots * v2LotSize;
              const v2HalfQty = Math.floor(v2TotalQty / 2);
              const v2RemainingQty = v2TotalQty - v2HalfQty;

              const v2SignalCandidates = detectDaySellSignalsV2({
                candles: v2CandlesUpToTime,
                emaValues: v2EmaValues,
                rsiValues: v2RsiValues,
                swingHighs: v2SwingHighs,
                yesterdayHigh: v2YestHigh,
                prevDayLow: v2PrevDayLow,
                prevDayClose: v2PrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v2SuperTrend,
              });

              const v2SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v2ActiveTradeClosed = true;
              let v2ConsecSL = 0;
              let v2DailyStop = false;

              for (const sig of v2SignalCandidates) {
                if (v2DailyStop) break;
                if (!v2ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v2Ts,
                  reason: v2Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v2ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v2CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v2CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v2ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v2CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v2CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v2ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v2ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v2TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v2HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v2RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v2RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v2EodClose) * v2RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v2EodClose) * v2TotalQty;
                }

                if (outcome === 'SL') {
                  v2ConsecSL++;
                  if (v2ConsecSL >= 2) v2DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v2ConsecSL = 0;
                  v2DailyStop = true;
                }

                v2SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v2Ts,
                  recommendation: 'SELL',
                  reason: `${v2Reason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v2Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v2SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v2SellSignals,
                ltp: v2Ltp,
                lotSize: inst.lot_size,
                candles: v2CandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V2_ENHANCED STRATEGY ============
            if (strategy === 'DAY_SELLING_V2_ENHANCED') {
              this.logger.debug(
                `[DAY_SELLING_V2_ENHANCED] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V2_ENHANCED.`,
                );
                return null;
              }

              const v2eIntradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!v2eIntradayHistorical || v2eIntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V2E (${v2eIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v2eDayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      prevWindowFrom,
                      yesterdayTo,
                    );

              let v2eYestHigh = 0;
              let v2ePrevDayLow = 0;
              let v2ePrevDayClose = 0;
              if (v2eDayData && v2eDayData.length > 0) {
                v2eYestHigh = v2eDayData[v2eDayData.length - 1].high;
                v2ePrevDayLow = v2eDayData[v2eDayData.length - 1].low;
                v2ePrevDayClose = v2eDayData[v2eDayData.length - 1].close;
              }

              const v2eYestIntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );

              const [v2eTargetHour, v2eTargetMin] = specificTime
                .split(':')
                .map(Number);
              const v2eCandlesUpToTime = v2eIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v2eTargetHour ||
                    (d.getHours() === v2eTargetHour &&
                      d.getMinutes() <= v2eTargetMin)
                  );
                },
              );

              if (v2eCandlesUpToTime.length < 1) return null;

              // 20 EMA pre-seeding
              let v2eEma20Values: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length >= 20) {
                const seed = v2eYestIntradayData.slice(-25);
                const combined = [...seed, ...v2eCandlesUpToTime];
                v2eEma20Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v2eEma20Values = this.indicators.calculateEMA(
                  v2eCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // 8 EMA pre-seeding
              let v2eEma8Values: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length > 0) {
                const seed8 = v2eYestIntradayData.slice(-15);
                const combined8 = [...seed8, ...v2eCandlesUpToTime];
                v2eEma8Values = this.indicators
                  .calculateEMA(
                    combined8.map((c) => c.close),
                    8,
                  )
                  .slice(seed8.length);
              } else {
                v2eEma8Values = this.indicators.calculateEMA(
                  v2eCandlesUpToTime.map((c) => c.close),
                  8,
                );
              }

              // RSI pre-seeding
              let v2eRsiValues: (number | null)[];
              if (v2eYestIntradayData && v2eYestIntradayData.length >= 14) {
                const seed = v2eYestIntradayData.slice(-30);
                const combined = [...seed, ...v2eCandlesUpToTime];
                v2eRsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v2eRsiValues = this.indicators.calculateRSI(
                  v2eCandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v2eSwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v2eCandlesUpToTime.length - 5; i++) {
                const c = v2eCandlesUpToTime[i];
                const prev5 = v2eCandlesUpToTime.slice(i - 5, i);
                const next5 = v2eCandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v2eSwingHighs.push({ price: c.high, index: i });
                }
              }

              const v2eSuperTrend = this.indicators.calculateSuperTrend(
                v2eCandlesUpToTime,
                10,
                2,
              );

              const v2eLastCandle =
                v2eCandlesUpToTime[v2eCandlesUpToTime.length - 1];
              const v2eLtp = v2eLastCandle.close || 0;
              const v2eEodClose = v2eLastCandle.close ?? 0;
              const v2eLotSize = canonicalLotSize(symbol, inst.lot_size);
              const v2eTotalQty = paperLots * v2eLotSize;
              const v2eHalfQty = Math.floor(v2eTotalQty / 2);
              const v2eRemainingQty = v2eTotalQty - v2eHalfQty;

              const v2eSignalCandidates = detectDaySellSignalsV2Enhanced({
                candles: v2eCandlesUpToTime,
                ema20Values: v2eEma20Values,
                ema8Values: v2eEma8Values,
                rsiValues: v2eRsiValues,
                swingHighs: v2eSwingHighs,
                yesterdayHigh: v2eYestHigh,
                prevDayLow: v2ePrevDayLow,
                prevDayClose: v2ePrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v2eSuperTrend,
              });

              const v2eSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v2eActiveTradeClosed = true;
              let v2eConsecSL = 0;
              let v2eDailyStop = false;

              for (const sig of v2eSignalCandidates) {
                if (v2eDailyStop) break;
                if (!v2eActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v2eTs,
                  reason: v2eReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v2eActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v2eCandlesUpToTime.length;
                  j++
                ) {
                  const fc = v2eCandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v2eActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v2eCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v2eCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v2eActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v2eActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v2eTotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v2eHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v2eRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v2eRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - v2eEodClose) * v2eRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v2eEodClose) * v2eTotalQty;
                }

                if (outcome === 'SL') {
                  v2eConsecSL++;
                  if (v2eConsecSL >= 2) v2eDailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v2eConsecSL = 0;
                  v2eDailyStop = true;
                }

                v2eSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v2eTs,
                  recommendation: 'SELL',
                  reason: `${v2eReason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v2eReason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v2eSellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v2eSellSignals,
                ltp: v2eLtp,
                lotSize: inst.lot_size,
                candles: v2eCandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V1V2 STRATEGY ============
            if (strategy === 'DAY_SELLING_V1V2') {
              this.logger.debug(
                `[DAY_SELLING_V1V2] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V1V2.`,
                );
                return null;
              }

              const intradayHistoricalC = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!intradayHistoricalC || intradayHistoricalC.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V1V2 (${intradayHistoricalC?.length || 0})`,
                );
                return null;
              }

              const cYesterday2DayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      prevWindowFrom,
                      yesterdayTo,
                    );

              let cYestHigh = 0;
              let cPrevDayLow = 0;
              let cPrevDayClose = 0;
              if (cYesterday2DayData && cYesterday2DayData.length > 0) {
                cYestHigh =
                  cYesterday2DayData[cYesterday2DayData.length - 1].high;
                cPrevDayLow =
                  cYesterday2DayData[cYesterday2DayData.length - 1].low;
                cPrevDayClose =
                  cYesterday2DayData[cYesterday2DayData.length - 1].close;
              }

              const cYesterday2IntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );

              const [cTargetHour, cTargetMin] = specificTime
                .split(':')
                .map(Number);
              const cCandlesUpToTime = intradayHistoricalC.filter((candle) => {
                const d = new Date(candle.date);
                return (
                  d.getHours() < cTargetHour ||
                  (d.getHours() === cTargetHour && d.getMinutes() <= cTargetMin)
                );
              });

              if (cCandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let cEmaValues: (number | null)[];
              if (
                cYesterday2IntradayData &&
                cYesterday2IntradayData.length >= 20
              ) {
                const seed = cYesterday2IntradayData.slice(-25);
                const combined = [...seed, ...cCandlesUpToTime];
                cEmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                cEmaValues = this.indicators.calculateEMA(
                  cCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let cRsiValues: (number | null)[];
              if (
                cYesterday2IntradayData &&
                cYesterday2IntradayData.length >= 14
              ) {
                const seed = cYesterday2IntradayData.slice(-30);
                const combined = [...seed, ...cCandlesUpToTime];
                cRsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                cRsiValues = this.indicators.calculateRSI(
                  cCandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const cSwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < cCandlesUpToTime.length - 5; i++) {
                const c = cCandlesUpToTime[i];
                const prev5 = cCandlesUpToTime.slice(i - 5, i);
                const next5 = cCandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  cSwingHighs.push({ price: c.high, index: i });
                }
              }

              const cSuperTrend = this.indicators.calculateSuperTrend(
                cCandlesUpToTime,
                10,
                2,
              );

              const cLastCandle = cCandlesUpToTime[cCandlesUpToTime.length - 1];
              const cLtp = cLastCandle.close || 0;
              const cEodClose = cLastCandle.close ?? 0;
              const cLotSize = canonicalLotSize(symbol, inst.lot_size);
              const cTotalQty = paperLots * cLotSize;
              const cHalfQty = Math.floor(cTotalQty / 2);
              const cRemainingQty = cTotalQty - cHalfQty;

              const cSignalCandidates = detectDaySellSignalsCombined({
                candles: cCandlesUpToTime,
                emaValues: cEmaValues,
                rsiValues: cRsiValues,
                swingHighs: cSwingHighs,
                yesterdayHigh: cYestHigh,
                prevDayLow: cPrevDayLow,
                prevDayClose: cPrevDayClose,
                marginPoints,
                minSellRsi,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: cSuperTrend,
              });

              const cSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let cActiveTradeClose = true;
              let cConsecSL = 0;
              let cDailyStop = false;

              for (const sig of cSignalCandidates) {
                if (cDailyStop) break;
                if (!cActiveTradeClose) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: cTs,
                  reason: cReason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                cActiveTradeClose = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < cCandlesUpToTime.length;
                  j++
                ) {
                  const fc = cCandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    cActiveTradeClose = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (let j = t1HitIdx + 1; j < cCandlesUpToTime.length; j++) {
                    const fc = cCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      cActiveTradeClose = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    cActiveTradeClose = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * cTotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * cHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * cRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * cRemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - cEodClose) * cRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - cEodClose) * cTotalQty;
                }

                if (outcome === 'SL') {
                  cConsecSL++;
                  if (cConsecSL >= 2) cDailyStop = true;
                } else if (outcome !== 'OPEN') {
                  cConsecSL = 0;
                  cDailyStop = true;
                }

                cSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: cTs,
                  recommendation: 'SELL',
                  reason: `${cReason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: cReason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (cSellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: cSellSignals,
                ltp: cLtp,
                lotSize: inst.lot_size,
                candles: cCandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V3 STRATEGY ============
            if (strategy === 'DAY_SELLING_V3') {
              this.logger.debug(
                `[DAY_SELLING_V3] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V3.`,
                );
                return null;
              }

              const v3IntradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!v3IntradayHistorical || v3IntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V3 (${v3IntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v3YestDayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      prevWindowFrom,
                      yesterdayTo,
                    );

              let v3YestHigh = 0;
              let v3PrevDayLow = 0;
              let v3PrevDayClose = 0;
              if (v3YestDayData && v3YestDayData.length > 0) {
                v3YestHigh = v3YestDayData[v3YestDayData.length - 1].high;
                v3PrevDayLow = v3YestDayData[v3YestDayData.length - 1].low;
                v3PrevDayClose = v3YestDayData[v3YestDayData.length - 1].close;
              }

              const v3YestIntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );

              const [v3TargetHour, v3TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v3CandlesUpToTime = v3IntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v3TargetHour ||
                    (d.getHours() === v3TargetHour &&
                      d.getMinutes() <= v3TargetMin)
                  );
                },
              );

              if (v3CandlesUpToTime.length < 1) return null;

              // EMA pre-seeding
              let v3EmaValues: (number | null)[];
              if (v3YestIntradayData && v3YestIntradayData.length >= 20) {
                const seed = v3YestIntradayData.slice(-25);
                const combined = [...seed, ...v3CandlesUpToTime];
                v3EmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v3EmaValues = this.indicators.calculateEMA(
                  v3CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // RSI pre-seeding
              let v3RsiValues: (number | null)[];
              if (v3YestIntradayData && v3YestIntradayData.length >= 14) {
                const seed = v3YestIntradayData.slice(-30);
                const combined = [...seed, ...v3CandlesUpToTime];
                v3RsiValues = this.indicators
                  .calculateRSI(
                    combined.map((c) => c.close),
                    14,
                  )
                  .slice(seed.length);
              } else {
                v3RsiValues = this.indicators.calculateRSI(
                  v3CandlesUpToTime.map((c) => c.close),
                  14,
                );
              }

              // Swing highs
              const v3SwingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < v3CandlesUpToTime.length - 5; i++) {
                const c = v3CandlesUpToTime[i];
                const prev5 = v3CandlesUpToTime.slice(i - 5, i);
                const next5 = v3CandlesUpToTime.slice(i + 1, i + 6);
                if (
                  prev5.every((p) => p.high < c.high) &&
                  next5.every((n) => n.high < c.high)
                ) {
                  v3SwingHighs.push({ price: c.high, index: i });
                }
              }

              const v3SuperTrend = this.indicators.calculateSuperTrend(
                v3CandlesUpToTime,
                10,
                2,
              );

              const v3LastCandle =
                v3CandlesUpToTime[v3CandlesUpToTime.length - 1];
              const v3Ltp = v3LastCandle.close || 0;
              const v3EodClose = v3LastCandle.close ?? 0;
              const v3LotSize = canonicalLotSize(symbol, inst.lot_size);
              const v3TotalQty = paperLots * v3LotSize;
              const v3HalfQty = Math.floor(v3TotalQty / 2);
              const v3RemainingQty = v3TotalQty - v3HalfQty;

              const v3SignalCandidates = detectDaySellSignalsV3({
                candles: v3CandlesUpToTime,
                emaValues: v3EmaValues,
                rsiValues: v3RsiValues,
                swingHighs: v3SwingHighs,
                yesterdayHigh: v3YestHigh,
                prevDayLow: v3PrevDayLow,
                prevDayClose: v3PrevDayClose,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
                superTrendData: v3SuperTrend,
              });

              const v3SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v3ActiveTradeClosed = true;
              let v3ConsecSL = 0;
              let v3DailyStop = false;

              for (const sig of v3SignalCandidates) {
                if (v3DailyStop) break;
                if (!v3ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v3Ts,
                  reason: v3Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                  candleRSI,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;
                const rsiText =
                  candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v3ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v3CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v3CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v3ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v3CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v3CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v3ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v3ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v3TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v3HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v3RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v3RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v3EodClose) * v3RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v3EodClose) * v3TotalQty;
                }

                if (outcome === 'SL') {
                  v3ConsecSL++;
                  if (v3ConsecSL >= 2) v3DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v3ConsecSL = 0;
                  v3DailyStop = true;
                }

                v3SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v3Ts,
                  recommendation: 'SELL',
                  reason: `${v3Reason} (Risk: ${risk.toFixed(1)}pts) @ ?${entryPrice.toFixed(2)}${rsiText}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v3Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v3SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v3SellSignals,
                ltp: v3Ltp,
                lotSize: inst.lot_size,
                candles: v3CandlesUpToTime,
              };
            }

            // ============ DAY_SELLING_V4 STRATEGY ============
            if (strategy === 'DAY_SELLING_V4') {
              this.logger.debug(
                `[DAY_SELLING_V4] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_SELLING_V4.`,
                );
                return null;
              }

              const v4IntradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!v4IntradayHistorical || v4IntradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for V4 (${v4IntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const v4YestIntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );

              const [v4TargetHour, v4TargetMin] = specificTime
                .split(':')
                .map(Number);
              const v4CandlesUpToTime = v4IntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < v4TargetHour ||
                    (d.getHours() === v4TargetHour &&
                      d.getMinutes() <= v4TargetMin)
                  );
                },
              );

              if (v4CandlesUpToTime.length < 1) return null;

              // 20 EMA with pre-seeding
              let v4Ema20Values: (number | null)[];
              if (v4YestIntradayData && v4YestIntradayData.length >= 20) {
                const seed = v4YestIntradayData.slice(-25);
                const combined = [...seed, ...v4CandlesUpToTime];
                v4Ema20Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                v4Ema20Values = this.indicators.calculateEMA(
                  v4CandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // 8 EMA with pre-seeding
              let v4Ema8Values: (number | null)[];
              if (v4YestIntradayData && v4YestIntradayData.length >= 8) {
                const seed = v4YestIntradayData.slice(-15);
                const combined = [...seed, ...v4CandlesUpToTime];
                v4Ema8Values = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    8,
                  )
                  .slice(seed.length);
              } else {
                v4Ema8Values = this.indicators.calculateEMA(
                  v4CandlesUpToTime.map((c) => c.close),
                  8,
                );
              }

              // VWAP (today's candles, no pre-seeding)
              const v4VwapValues = this.indicators.calculateVWAP(
                v4CandlesUpToTime.map((c) => ({
                  high: c.high,
                  low: c.low,
                  close: c.close,
                  volume: c.volume ?? 0,
                })),
              );

              const v4SuperTrend = this.indicators.calculateSuperTrend(
                v4CandlesUpToTime,
                10,
                2,
              );

              const v4LastCandle =
                v4CandlesUpToTime[v4CandlesUpToTime.length - 1];
              const v4Ltp = v4LastCandle.close || 0;
              const v4EodClose = v4LastCandle.close ?? 0;
              const v4LotSize = canonicalLotSize(symbol, inst.lot_size);
              const v4TotalQty = paperLots * v4LotSize;
              const v4HalfQty = Math.floor(v4TotalQty / 2);
              const v4RemainingQty = v4TotalQty - v4HalfQty;

              const v4SignalCandidates = detectDaySellSignalsV4({
                candles: v4CandlesUpToTime,
                ema8Values: v4Ema8Values,
                ema20Values: v4Ema20Values,
                vwapValues: v4VwapValues,
                superTrendData: v4SuperTrend,
                marginPoints,
                maxSellRiskPts,
                realtimeMode,
                instrumentName: inst.tradingsymbol,
              });

              const v4SellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
              }> = [];

              let v4ActiveTradeClosed = true;
              let v4ConsecSL = 0;
              let v4DailyStop = false;

              for (const sig of v4SignalCandidates) {
                if (v4DailyStop) break;
                if (!v4ActiveTradeClosed) continue;

                const {
                  actualCandleIndex,
                  candleTime,
                  candleDate,
                  unixTimestamp: v4Ts,
                  reason: v4Reason,
                  entryPrice,
                  stopLoss,
                  risk,
                } = sig;

                const target1 = entryPrice - risk * 2;
                const target2 = entryPrice - risk * 3;
                const target3 = entryPrice - risk * 4;

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                v4ActiveTradeClosed = false;
                let t1HitIdx = -1;

                for (
                  let j = actualCandleIndex + 1;
                  j < v4CandlesUpToTime.length;
                  j++
                ) {
                  const fc = v4CandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    v4ActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    t1HitIdx = j;
                    break;
                  }
                }

                if (t1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = t1HitIdx + 1;
                    j < v4CandlesUpToTime.length;
                    j++
                  ) {
                    const fc = v4CandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      v4ActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    v4ActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * v4TotalQty;
                } else if (t1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * v4HalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * v4RemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * v4RemainingQty;
                  } else {
                    pnl = t1Profit + (entryPrice - v4EodClose) * v4RemainingQty;
                  }
                } else {
                  pnl = (entryPrice - v4EodClose) * v4TotalQty;
                }

                if (outcome === 'SL') {
                  v4ConsecSL++;
                  if (v4ConsecSL >= 2) v4DailyStop = true;
                } else if (outcome !== 'OPEN') {
                  v4ConsecSL = 0;
                  v4DailyStop = true;
                }

                v4SellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: v4Ts,
                  recommendation: 'SELL',
                  reason: `${v4Reason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: v4Reason,
                  outcome,
                  pnl: Math.round(pnl),
                });
              }

              if (v4SellSignals.length === 0) return null;

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: v4SellSignals,
                ltp: v4Ltp,
                lotSize: inst.lot_size,
                candles: v4CandlesUpToTime,
              };
            }

            // ============ DAY_HIGH_REJECTION STRATEGY ============
            if (strategy === 'DAY_HIGH_REJECTION') {
              this.logger.debug(
                `[DAY_HIGH_REJECTION] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_HIGH_REJECTION.`,
                );
                return null;
              }

              const dhrIntradayHistorical =
                instrumentSource === 'db'
                  ? await this.getTodayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )
                  : await this.getCandlesWithCache(
                      kc,
                      inst.instrument_token,
                      interval,
                      todayFrom,
                      todayTo,
                    );

              if (!dhrIntradayHistorical || dhrIntradayHistorical.length < 2) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for DAY_HIGH_REJECTION (${dhrIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const [dhrTargetHour, dhrTargetMin] = specificTime
                .split(':')
                .map(Number);
              const dhrCandlesUpToTime = dhrIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < dhrTargetHour ||
                    (d.getHours() === dhrTargetHour &&
                      d.getMinutes() <= dhrTargetMin)
                  );
                },
              );

              if (dhrCandlesUpToTime.length < 2) return null;

              const dhrLtp =
                dhrCandlesUpToTime[dhrCandlesUpToTime.length - 1].close || 0;
              const dhrEodClose = dhrLtp;
              const dhrLotSize = canonicalLotSize(symbol, inst.lot_size);
              const dhrTotalQty = paperLots * dhrLotSize;
              const dhrHalfQty = Math.floor(dhrTotalQty / 2);
              const dhrRemainingQty = dhrTotalQty - dhrHalfQty;

              // Fetch yesterday's intraday data to compute EMA20 session gate
              const dhrYestIntraday =
                instrumentSource === 'db'
                  ? ((await this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )) ?? [])
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );
              let dhrEma20: number | undefined;
              if (dhrYestIntraday && dhrYestIntraday.length >= 20) {
                const seed = dhrYestIntraday.slice(-25);
                const combined = [...seed, ...dhrCandlesUpToTime];
                const emaAll = this.indicators.calculateEMA(
                  combined.map((c) => c.close),
                  20,
                );
                // EMA value at the last yesterday candle = seed.length - 1
                dhrEma20 = emaAll[seed.length - 1] ?? undefined;
              }

              // Fetch 1-minute candles for entry confirmation
              const dhr1mHistorical =
                interval === 'minute'
                  ? dhrIntradayHistorical // already 1m
                  : instrumentSource === 'db'
                    ? await this.getTodayCandlesFromCache(
                        inst.instrument_token,
                        todayStr,
                        'minute',
                      )
                    : await kc.getHistoricalData(
                        inst.instrument_token,
                        'minute',
                        todayFrom,
                        todayTo,
                      );
              const dhr1mCandles = (dhr1mHistorical ?? []).filter((candle) => {
                const d = new Date(candle.date);
                return (
                  d.getHours() < dhrTargetHour ||
                  (d.getHours() === dhrTargetHour &&
                    d.getMinutes() <= dhrTargetMin)
                );
              });

              const dhrSignalCandidates = detectDayHighRejectionOnly(
                dhrCandlesUpToTime,
                {
                  touchTolerance: Math.max(5, Math.round(marginPoints * 1.5)),
                  stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
                  requireNextCandleConfirmation: false,
                  useOneMinuteEntryConfirmation: true,
                  oneMinuteConfirmationWindow: 10,
                  enableTwoCandleConfirm: false,
                  enableLowBreakConfirm: false,
                  enableFiveMinuteSignalLowBreakConfirm: true,
                  ...(await this.loadDhrConfig()),
                  ema20: dhrEma20,
                  debug: false,
                },
                dhr1mCandles,
              );

              const dhrSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                qty: number;
                pnl: number;
                confidenceScore?: number;
                confidenceGrade?: ConfidenceGrade;
                confidenceBreakdown?: {
                  superTrend: boolean;
                  vwap: boolean;
                  dailyTrend: boolean;
                  vix: boolean;
                  prevDayOption: boolean;
                };
              }> = [];

              let dhrActiveTradeClosed = true;
              // Accumulates realized P&L for DHR trades within this day's scan.
              // Used to enforce the perDayLoss cap when placeQtyBasedOnSL is true.
              let dhrDayPnlAccum = 0;

              for (const sig of dhrSignalCandidates) {
                if (!dhrActiveTradeClosed) continue;

                // ── Per-day loss guard ───────────────────────────────────────
                if (placeQtyBasedOnSL && dhrDayPnlAccum <= -perDayLoss) {
                  continue;
                }

                const idx = sig.confirmIndex ?? sig.setupIndex;
                const c = dhrCandlesUpToTime[idx];
                // Use the 1m confirmation candle for time when available — gives exact entry minute
                const timeCandle =
                  sig.oneMinuteConfirmIndex != null &&
                  dhr1mCandles[sig.oneMinuteConfirmIndex]
                    ? dhr1mCandles[sig.oneMinuteConfirmIndex]
                    : c;
                const candleDate =
                  timeCandle.date instanceof Date
                    ? timeCandle.date
                    : new Date(timeCandle.date as any);
                const dhrTs = Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const target1 = sig.t1;
                const target2 = sig.t2;
                const target3 = sig.t3;

                // Scan outcome
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                dhrActiveTradeClosed = false;
                let dhrT1HitIdx = -1;

                for (let j = idx + 1; j < dhrCandlesUpToTime.length; j++) {
                  const fc = dhrCandlesUpToTime[j];
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    dhrActiveTradeClosed = true;
                    break;
                  }
                  if (fc.low <= target1) {
                    dhrT1HitIdx = j;
                    break;
                  }
                }

                if (dhrT1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = dhrT1HitIdx + 1;
                    j < dhrCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = dhrCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      dhrActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      dhrActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      dhrActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    dhrActiveTradeClosed = true;
                  }
                }

                // ── Per-signal position sizing ───────────────────────────────
                // Mirror EMA REJ: use placeQtyBasedOnSL + perTradeLoss to size
                // from risk, then cap by grade (A=10→max10lots, B=6→max5lots).
                let sigQty: number;
                if (placeQtyBasedOnSL) {
                  const riskPts = sig.stopLoss - sig.entryPrice; // SL > entry for SELL
                  const riskPerLot = riskPts * dhrLotSize;
                  if (riskPerLot <= 0) {
                    sigQty = 0;
                  } else {
                    const lotsFromRisk = Math.floor(perTradeLoss / riskPerLot);
                    // A (score=10) → max 10 lots, B (score=6) → max 5 lots
                    const maxLotsByGrade = sig.score === 10 ? 10 : 5;
                    const finalLots = Math.min(
                      lotsFromRisk,
                      maxLotsByGrade,
                      paperLots,
                    );
                    sigQty = finalLots * dhrLotSize;
                  }
                } else {
                  sigQty = paperLots * dhrLotSize;
                }
                const sigHalfQty = Math.floor(sigQty / 2);
                const sigRemainingQty = sigQty - sigHalfQty;

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * sigQty;
                } else if (dhrT1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * sigHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * sigRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * sigRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - dhrEodClose) * sigRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - dhrEodClose) * sigQty;
                }

                dhrDayPnlAccum += pnl;

                // ── NIFTY Futures trend filter (optional) ─────────────────
                if (enableNiftyTrendFilter && instrumentSource !== 'db') {
                  const trendResult = await checkNiftyFuturesTrend({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                  });
                  this.logger.log(
                    `[DHR-TREND-FILTER] ${inst.tradingsymbol} @ ${candleTime}: ${trendResult.reason}`,
                  );
                  if (!trendResult.aligned) {
                    dhrActiveTradeClosed = true; // allow next signal to be evaluated
                    continue;
                  }
                }

                // ── Confluence checker (optional, additive) ──────────────
                let dhrConfidenceScore: number | undefined;
                let dhrConfidenceGrade: ConfidenceGrade | undefined;
                let dhrConfidenceBreakdown:
                  | {
                      superTrend: boolean;
                      vwap: boolean;
                      dailyTrend: boolean;
                      vix: boolean;
                      prevDayOption: boolean;
                    }
                  | undefined;
                if (enableConfluenceChecker && instrumentSource !== 'db') {
                  const conf = await computeSignalConfidence({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                    prevDayOptionCandles: dhrYestIntraday ?? [],
                  });
                  dhrConfidenceScore = conf.score;
                  dhrConfidenceGrade = conf.grade;
                  dhrConfidenceBreakdown = conf.breakdown;
                  this.logger.log(
                    `[DHR-CONFIDENCE] ${inst.tradingsymbol} @ ${candleTime}: ${conf.reason}`,
                  );
                }

                dhrSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: dhrTs,
                  recommendation: 'SELL',
                  reason: `${sig.reason} | score=${sig.score} @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: sig.setupType,
                  outcome,
                  qty: sigQty,
                  pnl: Math.round(pnl),
                  confidenceScore: dhrConfidenceScore,
                  confidenceGrade: dhrConfidenceGrade,
                  confidenceBreakdown: dhrConfidenceBreakdown,
                });
              }

              // Always return candle data even when no SELL signals fired.
              // The post-batch step will inject complementary BUY signals from
              // the paired option (CE SELL → PE BUY, PE SELL → CE BUY) and
              // then discard entries that still have 0 signals.
              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: dhrSellSignals,
                ltp: dhrLtp,
                lotSize: inst.lot_size,
                candles: dhrCandlesUpToTime,
              };
            }

            // ============ DAY_LOW_BREAK STRATEGY ============
            if (strategy === 'DAY_LOW_BREAK') {
              this.logger.debug(
                `[DAY_LOW_BREAK] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_LOW_BREAK.`,
                );
                return null;
              }

              const dlbIntradayHistorical =
                instrumentSource === 'db'
                  ? await this.getTodayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )
                  : await this.getCandlesWithCache(
                      kc,
                      inst.instrument_token,
                      interval,
                      todayFrom,
                      todayTo,
                    );

              if (!dlbIntradayHistorical || dlbIntradayHistorical.length < 2) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for DAY_LOW_BREAK (${dlbIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const [dlbTargetHour, dlbTargetMin] = specificTime
                .split(':')
                .map(Number);
              const dlbCandlesUpToTime = dlbIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < dlbTargetHour ||
                    (d.getHours() === dlbTargetHour &&
                      d.getMinutes() <= dlbTargetMin)
                  );
                },
              );

              if (dlbCandlesUpToTime.length < 2) return null;

              const dlbLtp =
                dlbCandlesUpToTime[dlbCandlesUpToTime.length - 1].close || 0;
              const dlbEodClose = dlbLtp;
              const dlbLotSize = canonicalLotSize(symbol, inst.lot_size);

              // Fetch 1-minute candles for 1m confirmation step
              const dlb1mHistorical =
                interval === 'minute'
                  ? dlbIntradayHistorical
                  : instrumentSource === 'db'
                    ? await this.getTodayCandlesFromCache(
                        inst.instrument_token,
                        todayStr,
                        'minute',
                      )
                    : await kc.getHistoricalData(
                        inst.instrument_token,
                        'minute',
                        todayFrom,
                        todayTo,
                      );
              const dlb1mCandles = (dlb1mHistorical ?? []).filter((candle) => {
                const d = new Date(candle.date);
                return (
                  d.getHours() < dlbTargetHour ||
                  (d.getHours() === dlbTargetHour &&
                    d.getMinutes() <= dlbTargetMin)
                );
              });

              // Fetch yesterday's intraday data to compute EMA20 session gate
              const dlbYestIntraday =
                instrumentSource === 'db'
                  ? ((await this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )) ?? [])
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );
              let dlbEma20: number | undefined;
              let dlbEma20Series: (number | null)[] | undefined;
              if (dlbYestIntraday && dlbYestIntraday.length >= 20) {
                const dlbSeed = dlbYestIntraday.slice(-25);
                const dlbCombined = [...dlbSeed, ...dlbCandlesUpToTime];
                const dlbEmaAll = this.indicators.calculateEMA(
                  dlbCombined.map((c) => c.close),
                  20,
                );
                // Session-level EMA: last seed candle (used for firstOpen scoring)
                dlbEma20 = dlbEmaAll[dlbSeed.length - 1] ?? undefined;
                // Per-candle EMA: aligned to dlbCandlesUpToTime (used at signal time)
                dlbEma20Series = dlbEmaAll.slice(dlbSeed.length);
              }

              const dlbSignalCandidates = detectDayLowBreakOnly(
                dlbCandlesUpToTime,
                {
                  stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
                  min5mBreakdownBodyRatio: 0.3,
                  oneMinuteConfirmationWindow: 10,
                  minRRRatio: 1.5,
                  ema20: dlbEma20,
                  ema20Series: dlbEma20Series,
                  debug: false,
                },
                dlb1mCandles,
              );

              const dlbSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                qty: number;
                pnl: number;
                confidenceScore?: number;
                confidenceGrade?: ConfidenceGrade;
                confidenceBreakdown?: {
                  superTrend: boolean;
                  vwap: boolean;
                  dailyTrend: boolean;
                  vix: boolean;
                  prevDayOption: boolean;
                };
              }> = [];

              let dlbActiveTradeClosed = true;
              let dlbDayPnlAccum = 0;

              for (const sig of dlbSignalCandidates) {
                if (!dlbActiveTradeClosed) continue;

                // ── Per-day loss guard ────────────────────────────────────
                if (placeQtyBasedOnSL && dlbDayPnlAccum <= -perDayLoss) {
                  continue;
                }

                // Use 1m confirmation candle for entry time when available
                const c1m =
                  dlb1mCandles[sig.confirmIndex] ??
                  dlbCandlesUpToTime[sig.setupIndex];
                const candleDate =
                  c1m.date instanceof Date
                    ? c1m.date
                    : new Date(c1m.date as any);
                const dlbTs = Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const risk = stopLoss - entryPrice;
                // Use the signal's own T1/T2/T3 (1:1 / 1:2 / 1:3 RR as computed in the strategy).
                const target1 = sig.t1;
                const target2 = sig.t2;
                const target3 = sig.t3;

                // Scan outcome against future 5m candles
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                dlbActiveTradeClosed = false;
                let dlbT1HitIdx = -1;

                for (
                  let j = sig.setupIndex + 1;
                  j < dlbCandlesUpToTime.length;
                  j++
                ) {
                  const fc = dlbCandlesUpToTime[j];
                  // Check T1 before SL: on expiry-day volatile candles, the option
                  // may dip to T1 and then reverse past SL in the same 5m candle.
                  // Checking T1 first ensures that intrabar T1→BE sequences are
                  // correctly captured in phase 2 rather than being called SL.
                  if (fc.low <= target1) {
                    dlbT1HitIdx = j;
                    break;
                  }
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    dlbActiveTradeClosed = true;
                    break;
                  }
                }

                if (dlbT1HitIdx >= 0) {
                  let phase2Done = false;
                  // Phase 2 starts from the candle AFTER T1 hit.
                  // Must NOT start from the T1 candle itself: a 5m candle that
                  // opens above entry, falls to T1, then closes lower will have
                  // a high > entry — but that high occurred BEFORE T1 was hit,
                  // not as a post-T1 bounce. Starting from T1+1 prevents false BE.
                  for (
                    let j = dlbT1HitIdx + 1;
                    j < dlbCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = dlbCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      dlbActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      dlbActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      dlbActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    dlbActiveTradeClosed = true;
                  }
                }

                // ── Per-signal position sizing (mirrors DHR) ─────────────
                let sigQty: number;
                if (placeQtyBasedOnSL) {
                  const riskPts = sig.stopLoss - sig.entryPrice;
                  const riskPerLot = riskPts * dlbLotSize;
                  if (riskPerLot <= 0) {
                    sigQty = 0;
                  } else {
                    const lotsFromRisk = Math.floor(perTradeLoss / riskPerLot);
                    // A (score=10) → max 10 lots, B (score=6) → max 5 lots, B (score=4) → quarter lots
                    const maxLotsByGrade =
                      sig.score === 10
                        ? 10
                        : sig.score === 6
                          ? 5
                          : Math.max(1, Math.floor(paperLots * 0.25));
                    const finalLots = Math.min(
                      lotsFromRisk,
                      maxLotsByGrade,
                      paperLots,
                    );
                    sigQty = finalLots * dlbLotSize;
                  }
                } else {
                  sigQty = paperLots * dlbLotSize;
                }
                const sigHalfQty = Math.floor(sigQty / 2);
                const sigRemainingQty = sigQty - sigHalfQty;

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * sigQty;
                } else if (dlbT1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * sigHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * sigRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * sigRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - dlbEodClose) * sigRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - dlbEodClose) * sigQty;
                }

                dlbDayPnlAccum += pnl;

                // ── NIFTY Futures trend filter (optional) ─────────────────
                if (enableNiftyTrendFilter && instrumentSource !== 'db') {
                  const trendResult = await checkNiftyFuturesTrend({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                  });
                  this.logger.log(
                    `[DLB-TREND-FILTER] ${inst.tradingsymbol} @ ${candleTime}: ${trendResult.reason}`,
                  );
                  if (!trendResult.aligned) {
                    dlbActiveTradeClosed = true;
                    continue;
                  }
                }

                // ── Confluence checker (optional, additive) ──────────────
                let dlbConfidenceScore: number | undefined;
                let dlbConfidenceGrade: ConfidenceGrade | undefined;
                let dlbConfidenceBreakdown:
                  | {
                      superTrend: boolean;
                      vwap: boolean;
                      dailyTrend: boolean;
                      vix: boolean;
                      prevDayOption: boolean;
                    }
                  | undefined;
                if (enableConfluenceChecker && instrumentSource !== 'db') {
                  const conf = await computeSignalConfidence({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                    prevDayOptionCandles: dlbYestIntraday ?? [],
                  });
                  dlbConfidenceScore = conf.score;
                  dlbConfidenceGrade = conf.grade;
                  dlbConfidenceBreakdown = conf.breakdown;
                  this.logger.log(
                    `[DLB-CONFIDENCE] ${inst.tradingsymbol} @ ${candleTime}: ${conf.reason}`,
                  );
                }

                dlbSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: dlbTs,
                  recommendation: 'SELL',
                  reason: `${sig.reason} | score=${sig.score} @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: sig.setupType,
                  outcome,
                  qty: sigQty,
                  pnl: Math.round(pnl),
                  confidenceScore: dlbConfidenceScore,
                  confidenceGrade: dlbConfidenceGrade,
                  confidenceBreakdown: dlbConfidenceBreakdown,
                });
              }

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: dlbSellSignals,
                ltp: dlbLtp,
                lotSize: inst.lot_size,
                candles: dlbCandlesUpToTime,
              };
            }

            // ============ EMA_REJECTION STRATEGY ============
            if (strategy === 'EMA_REJECTION') {
              this.logger.debug(
                `[EMA_REJECTION] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for EMA_REJECTION.`,
                );
                return null;
              }

              const emaRejIntradayHistorical =
                instrumentSource === 'db'
                  ? await this.getTodayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )
                  : await this.getCandlesWithCache(
                      kc,
                      inst.instrument_token,
                      interval,
                      todayFrom,
                      todayTo,
                    );

              if (
                !emaRejIntradayHistorical ||
                emaRejIntradayHistorical.length < 2
              ) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for EMA_REJECTION (${emaRejIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const [emaRejTargetHour, emaRejTargetMin] = specificTime
                .split(':')
                .map(Number);
              const emaRejCandlesUpToTime = emaRejIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < emaRejTargetHour ||
                    (d.getHours() === emaRejTargetHour &&
                      d.getMinutes() <= emaRejTargetMin)
                  );
                },
              );

              if (emaRejCandlesUpToTime.length < 2) return null;

              const emaRejLtp =
                emaRejCandlesUpToTime[emaRejCandlesUpToTime.length - 1].close ||
                0;
              const emaRejEodClose = emaRejLtp;
              const emaRejLotSize = canonicalLotSize(symbol, inst.lot_size);
              // Qty is computed per-signal inside the loop (dynamic or static based on placeQtyBasedOnSL)

              // Pre-seed 20 EMA with yesterday's last 25 candles
              const emaRejYestIntraday =
                instrumentSource === 'db'
                  ? ((await this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )) ?? [])
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );
              let emaRejEmaValues: (number | null)[];
              if (emaRejYestIntraday && emaRejYestIntraday.length >= 10) {
                const seed = emaRejYestIntraday.slice(-25);
                const combined = [...seed, ...emaRejCandlesUpToTime];
                emaRejEmaValues = this.indicators
                  .calculateEMA(
                    combined.map((c) => c.close),
                    20,
                  )
                  .slice(seed.length);
              } else {
                emaRejEmaValues = this.indicators.calculateEMA(
                  emaRejCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // Fetch 1-minute candles for optional entry confirmation
              const emaRej1mHistorical =
                interval === 'minute'
                  ? emaRejIntradayHistorical
                  : instrumentSource === 'db'
                    ? await this.getTodayCandlesFromCache(
                        inst.instrument_token,
                        todayStr,
                        'minute',
                      )
                    : await kc.getHistoricalData(
                        inst.instrument_token,
                        'minute',
                        todayFrom,
                        todayTo,
                      );
              const emaRej1mCandles = (emaRej1mHistorical ?? []).filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < emaRejTargetHour ||
                    (d.getHours() === emaRejTargetHour &&
                      d.getMinutes() <= emaRejTargetMin)
                  );
                },
              );

              const emaRejSignalCandidates = detectEmaRejectionOnly(
                emaRejCandlesUpToTime,
                emaRejEmaValues,
                {
                  emaTouchBufferPts: Math.max(
                    3,
                    Math.round(marginPoints * 0.5),
                  ),
                  emaBreakTolerancePts: Math.max(5, Math.round(marginPoints)),
                  stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
                  minRiskRewardReference: 1.5,
                  oneMinuteConfirmationWindow: 10,
                  // When dynamic sizing is active, wide SL just reduces qty —
                  // don't block the signal at the strategy level.
                  maxAllowedSLReference: placeQtyBasedOnSL
                    ? Infinity
                    : maxSellRiskPts,
                  debug: false,
                  enableDiagLog: true,
                },
                emaRej1mCandles,
              );

              const emaRejSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
                exitPrice: number;
                qty: number;
                confidenceScore?: number;
                confidenceGrade?: ConfidenceGrade;
                confidenceBreakdown?: {
                  superTrend: boolean;
                  vwap: boolean;
                  dailyTrend: boolean;
                  vix: boolean;
                  prevDayOption: boolean;
                };
              }> = [];

              let emaRejActiveTradeClosed = true;
              // Accumulates realized P&L for EMA-REJ trades within this day's scan.
              // Used to enforce the perDayLoss cap when placeQtyBasedOnSL is true.
              let emaRejDayPnlAccum = 0;

              for (const sig of emaRejSignalCandidates) {
                if (!emaRejActiveTradeClosed) continue;

                // ── Per-day loss guard ───────────────────────────────────────
                if (placeQtyBasedOnSL && emaRejDayPnlAccum <= -perDayLoss) {
                  emaRejFileLog('[EMA-REJ-SKIPPED-DAY-LOSS]', {
                    symbol: inst.tradingsymbol,
                    emaRejDayPnlAccum,
                    perDayLoss,
                    setupGrade: sig.setupGrade,
                    score: sig.score,
                  });
                  continue;
                }

                // ── Per-signal position sizing ───────────────────────────────
                let emaRejTotalQty: number;
                if (placeQtyBasedOnSL) {
                  const riskPerLot = sig.riskPts * emaRejLotSize;
                  if (riskPerLot <= 0) {
                    emaRejTotalQty = 0;
                  } else {
                    const lotsFromRisk = Math.floor(perTradeLoss / riskPerLot);
                    // Cap by grade: A+ (score=10) → max 10 lots, A (score=6) → max 5, B (score=3) → max 3
                    const maxLotsByGrade =
                      sig.score === 10 ? 10 : sig.score === 6 ? 5 : 3;
                    const finalLots = Math.min(
                      lotsFromRisk,
                      maxLotsByGrade,
                      paperLots,
                    );
                    emaRejTotalQty = finalLots * emaRejLotSize;
                    emaRejFileLog('[EMA-REJ-SIZING]', {
                      symbol: inst.tradingsymbol,
                      setupGrade: sig.setupGrade,
                      score: sig.score,
                      riskPts: sig.riskPts,
                      riskPerLot,
                      lotsFromRisk,
                      maxLotsByGrade,
                      finalLots,
                      emaRejTotalQty,
                      perTradeLoss,
                    });
                  }
                } else {
                  emaRejTotalQty = paperLots * emaRejLotSize;
                }
                const emaRejHalfQty = Math.floor(emaRejTotalQty / 2);
                const emaRejRemainingQty = emaRejTotalQty - emaRejHalfQty;

                // Use 1m confirmation candle for entry time when available
                const c1m =
                  sig.confirmIndex >= 0 && emaRej1mCandles[sig.confirmIndex]
                    ? emaRej1mCandles[sig.confirmIndex]
                    : emaRejCandlesUpToTime[sig.setupIndex];
                const candleDate =
                  c1m.date instanceof Date
                    ? c1m.date
                    : new Date(c1m.date as any);
                const emaRejTs =
                  Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const target1 = sig.t1; // 1:1 RR — use strategy's own target
                const target2 = sig.t2; // 1:2 RR
                const target3 = sig.t3; // 1:3 RR

                emaRejFileLog('[EMA-REJ-ENTRY-CALC]', {
                  symbol: inst.tradingsymbol,
                  time: candleTime,
                  setupGrade: sig.setupGrade,
                  score: sig.score,
                  riskPts: sig.riskPts,
                  entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  qty: emaRejTotalQty,
                  halfQty: emaRejHalfQty,
                  remainingQty: emaRejRemainingQty,
                  placeQtyBasedOnSL,
                  ...(placeQtyBasedOnSL && {
                    perTradeLoss,
                    emaRejDayPnlAccum: Math.round(emaRejDayPnlAccum),
                  }),
                });

                // Scan outcome against future 5m candles
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                emaRejActiveTradeClosed = false;
                let emaRejT1HitIdx = -1;

                for (
                  let j = sig.setupIndex + 1;
                  j < emaRejCandlesUpToTime.length;
                  j++
                ) {
                  const fc = emaRejCandlesUpToTime[j];
                  if (fc.low <= target1) {
                    emaRejT1HitIdx = j;
                    break;
                  }
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    emaRejActiveTradeClosed = true;
                    break;
                  }
                }

                if (emaRejT1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = emaRejT1HitIdx;
                    j < emaRejCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = emaRejCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      emaRejActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      emaRejActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      emaRejActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    emaRejActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * emaRejTotalQty;
                } else if (emaRejT1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * emaRejHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl =
                      t1Profit + (entryPrice - target2) * emaRejRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl =
                      t1Profit + (entryPrice - target3) * emaRejRemainingQty;
                  } else {
                    pnl =
                      t1Profit +
                      (entryPrice - emaRejEodClose) * emaRejRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - emaRejEodClose) * emaRejTotalQty;
                }

                // Update daily P&L accumulator for per-day loss cap
                if (placeQtyBasedOnSL) {
                  emaRejDayPnlAccum += pnl;
                }

                emaRejFileLog('[EMA-REJ-TRADE-RESULT]', {
                  symbol: inst.tradingsymbol,
                  setupGrade: sig.setupGrade,
                  score: sig.score,
                  entryPrice,
                  stopLoss,
                  riskPts: sig.riskPts,
                  qty: emaRejTotalQty,
                  outcome,
                  pnl: Math.round(pnl),
                  emaRejDayPnlAccum: placeQtyBasedOnSL
                    ? Math.round(emaRejDayPnlAccum)
                    : undefined,
                });

                const exitPrice =
                  outcome === 'SL'
                    ? stopLoss
                    : outcome === 'T1'
                      ? target1
                      : outcome === 'T2'
                        ? target2
                        : outcome === 'T3'
                          ? target3
                          : outcome === 'BE'
                            ? entryPrice
                            : emaRejEodClose; // OPEN

                // ── NIFTY Futures trend filter (optional) ─────────────────
                if (enableNiftyTrendFilter && instrumentSource !== 'db') {
                  const trendResult = await checkNiftyFuturesTrend({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                  });
                  this.logger.log(
                    `[EMA-REJ-TREND-FILTER] ${inst.tradingsymbol} @ ${candleTime}: ${trendResult.reason}`,
                  );
                  if (!trendResult.aligned) {
                    emaRejActiveTradeClosed = true;
                    continue;
                  }
                }

                // ── Confluence checker (optional, additive) ──────────────
                let emaRejConfidenceScore: number | undefined;
                let emaRejConfidenceGrade: ConfidenceGrade | undefined;
                let emaRejConfidenceBreakdown:
                  | {
                      superTrend: boolean;
                      vwap: boolean;
                      dailyTrend: boolean;
                      vix: boolean;
                      prevDayOption: boolean;
                    }
                  | undefined;
                if (enableConfluenceChecker && instrumentSource !== 'db') {
                  const conf = await computeSignalConfidence({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                    prevDayOptionCandles: emaRejYestIntraday ?? [],
                  });
                  emaRejConfidenceScore = conf.score;
                  emaRejConfidenceGrade = conf.grade;
                  emaRejConfidenceBreakdown = conf.breakdown;
                  this.logger.log(
                    `[EMA-REJ-CONFIDENCE] ${inst.tradingsymbol} @ ${candleTime}: ${conf.reason}`,
                  );
                }

                emaRejSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: emaRejTs,
                  recommendation: 'SELL',
                  reason: `${sig.reason} @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: sig.setupType,
                  outcome,
                  pnl: Math.round(pnl),
                  exitPrice,
                  qty: emaRejTotalQty,
                  confidenceScore: emaRejConfidenceScore,
                  confidenceGrade: emaRejConfidenceGrade,
                  confidenceBreakdown: emaRejConfidenceBreakdown,
                });
              }

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: emaRejSellSignals,
                ltp: emaRejLtp,
                lotSize: inst.lot_size,
                candles: emaRejCandlesUpToTime,
              };
            }

            // ============ DAY_REVERSAL STRATEGY ============
            if (strategy === 'DAY_REVERSAL') {
              this.logger.debug(
                `[DAY_REVERSAL] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_REVERSAL.`,
                );
                return null;
              }

              const drIntradayHistorical =
                instrumentSource === 'db'
                  ? await this.getTodayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )
                  : await this.getCandlesWithCache(
                      kc,
                      inst.instrument_token,
                      interval,
                      todayFrom,
                      todayTo,
                    );

              if (!drIntradayHistorical || drIntradayHistorical.length < 2) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for DAY_REVERSAL (${drIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const [drTargetHour, drTargetMin] = specificTime
                .split(':')
                .map(Number);
              const drCandlesUpToTime = drIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < drTargetHour ||
                    (d.getHours() === drTargetHour &&
                      d.getMinutes() <= drTargetMin)
                  );
                },
              );

              if (drCandlesUpToTime.length < 2) return null;

              const drLtp =
                drCandlesUpToTime[drCandlesUpToTime.length - 1].close || 0;
              const drEodClose = drLtp;
              const drLotSize = canonicalLotSize(symbol, inst.lot_size);

              // Pre-seed 20 EMA from yesterday for session confidence scoring
              const drYestIntraday =
                instrumentSource === 'db'
                  ? ((await this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    )) ?? [])
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      prevWindowFrom,
                      yesterdayTo,
                    );
              let drEma20: number | undefined;
              if (drYestIntraday && drYestIntraday.length >= 10) {
                const drSeed = drYestIntraday.slice(-25);
                const drCombined = [...drSeed, ...drCandlesUpToTime];
                const drEmaAll = this.indicators.calculateEMA(
                  drCombined.map((c) => c.close),
                  20,
                );
                drEma20 = drEmaAll[drSeed.length - 1] ?? undefined;
              }

              const drSignalCandidates = detectDayReversalOnly(
                drCandlesUpToTime,
                {
                  stopLossBuffer: Math.max(3, Math.round(marginPoints / 4)),
                  minRallyPoints: Math.max(15, marginPoints),
                  minRRRatio: 0,
                  ema20: drEma20,
                  debug: false,
                },
              );

              const drSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                qty: number;
                pnl: number;
                confidenceScore?: number;
                confidenceGrade?: ConfidenceGrade;
                confidenceBreakdown?: {
                  superTrend: boolean;
                  vwap: boolean;
                  dailyTrend: boolean;
                  vix: boolean;
                  prevDayOption: boolean;
                };
              }> = [];

              let drActiveTradeClosed = true;
              let drDayPnlAccum = 0;

              for (const sig of drSignalCandidates) {
                if (!drActiveTradeClosed) continue;

                // ── Per-day loss guard ────────────────────────────────────
                if (placeQtyBasedOnSL && drDayPnlAccum <= -perDayLoss) {
                  continue;
                }

                // ── Per-signal position sizing ────────────────────────────
                let drTotalQty: number;
                if (placeQtyBasedOnSL) {
                  const drRiskPts = sig.stopLoss - sig.entryPrice;
                  const riskPerLot = drRiskPts * drLotSize;
                  if (riskPerLot <= 0) {
                    drTotalQty = 0;
                  } else {
                    const lotsFromRisk = Math.floor(perTradeLoss / riskPerLot);
                    const maxLotsByGrade = sig.score === 10 ? 10 : 5;
                    const finalLots = Math.min(
                      lotsFromRisk,
                      maxLotsByGrade,
                      paperLots,
                    );
                    drTotalQty = finalLots * drLotSize;
                  }
                } else {
                  drTotalQty = paperLots * drLotSize;
                }

                if (drTotalQty <= 0) continue;

                const drHalfQty = Math.floor(drTotalQty / 2);
                const drRemainingQty = drTotalQty - drHalfQty;

                const c = drCandlesUpToTime[sig.setupIndex];
                const candleDate =
                  c.date instanceof Date ? c.date : new Date(c.date as any);
                const drTs = Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const risk = stopLoss - entryPrice;
                const target1 = sig.t1;
                const target2 = sig.t2;
                const target3 = sig.t3;

                // Scan outcome against future 5m candles
                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                drActiveTradeClosed = false;
                let drT1HitIdx = -1;

                for (
                  let j = sig.setupIndex + 1;
                  j < drCandlesUpToTime.length;
                  j++
                ) {
                  const fc = drCandlesUpToTime[j];
                  if (fc.low <= target1) {
                    drT1HitIdx = j;
                    break;
                  }
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    drActiveTradeClosed = true;
                    break;
                  }
                }

                if (drT1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = drT1HitIdx + 1;
                    j < drCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = drCandlesUpToTime[j];
                    if (fc.high >= stopLoss) {
                      outcome = 'BE';
                      drActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target2) {
                      outcome = 'T2';
                      drActiveTradeClosed = true;
                      phase2Done = true;
                      for (let k = j + 1; k < drCandlesUpToTime.length; k++) {
                        const fc3 = drCandlesUpToTime[k];
                        if (fc3.low <= target3) {
                          outcome = 'T3';
                          break;
                        }
                        if (fc3.high >= entryPrice) break;
                      }
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    drActiveTradeClosed = true;
                  }
                }

                // ── P&L calculation ───────────────────────────────────────
                let pnl = 0;
                if (outcome === 'SL') {
                  pnl = -(risk * drTotalQty);
                } else if (outcome === 'BE') {
                  pnl = (entryPrice - target1) * drHalfQty;
                } else if (outcome === 'T1') {
                  pnl =
                    (entryPrice - target1) * drHalfQty +
                    (entryPrice - drEodClose) * drRemainingQty;
                } else if (outcome === 'T2') {
                  const t1Profit = (entryPrice - target1) * drHalfQty;
                  pnl = t1Profit + (entryPrice - target2) * drRemainingQty;
                } else if (outcome === 'T3') {
                  const t1Profit = (entryPrice - target1) * drHalfQty;
                  pnl = t1Profit + (entryPrice - target3) * drRemainingQty;
                } else {
                  pnl = (entryPrice - drEodClose) * drTotalQty;
                }

                if (placeQtyBasedOnSL) {
                  drDayPnlAccum += pnl;
                }

                drSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: drTs,
                  recommendation: 'SELL',
                  reason: `${sig.reason} @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: sig.setupType,
                  outcome,
                  qty: drTotalQty,
                  pnl: Math.round(pnl),
                });
              }

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: drSellSignals,
                ltp: drLtp,
                lotSize: inst.lot_size,
                candles: drCandlesUpToTime,
              };
            }

            // ============ SUPER_POWER_PACK STRATEGY ============
            if (strategy === 'SUPER_POWER_PACK') {
              this.logger.debug(
                `[SUPER_POWER_PACK] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for SUPER_POWER_PACK.`,
                );
                return null;
              }

              // ── Fetch all required candle data in parallel ──────────────────
              // 3 sequential Kite API calls → 1 parallel round-trip, cutting
              // live-mode data fetch time by ~2/3 (key for signal latency).
              // Yesterday EMA seed: try EOD cache (saved at 3:30 PM) first so
              // the live Kite call is only needed on the very first run of the day.
              const spppYestFetch: Promise<any[]> =
                instrumentSource === 'db'
                  ? this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    ).then((r) => r ?? [])
                  : this.getPrevDayCandlesFromCache(
                      inst.instrument_token,
                      todayStr,
                      interval,
                    ).then((cached) =>
                      cached && cached.length >= 10
                        ? cached
                        : kc.getHistoricalData(
                            inst.instrument_token,
                            interval,
                            prevWindowFrom,
                            yesterdayTo,
                          ),
                    );

              const sppp1mFetch: Promise<any[]> =
                interval === 'minute'
                  ? Promise.resolve([]) // reused from spppIntradayHistorical below
                  : instrumentSource === 'db'
                    ? this.getTodayCandlesFromCache(
                        inst.instrument_token,
                        todayStr,
                        'minute',
                      )
                    : kc.getHistoricalData(
                        inst.instrument_token,
                        'minute',
                        todayFrom,
                        todayTo,
                      );

              const [spppIntradayHistorical, spppYestIntraday, sppp1mRaw] =
                await Promise.all([
                  instrumentSource === 'db'
                    ? this.getTodayCandlesFromCache(
                        inst.instrument_token,
                        todayStr,
                        interval,
                      )
                    : this.getCandlesWithCache(
                        kc,
                        inst.instrument_token,
                        interval,
                        todayFrom,
                        todayTo,
                      ),
                  spppYestFetch,
                  sppp1mFetch,
                ]);

              if (
                !spppIntradayHistorical ||
                spppIntradayHistorical.length < 2
              ) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles for SUPER_POWER_PACK (${spppIntradayHistorical?.length || 0})`,
                );
                return null;
              }

              const [spppTargetHour, spppTargetMin] = specificTime
                .split(':')
                .map(Number);
              const spppCandlesUpToTime = spppIntradayHistorical.filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < spppTargetHour ||
                    (d.getHours() === spppTargetHour &&
                      d.getMinutes() <= spppTargetMin)
                  );
                },
              );

              if (spppCandlesUpToTime.length < 2) return null;

              const spppLtp =
                spppCandlesUpToTime[spppCandlesUpToTime.length - 1].close || 0;
              const spppEodClose = spppLtp;
              const spppLotSize = canonicalLotSize(symbol, inst.lot_size);

              // Build EMA series from yesterday seed
              let spppEma20: number | undefined;
              let spppEmaValues: (number | null)[];
              if (spppYestIntraday && spppYestIntraday.length >= 10) {
                const seed = spppYestIntraday.slice(-25);
                const combined = [...seed, ...spppCandlesUpToTime];
                const emaAll = this.indicators.calculateEMA(
                  combined.map((c) => c.close),
                  20,
                );
                spppEma20 = emaAll[seed.length - 1] ?? undefined;
                spppEmaValues = emaAll.slice(seed.length);
              } else {
                spppEmaValues = this.indicators.calculateEMA(
                  spppCandlesUpToTime.map((c) => c.close),
                  20,
                );
              }

              // For 1m candles: reuse 5m data when interval is already 'minute';
              // otherwise use the parallel-fetched 1m raw data.
              const sppp1mHistorical =
                interval === 'minute' ? spppIntradayHistorical : sppp1mRaw;
              const sppp1mCandles = (sppp1mHistorical ?? []).filter(
                (candle) => {
                  const d = new Date(candle.date);
                  return (
                    d.getHours() < spppTargetHour ||
                    (d.getHours() === spppTargetHour &&
                      d.getMinutes() <= spppTargetMin)
                  );
                },
              );

              const spppSignalCandidates = detectSuperPowerPackSignals({
                candles: spppCandlesUpToTime,
                candles1m: sppp1mCandles,
                ema20: spppEma20,
                ema20Series: spppEmaValues,
                marginPoints,
                dlbConfig: { maxEmaDistancePts: Infinity },
                emaRejConfig: {
                  maxAllowedSLReference: placeQtyBasedOnSL
                    ? Infinity
                    : maxSellRiskPts,
                },
              });

              const spppSellSignals: Array<{
                time: string;
                date: Date;
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
                patternName: string;
                outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN';
                pnl: number;
                exitPrice: number;
                qty: number;
                score: number;
                source: string;
                confidenceScore?: number;
                confidenceGrade?: ConfidenceGrade;
                confidenceBreakdown?: {
                  superTrend: boolean;
                  vwap: boolean;
                  dailyTrend: boolean;
                  vix: boolean;
                  prevDayOption: boolean;
                };
              }> = [];

              let spppActiveTradeClosed = true;
              let spppDayPnlAccum = 0;

              for (const sig of spppSignalCandidates) {
                if (!spppActiveTradeClosed) continue;

                if (placeQtyBasedOnSL && spppDayPnlAccum <= -perDayLoss) {
                  continue;
                }

                // ── Per-signal position sizing (mirrors EMA_REJECTION) ──────
                let spppTotalQty: number;
                if (placeQtyBasedOnSL) {
                  const riskPts = Math.abs(sig.stopLoss - sig.entryPrice);
                  const riskPerLot = riskPts * spppLotSize;
                  if (riskPerLot <= 0) {
                    spppTotalQty = 0;
                  } else {
                    const lotsFromRisk = Math.floor(perTradeLoss / riskPerLot);
                    // A+ (score=10)→max 10, A (score=6)→max 5, B (score≤4)→max 3
                    const maxLotsByGrade =
                      sig.score === 10 ? 10 : sig.score >= 6 ? 5 : 3;
                    const finalLots = Math.min(
                      lotsFromRisk,
                      maxLotsByGrade,
                      paperLots,
                    );
                    spppTotalQty = finalLots * spppLotSize;
                  }
                } else {
                  spppTotalQty = paperLots * spppLotSize;
                }
                const spppHalfQty = Math.floor(spppTotalQty / 2);
                const spppRemainingQty = spppTotalQty - spppHalfQty;

                // Choose entry-time candle by source
                const spppTimeCandle =
                  sig.source === 'DHR'
                    ? sig.oneMinuteConfirmIndex != null &&
                      sppp1mCandles[sig.oneMinuteConfirmIndex]
                      ? sppp1mCandles[sig.oneMinuteConfirmIndex]
                      : spppCandlesUpToTime[sig.confirmIndex ?? sig.setupIndex]
                    : sig.source === 'DAY_REVERSAL'
                      ? spppCandlesUpToTime[sig.setupIndex]
                      : (sig as { confirmIndex?: number; setupIndex: number })
                            .confirmIndex != null &&
                          (sig as { confirmIndex?: number; setupIndex: number })
                            .confirmIndex! >= 0 &&
                          sppp1mCandles[
                            (
                              sig as {
                                confirmIndex?: number;
                                setupIndex: number;
                              }
                            ).confirmIndex!
                          ]
                        ? sppp1mCandles[
                            (
                              sig as {
                                confirmIndex?: number;
                                setupIndex: number;
                              }
                            ).confirmIndex!
                          ]
                        : spppCandlesUpToTime[sig.setupIndex];

                const candleDate =
                  spppTimeCandle.date instanceof Date
                    ? spppTimeCandle.date
                    : new Date(spppTimeCandle.date as any);
                const spppTs = Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });

                const entryPrice = sig.entryPrice;
                const stopLoss = sig.stopLoss;
                const target1 = sig.t1;
                const target2 = sig.t2;
                const target3 = sig.t3;

                let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
                spppActiveTradeClosed = false;
                let spppT1HitIdx = -1;

                for (
                  let j = sig.setupIndex + 1;
                  j < spppCandlesUpToTime.length;
                  j++
                ) {
                  const fc = spppCandlesUpToTime[j];
                  if (fc.low <= target1) {
                    spppT1HitIdx = j;
                    break;
                  }
                  if (fc.high >= stopLoss) {
                    outcome = 'SL';
                    spppActiveTradeClosed = true;
                    break;
                  }
                }

                if (spppT1HitIdx >= 0) {
                  let phase2Done = false;
                  for (
                    let j = spppT1HitIdx + 1;
                    j < spppCandlesUpToTime.length;
                    j++
                  ) {
                    const fc = spppCandlesUpToTime[j];
                    if (fc.high >= entryPrice) {
                      outcome = 'BE';
                      spppActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                    if (fc.low <= target3) {
                      outcome = 'T3';
                      spppActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    } else if (fc.low <= target2) {
                      outcome = 'T2';
                      spppActiveTradeClosed = true;
                      phase2Done = true;
                      break;
                    }
                  }
                  if (!phase2Done) {
                    outcome = 'T1';
                    spppActiveTradeClosed = true;
                  }
                }

                let pnl: number;
                if (outcome === 'SL') {
                  pnl = (entryPrice - stopLoss) * spppTotalQty;
                } else if (spppT1HitIdx >= 0) {
                  const t1Profit = (entryPrice - target1) * spppHalfQty;
                  if (outcome === 'BE') {
                    pnl = t1Profit;
                  } else if (outcome === 'T2') {
                    pnl = t1Profit + (entryPrice - target2) * spppRemainingQty;
                  } else if (outcome === 'T3') {
                    pnl = t1Profit + (entryPrice - target3) * spppRemainingQty;
                  } else {
                    pnl =
                      t1Profit + (entryPrice - spppEodClose) * spppRemainingQty;
                  }
                } else {
                  pnl = (entryPrice - spppEodClose) * spppTotalQty;
                }

                spppDayPnlAccum += pnl;

                const exitPrice =
                  outcome === 'SL'
                    ? stopLoss
                    : outcome === 'T1'
                      ? target1
                      : outcome === 'T2'
                        ? target2
                        : outcome === 'T3'
                          ? target3
                          : outcome === 'BE'
                            ? entryPrice
                            : spppEodClose;

                // ── NIFTY Futures trend filter (optional) ─────────────────
                if (enableNiftyTrendFilter && instrumentSource !== 'db') {
                  const trendResult = await checkNiftyFuturesTrend({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                  });
                  this.logger.log(
                    `[SPPP-TREND-FILTER] ${inst.tradingsymbol} @ ${candleTime} [${sig.source}]: ${trendResult.reason}`,
                  );
                  if (!trendResult.aligned) {
                    spppActiveTradeClosed = true;
                    continue;
                  }
                }

                // ── Confluence checker (optional, additive) ──────────────
                let spppConfidenceScore: number | undefined;
                let spppConfidenceGrade: ConfidenceGrade | undefined;
                let spppConfidenceBreakdown:
                  | {
                      superTrend: boolean;
                      vwap: boolean;
                      dailyTrend: boolean;
                      vix: boolean;
                      prevDayOption: boolean;
                    }
                  | undefined;
                if (enableConfluenceChecker && instrumentSource !== 'db') {
                  const conf = await computeSignalConfidence({
                    kc,
                    prisma: this.prisma,
                    symbol: inst.name ?? 'NIFTY',
                    date: todayStr,
                    signalTimestampMs: candleDate.getTime(),
                    optionType: inst.instrument_type as 'CE' | 'PE',
                    prevDayOptionCandles: spppYestIntraday ?? [],
                  });
                  spppConfidenceScore = conf.score;
                  spppConfidenceGrade = conf.grade;
                  spppConfidenceBreakdown = conf.breakdown;
                  this.logger.log(
                    `[SPPP-CONFIDENCE] ${inst.tradingsymbol} @ ${candleTime} [${sig.source}]: ${conf.reason}`,
                  );
                }

                spppSellSignals.push({
                  time: candleTime,
                  date: candleDate,
                  timestamp: spppTs,
                  recommendation: 'SELL',
                  reason: `[${sig.source}] ${sig.reason} | score=${sig.score} @ ₹${entryPrice.toFixed(2)}`,
                  price: entryPrice,
                  stopLoss,
                  target1,
                  target2,
                  target3,
                  patternName: `SPPP_${sig.source}_${sig.setupType}`,
                  outcome,
                  pnl: Math.round(pnl),
                  exitPrice,
                  qty: spppTotalQty,
                  score: sig.score,
                  source: sig.source,
                  confidenceScore: spppConfidenceScore,
                  confidenceGrade: spppConfidenceGrade,
                  confidenceBreakdown: spppConfidenceBreakdown,
                });
              }

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: spppSellSignals,
                ltp: spppLtp,
                lotSize: inst.lot_size,
                candles: spppCandlesUpToTime,
              };
            }

            // ============ DAY_BUYING STRATEGY ============
            // Look for BUY signals using bullish patterns:
            // - RED candle closes below EMA → GREEN candle closes above EMA (recovery)
            // - Bounce at support (EMA/yesterday low/swing lows)
            // - Bullish patterns: Hammer, Bullish Engulfing, Strong Bounce
            // - Only RSI filter applied (no candle low restrictions)
            if (strategy === 'DAY_BUYING') {
              this.logger.debug(
                `[DAY_BUYING] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for DAY_BUYING. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles (cache-first)
              const intradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              this.logger.debug(
                `[DAY_BUYING] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 20`,
                );
                return null;
              }

              // Fetch yesterday's day data for low level
              const yesterdayDayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      yesterdayFrom,
                      yesterdayTo,
                    );

              let yesterdayLow = 0;
              if (yesterdayDayData && yesterdayDayData.length > 0) {
                yesterdayLow = yesterdayDayData[0].low;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday low = ${yesterdayLow.toFixed(2)}`,
                );
              }

              // Fetch yesterday's intraday data for EMA pre-seeding
              const yesterdayIntradayData =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      interval,
                      yesterdayFrom,
                      yesterdayTo,
                    );

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((c: any) => {
                const candleDate = new Date(c.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 1) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA with pre-seeding
              let emaValues: (number | null)[];
              if (yesterdayIntradayData && yesterdayIntradayData.length >= 20) {
                const yesterdayLast25 = yesterdayIntradayData.slice(-25);
                const combinedCandles = [
                  ...yesterdayLast25,
                  ...intradayHistorical,
                ];
                const combinedClosePrices = combinedCandles.map(
                  (c: any) => c.close,
                );
                const combinedEMA = this.indicators.calculateEMA(
                  combinedClosePrices,
                  20,
                );
                emaValues = combinedEMA.slice(yesterdayLast25.length);
                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded EMA with ${yesterdayLast25.length} candles from yesterday`,
                );
              } else {
                const closePrices = intradayHistorical.map((c) => c.close);
                emaValues = this.indicators.calculateEMA(closePrices, 20);
              }

              // Calculate RSI (for display in signal reason)
              // Pre-seed RSI with yesterday's data for better accuracy
              let rsiValues: (number | null)[];

              if (yesterdayIntradayData && yesterdayIntradayData.length >= 14) {
                // Pre-seed RSI: Combine yesterday's candles + today's candles
                const yesterdayForRSI = yesterdayIntradayData.slice(-30); // Use more data for RSI smoothing
                const combinedCandles = [
                  ...yesterdayForRSI,
                  ...candlesUpToTime,
                ];
                const combinedClosePrices = combinedCandles.map(
                  (c: any) => c.close,
                );

                // Calculate RSI on combined data
                const combinedRSI = this.indicators.calculateRSI(
                  combinedClosePrices,
                  14,
                );

                // Extract only today's RSI values (skip yesterday's candles)
                rsiValues = combinedRSI.slice(yesterdayForRSI.length);

                this.logger.debug(
                  `${inst.tradingsymbol}: Pre-seeded RSI with ${yesterdayForRSI.length} candles from yesterday. RSI available from first candle.`,
                );
              } else {
                // Fallback: Standard RSI calculation if no yesterday data
                this.logger.debug(
                  `${inst.tradingsymbol}: No sufficient yesterday data for RSI pre-seeding, using standard calculation`,
                );
                const closePrices = candlesUpToTime.map((c: any) => c.close);
                rsiValues = this.indicators.calculateRSI(closePrices, 14);
              }

              // First candle low (9:15 AM) - entry must be ABOVE this
              const firstCandleLow =
                intradayHistorical.length > 0 ? intradayHistorical[0].low : 0;
              if (firstCandleLow > 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: First candle low (9:15 AM) = ${firstCandleLow.toFixed(2)} (BUY signals must be ABOVE this)`,
                );
              }

              const buySignals: any[] = [];

              this.logger.debug(
                `${inst.tradingsymbol}: Processing ${candlesUpToTime.length} candles up to ${specificTime}`,
              );

              // MAIN SIGNAL DETECTION LOOP
              for (let i = 3; i < candlesUpToTime.length; i++) {
                const candle = candlesUpToTime[i];
                const candleIST = new Date(candle.date);
                const candleHours = candleIST.getHours();
                const candleMinutes = candleIST.getMinutes();

                // Time filter: 9:30 AM - 2:30 PM
                if (
                  candleHours < 9 ||
                  (candleHours === 9 && candleMinutes < 30)
                ) {
                  continue;
                }
                if (
                  candleHours > 14 ||
                  (candleHours === 14 && candleMinutes >= 30)
                ) {
                  break;
                }

                const candleDate = new Date(candle.date);
                const candleTimestamp =
                  Math.floor(candleDate.getTime() / 1000) + 19800; // Unix timestamp in seconds + IST offset (to match chartData format)
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                const candleEMA = emaValues[i] ?? 0;
                const candleLow = candle.low;
                const candleClose = candle.close;

                // Get previous candles
                const prev3 = i >= 3 ? candlesUpToTime[i - 3] : null;
                const prev2 = i >= 2 ? candlesUpToTime[i - 2] : null;
                const prev1 = i >= 1 ? candlesUpToTime[i - 1] : null;

                // Entry candle analysis
                const actualEntryCandle = candle;
                const actualCandleOpen = actualEntryCandle.open;
                const actualCandleClose = actualEntryCandle.close;
                const actualCandleHigh = actualEntryCandle.high;
                const actualCandleLow = actualEntryCandle.low;
                const actualCandleBody = Math.abs(
                  actualCandleClose - actualCandleOpen,
                );
                const actualTotalRange = actualCandleHigh - actualCandleLow;
                const actualUpperWick =
                  actualCandleHigh -
                  Math.max(actualCandleOpen, actualCandleClose);
                const actualLowerWick =
                  Math.min(actualCandleOpen, actualCandleClose) -
                  actualCandleLow;

                // GREEN candle check
                const actualIsGreenCandle =
                  actualCandleClose > actualCandleOpen;

                let entryPrice = actualCandleClose;
                let signalDetected = false;
                let signalReason = '';

                // EMA trend filter for BUY signals
                const trendMarginPoints = 35;
                const isAboveEMA = candleClose > candleEMA;
                const isFarBelowEMA =
                  candleClose < candleEMA - trendMarginPoints;

                if (!isAboveEMA && !isFarBelowEMA && candleEMA > 0) {
                  continue; // Skip if price is flat near EMA
                }

                // Support level detection
                const marginPoints = 5;
                const nearEMA =
                  Math.abs(candleLow - candleEMA) <= marginPoints &&
                  candleEMA > 0;
                const nearYesterdayLow =
                  Math.abs(candleLow - yesterdayLow) <= marginPoints &&
                  yesterdayLow > 0;

                // Find swing lows
                const swingLows: { price: number }[] = [];
                for (let j = Math.max(0, i - 20); j < i; j++) {
                  const c = candlesUpToTime[j];
                  const before = j > 0 ? candlesUpToTime[j - 1] : null;
                  const after = j < i - 1 ? candlesUpToTime[j + 1] : null;

                  if (
                    before &&
                    after &&
                    c.low < before.low &&
                    c.low < after.low
                  ) {
                    swingLows.push({ price: c.low });
                  }
                }

                const nearSwingLow = swingLows.some(
                  (s) => Math.abs(candleLow - s.price) <= marginPoints,
                );

                // Count support tests
                let supportTests = 0;
                const supportLevel = nearEMA
                  ? candleEMA
                  : nearYesterdayLow
                    ? yesterdayLow
                    : nearSwingLow
                      ? swingLows.find(
                          (s) => Math.abs(candleLow - s.price) <= marginPoints,
                        )?.price
                      : candleEMA;

                if (supportLevel) {
                  [prev3, prev2, prev1, actualEntryCandle].forEach((c) => {
                    if (
                      c &&
                      Math.abs(c.low - supportLevel) <= marginPoints * 1.5
                    ) {
                      supportTests++;
                    }
                  });
                }

                // Get RSI value for this candle
                const candleRSI = rsiValues[i];

                // Two separate buy signal scenarios:

                // Scenario 1: Oversold Green Candle (any green candle when RSI < 40)
                if (
                  actualIsGreenCandle &&
                  candleRSI != null &&
                  candleRSI < 40
                ) {
                  signalDetected = true;
                  signalReason = `Oversold Green Candle (RSI ${candleRSI.toFixed(1)})`;
                  this.logger.debug(
                    `${inst.tradingsymbol}: 🟢 Scenario 1 - Oversold green candle at ${candleTime} | RSI: ${candleRSI.toFixed(1)} < 40`,
                  );
                }

                // Scenario 2: EMA Crossover (opens below EMA, closes above EMA, RSI < 60)
                else if (
                  actualCandleOpen < candleEMA &&
                  actualCandleClose > candleEMA &&
                  candleEMA > 0 &&
                  candleRSI != null &&
                  candleRSI < 60
                ) {
                  signalDetected = true;
                  signalReason = `EMA Crossover (RSI ${candleRSI.toFixed(1)})`;
                  this.logger.debug(
                    `${inst.tradingsymbol}: 🔄 Scenario 2 - EMA crossover at ${candleTime} | Open: ${actualCandleOpen.toFixed(2)} < EMA: ${candleEMA.toFixed(2)} < Close: ${actualCandleClose.toFixed(2)} | RSI: ${candleRSI.toFixed(1)} < 60`,
                  );
                }

                if (signalDetected) {
                  entryPrice = actualCandleClose;

                  this.logger.debug(
                    `${inst.tradingsymbol}: ✅ BUY SIGNAL: ${signalReason} at ${candleTime}`,
                  );

                  // Risk management
                  const stopLoss = actualCandleLow - 7;
                  const risk = entryPrice - stopLoss;
                  const target = entryPrice + risk * 2;

                  // Add RSI to signal reason for display
                  const rsiText =
                    candleRSI != null ? `, RSI ${candleRSI.toFixed(1)}` : '';

                  this.logger.log(
                    `${inst.tradingsymbol}: ${candleTime} BUY SIGNAL (${signalReason}) | RSI: ${candleRSI != null ? candleRSI.toFixed(1) : 'N/A'} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | Target: ${target.toFixed(2)} | Risk: ${risk.toFixed(1)} pts`,
                  );

                  buySignals.push({
                    time: candleTime,
                    date: candleDate, // Full Date object from candle
                    timestamp: candleTimestamp, // Unix timestamp for matching
                    recommendation: 'BUY',
                    reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts) @ ₹${entryPrice.toFixed(2)}${rsiText}`,
                    price: entryPrice,
                    stopLoss,
                    target,
                  });

                  break; // One signal per instrument
                }
              }

              // Get current LTP
              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${buySignals.length} BUY signal(s), LTP: ${ltp.toFixed(2)}`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: buySignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime,
              };
            }

            // ============ SMART_SELL STRATEGY (ADVANCED DAY_SELLING)  ============
            // Improvements over DAY_SELLING:
            // 1. RSI Filter: Only sell when RSI > 60 (overbought)
            // 2. Time Filter: Only trade 10:30 AM - 2:30 PM
            // 3. Volume Confirmation: Rejection candle must have volume > average
            // 4. Multiple Confirmations: Need at least 2 pattern confirmations
            if (strategy === 'SMART_SELL') {
              this.logger.debug(
                `[SMART_SELL] Fetching data for ${inst.tradingsymbol}`,
              );

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot use day interval for SMART_SELL. Use intraday intervals.`,
                );
                return null;
              }

              // Fetch today's intraday candles (cache-first)
              const intradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              this.logger.debug(
                `[SMART_SELL] ${inst.tradingsymbol}: Fetched ${intradayHistorical?.length || 0} candles from ${todayFrom} to ${todayTo}`,
              );

              if (!intradayHistorical || intradayHistorical.length < 30) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}), need at least 30 for RSI`,
                );
                return null;
              }

              // Fetch yesterday's data for high level
              const yesterdayHistorical =
                instrumentSource === 'db'
                  ? []
                  : await kc.getHistoricalData(
                      inst.instrument_token,
                      'day',
                      yesterdayFrom,
                      yesterdayTo,
                    );

              let yesterdayHigh = 0;
              if (yesterdayHistorical && yesterdayHistorical.length > 0) {
                yesterdayHigh = yesterdayHistorical[0].high;
                this.logger.debug(
                  `${inst.tradingsymbol}: Yesterday high = ${yesterdayHigh}`,
                );
              }

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              if (candlesUpToTime.length < 30) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime}`,
                );
                return null;
              }

              // Calculate 20 EMA
              const closePrices = candlesUpToTime.map((c) => c.close);
              const emaValues = this.indicators.calculateEMA(closePrices, 20);

              // Calculate RSI (14 period)
              const rsiValues = this.indicators.calculateRSI(closePrices, 14);

              // Calculate average volume for comparison
              const volumes = candlesUpToTime.map((c) => c.volume || 0);
              const avgVolume5 = (totalVol: number, idx: number) => {
                if (idx < 5) return totalVol / (idx + 1);
                let sum = 0;
                for (let j = idx - 4; j <= idx; j++) {
                  sum += volumes[j];
                }
                return sum / 5;
              };

              // Find swing highs (local peaks in the session)
              const swingHighs: Array<{ price: number; index: number }> = [];
              for (let i = 5; i < candlesUpToTime.length - 5; i++) {
                const candle = candlesUpToTime[i];
                const prevCandles = candlesUpToTime.slice(i - 5, i);
                const nextCandles = candlesUpToTime.slice(i + 1, i + 6);

                const isLocalHigh =
                  prevCandles.every((c) => c.high < candle.high) &&
                  nextCandles.every((c) => c.high < candle.high);

                if (isLocalHigh) {
                  swingHighs.push({ price: candle.high, index: i });
                }
              }

              this.logger.debug(
                `${inst.tradingsymbol}: Found ${swingHighs.length} swing highs`,
              );

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const ltp = lastCandle.close || 0;

              // Check ALL candles for SELL signals (with advanced filters)
              const sellSignals: Array<{
                time: string;
                date: Date; // Full Date object from candle
                timestamp: number;
                recommendation: 'SELL';
                reason: string;
                price: number;
                stopLoss: number;
                target1: number;
                target2: number;
                target3: number;
              }> = [];

              let lastSignalSL = 0;
              let activeTradeClosed = true; // Track if previous trade has closed

              const smartSellStartIndex = realtimeMode
                ? Math.max(29, candlesUpToTime.length - 2)
                : 29;

              for (
                let i = smartSellStartIndex;
                i < candlesUpToTime.length;
                i++
              ) {
                // === ONE TRADE AT A TIME: Skip if previous trade is still active ===
                if (!activeTradeClosed) {
                  continue; // Previous trade hasn't closed yet, don't generate new signals
                }

                const candle = candlesUpToTime[i];
                const candleEMA = emaValues[i];
                const candleRSI = rsiValues[i];
                if (!candleEMA || !candleRSI) continue;

                const candleHigh = candle.high;
                const candleLow = candle.low;
                const candleOpen = candle.open;
                const candleClose = candle.close;
                const candleBody = Math.abs(candleClose - candleOpen);
                const upperWick =
                  candleHigh - Math.max(candleOpen, candleClose);
                const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
                const totalRange = candleHigh - candleLow;
                const isRedCandle = candleClose < candleOpen;
                const isGreenCandle = candleClose > candleOpen;
                const candleVolume = candle.volume || 0;

                const candleDate = new Date(candle.date);
                const candleTimestamp =
                  Math.floor(candleDate.getTime() / 1000) + 19800;
                const candleTime = candleDate.toLocaleTimeString('en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: true,
                });
                const candleHour = candleDate.getHours();
                const candleMinute = candleDate.getMinutes();

                // ===== FILTER 1: TIME OF DAY =====
                // Only trade between 10:30 AM - 2:30 PM
                if (
                  candleHour < 10 ||
                  (candleHour === 10 && candleMinute < 30)
                ) {
                  continue; // Before 10:30 AM
                }
                if (
                  candleHour > 14 ||
                  (candleHour === 14 && candleMinute > 30)
                ) {
                  continue; // After 2:30 PM
                }

                // ===== FILTER 2: RSI OVERBOUGHT =====
                // Only sell when RSI > 60 (overbought zone)
                if (candleRSI <= 60) {
                  continue;
                }

                // Skip if price hasn't moved above last signal's SL.
                // Only enforced in realtimeMode — same reasoning as DAY_SELLING.
                if (
                  realtimeMode &&
                  lastSignalSL > 0 &&
                  candleHigh < lastSignalSL
                ) {
                  continue;
                }

                let signalDetected = false;
                let signalReason = '';
                let entryPrice = candleClose;
                let confirmations = 0;
                const patterns: string[] = [];

                // Check if near a resistance level
                const nearEMA =
                  Math.abs(candleHigh - candleEMA) <= marginPoints;
                const nearYesterdayHigh =
                  yesterdayHigh > 0 &&
                  Math.abs(candleHigh - yesterdayHigh) <= marginPoints;

                let nearSwingHigh = false;
                for (const swing of swingHighs) {
                  if (
                    swing.index < i - 3 &&
                    Math.abs(candleHigh - swing.price) <= marginPoints
                  ) {
                    nearSwingHigh = true;
                    break;
                  }
                }

                // Only proceed if near a resistance level
                if (!nearEMA && !nearYesterdayHigh && !nearSwingHigh) {
                  continue;
                }

                // ===== REJECTION CANDLE VALIDATION =====
                // The rejection candle MUST be:
                // 1. RED candle (close < open), OR
                // 2. DOJI (small body) + NEXT candle is RED

                // Check if current candle is DOJI (body < 10% of total range)
                const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;

                // Get next candle for DOJI check
                const nextCandle =
                  i + 1 < candlesUpToTime.length
                    ? candlesUpToTime[i + 1]
                    : null;
                const nextIsRed = nextCandle
                  ? nextCandle.close < nextCandle.open
                  : false;

                // Validation: Must be RED candle OR (DOJI + next is RED)
                if (!isRedCandle && !(isDoji && nextIsRed)) {
                  continue; // Skip: Not a valid rejection candle
                }

                // If DOJI + next RED: Use NEXT candle as entry point
                let actualEntryCandle = candle;
                let actualIndex = i;
                if (isDoji && nextIsRed && nextCandle) {
                  actualEntryCandle = nextCandle;
                  actualIndex = i + 1;
                  this.logger.debug(
                    `${inst.tradingsymbol}: DOJI at ${candleTime}, using next RED candle for entry`,
                  );
                }

                // Recalculate candle properties for actual entry candle
                const actualCandleHigh = actualEntryCandle.high;
                const actualCandleLow = actualEntryCandle.low;
                const actualCandleOpen = actualEntryCandle.open;
                const actualCandleClose = actualEntryCandle.close;
                const actualCandleBody = Math.abs(
                  actualCandleClose - actualCandleOpen,
                );
                const actualUpperWick =
                  actualCandleHigh -
                  Math.max(actualCandleOpen, actualCandleClose);
                const actualLowerWick =
                  Math.min(actualCandleOpen, actualCandleClose) -
                  actualCandleLow;
                const actualTotalRange = actualCandleHigh - actualCandleLow;
                const actualIsRedCandle = actualCandleClose < actualCandleOpen;
                const actualIsGreenCandle =
                  actualCandleClose > actualCandleOpen;
                const actualCandleVolume = actualEntryCandle.volume || 0;

                // Get previous candles for context (relative to actual entry candle)
                const prev1 =
                  actualIndex >= 1 ? candlesUpToTime[actualIndex - 1] : null;
                const prev2 =
                  actualIndex >= 2 ? candlesUpToTime[actualIndex - 2] : null;
                const prev3 =
                  actualIndex >= 3 ? candlesUpToTime[actualIndex - 3] : null;

                // Calculate average volume
                const avg5Vol = avgVolume5(0, actualIndex);

                // ===== FILTER 3: VOLUME CONFIRMATION =====
                const hasVolumeConfirmation =
                  actualCandleVolume > avg5Vol * 1.2;

                // Count resistance tests
                let resistanceTests = 0;
                const resistanceLevel = nearYesterdayHigh
                  ? yesterdayHigh
                  : nearSwingHigh
                    ? swingHighs.find(
                        (s) => Math.abs(candleHigh - s.price) <= marginPoints,
                      )?.price
                    : candleEMA;

                if (resistanceLevel) {
                  [prev3, prev2, prev1, actualEntryCandle].forEach((c) => {
                    if (
                      c &&
                      Math.abs(c.high - resistanceLevel) <= marginPoints * 1.5
                    ) {
                      resistanceTests++;
                    }
                  });
                }

                // Pattern Detection (count confirmations)
                // Pattern 1: Weak close at resistance (must be on RED candle)
                if (
                  actualIsRedCandle &&
                  (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
                  actualCandleHigh >= (resistanceLevel || candleEMA) * 0.99 &&
                  actualCandleClose < actualCandleHigh * 0.995 &&
                  resistanceTests >= 2
                ) {
                  confirmations++;
                  patterns.push(`Weak Close (${resistanceTests} tests)`);
                }

                // Pattern 2: Early rejection (upper wick, must be on RED candle)
                if (
                  actualIsRedCandle &&
                  (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
                  actualUpperWick > actualCandleBody * 1.2 &&
                  actualUpperWick > actualTotalRange * 0.4 &&
                  actualCandleClose < actualCandleHigh * 0.99
                ) {
                  confirmations++;
                  patterns.push('Early Rejection');
                }

                // Pattern 3: Momentum slowing (must be on RED candle)
                if (prev2 && prev1 && actualIsRedCandle) {
                  const body2 = Math.abs(prev2.close - prev2.open);
                  const body1 = Math.abs(prev1.close - prev1.open);
                  if (
                    actualCandleBody < body1 &&
                    body1 < body2 &&
                    resistanceTests >= 2
                  ) {
                    confirmations++;
                    patterns.push('Momentum Slowing');
                  }
                }

                // Pattern 4: Shooting Star (must be RED candle for SELL signal)
                if (
                  actualIsRedCandle &&
                  actualUpperWick > actualCandleBody * 2 &&
                  actualLowerWick < actualCandleBody * 0.5 &&
                  actualUpperWick > actualTotalRange * 0.6
                ) {
                  confirmations++;
                  patterns.push('Shooting Star');
                }

                // Pattern 5: Bearish Engulfing
                if (
                  prev1 &&
                  prev1.close > prev1.open &&
                  actualCandleOpen > prev1.close &&
                  actualCandleClose < prev1.open &&
                  actualIsRedCandle
                ) {
                  confirmations++;
                  patterns.push('Bearish Engulfing');
                }

                // Pattern 6: Strong Upper Wick Rejection
                if (
                  actualIsRedCandle &&
                  actualUpperWick > actualCandleBody * 2 &&
                  actualUpperWick > actualTotalRange * 0.5 &&
                  actualCandleClose < actualCandleOpen * 0.98
                ) {
                  confirmations++;
                  patterns.push('Strong Rejection');
                }

                // ===== FILTER 4: MULTIPLE CONFIRMATIONS =====
                // Need at least 2 pattern confirmations + volume confirmation
                if (confirmations >= 2 && hasVolumeConfirmation) {
                  signalDetected = true;
                  signalReason = `${patterns.join(' + ')} | RSI:${candleRSI.toFixed(0)} | Vol:${(actualCandleVolume / avg5Vol).toFixed(1)}x`;
                }

                if (signalDetected) {
                  // Update entry price to actual entry candle close
                  entryPrice = actualCandleClose;

                  // Risk Management: SL = Entry candle high + 7 points
                  const stopLoss = actualCandleHigh + 7;
                  const risk = stopLoss - entryPrice;
                  const target1 = entryPrice - risk * 2;
                  const target2 = entryPrice - risk * 3;
                  const target3 = entryPrice - risk * 4;

                  sellSignals.push({
                    time: candleTime,
                    date: candleDate, // Full Date object from candle
                    timestamp: candleTimestamp,
                    recommendation: 'SELL',
                    reason: `${signalReason} (Risk: ${risk.toFixed(1)}pts)`,
                    price: entryPrice,
                    stopLoss,
                    target1,
                    target2,
                    target3,
                  });

                  lastSignalSL = stopLoss;
                  activeTradeClosed = false; // Mark trade as active

                  this.logger.debug(
                    `${inst.tradingsymbol}: SMART_SELL signal at ${candleTime}, Confirmations: ${confirmations}, Reason: ${signalReason}, Entry: ${entryPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)} (Risk: ${risk.toFixed(1)}pts), T1: ${target1.toFixed(2)}`,
                  );

                  // === CHECK IF TRADE CLOSES (SL or Target hit) ===
                  // Start from actualIndex + 1 (after the actual entry candle)
                  for (
                    let j = actualIndex + 1;
                    j < candlesUpToTime.length;
                    j++
                  ) {
                    const futureCandle = candlesUpToTime[j];

                    // Check if SL hit
                    if (futureCandle.high >= stopLoss) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} SL HIT. Allowing next signal.`,
                      );
                      break;
                    }

                    // Check if any target hit
                    if (futureCandle.low <= target3) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:4 HIT. Allowing next signal.`,
                      );
                      break;
                    } else if (futureCandle.low <= target2) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:3 HIT. Allowing next signal.`,
                      );
                      break;
                    } else if (futureCandle.low <= target1) {
                      activeTradeClosed = true;
                      this.logger.debug(
                        `${inst.tradingsymbol}: Trade ${sellSignals.length} TARGET 1:2 HIT. Allowing next signal.`,
                      );
                      break;
                    }
                  }

                  if (!activeTradeClosed) {
                    this.logger.debug(
                      `${inst.tradingsymbol}: Trade ${sellSignals.length} still OPEN. No more signals.`,
                    );
                  }
                }
              }

              if (sellSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No SMART_SELL signals found (strict filters applied)`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${sellSignals.length} SMART_SELL signal(s)`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: sellSignals,
                ltp: ltp,
                lotSize: inst.lot_size,
                candles: candlesUpToTime, // Include candles for historical trade closure
              };
            }

            // ============ 20 EMA STRATEGY ============
            if (strategy === '20_EMA') {
              // For 20 EMA, we only need TODAY's intraday candles, no yesterday data
              this.logger.debug(
                `[20 EMA] Fetching today's intraday data for ${inst.tradingsymbol}`,
              );

              let emaValue: number | null = null;
              let emaTrend: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';

              if (interval === 'day') {
                this.logger.warn(
                  `${inst.tradingsymbol}: Cannot calculate 20 EMA with day interval. Skipping.`,
                );
                return null;
              }

              // Fetch today's intraday candles (cache-first)
              const intradayHistorical = await this.getCandlesWithCache(
                kc,
                inst.instrument_token,
                interval,
                todayFrom,
                todayTo,
                instrumentSource === 'db',
              );

              if (!intradayHistorical || intradayHistorical.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles (${intradayHistorical?.length || 0}) for 20 EMA calculation`,
                );
                return null;
              }

              // Filter candles up to specific time
              const [targetHour, targetMin] = specificTime
                .split(':')
                .map(Number);
              const candlesUpToTime = intradayHistorical.filter((candle) => {
                const candleDate = new Date(candle.date);
                const candleHour = candleDate.getHours();
                const candleMin = candleDate.getMinutes();
                return (
                  candleHour < targetHour ||
                  (candleHour === targetHour && candleMin <= targetMin)
                );
              });

              this.logger.debug(
                `${inst.tradingsymbol}: Total candles=${intradayHistorical.length}, Filtered up to ${specificTime}=${candlesUpToTime.length}`,
              );

              if (candlesUpToTime.length < 20) {
                this.logger.warn(
                  `${inst.tradingsymbol}: Not enough candles up to ${specificTime} for 20 EMA (need 20, got ${candlesUpToTime.length})`,
                );
                return null;
              }

              // Calculate 20 EMA
              const closePrices = candlesUpToTime.map((c) => c.close);
              const emaValues = this.indicators.calculateEMA(closePrices, 20);
              emaValue = emaValues[emaValues.length - 1];

              // Determine EMA trend
              if (emaValues.length >= 25) {
                const currentEMA = emaValues[emaValues.length - 1];
                const pastEMA = emaValues[emaValues.length - 6];
                if (currentEMA && pastEMA) {
                  if (currentEMA > pastEMA * 1.002) {
                    emaTrend = 'UP';
                  } else if (currentEMA < pastEMA * 0.998) {
                    emaTrend = 'DOWN';
                  }
                }
              }

              const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
              const todayHigh = Math.max(...candlesUpToTime.map((c) => c.high));
              const todayLow = Math.min(...candlesUpToTime.map((c) => c.low));
              const ltp = lastCandle.close || 0;

              this.logger.debug(
                `${inst.tradingsymbol}: Analyzing ${candlesUpToTime.length} candles up to ${specificTime}, Trend=${emaTrend}`,
              );

              // Check ALL candles for rejection patterns
              const rejectionSignals: Array<{
                time: string;
                date: Date; // Full Date object from candle
                recommendation: 'SELL' | 'BUY';
                reason: string;
                price: number;
              }> = [];
              let touchCount = 0;

              for (let i = 19; i < candlesUpToTime.length; i++) {
                const candle = candlesUpToTime[i];
                const candleEMA = emaValues[i];

                if (!candleEMA) continue;

                const candleHigh = candle.high;
                const candleLow = candle.low;
                const candleOpen = candle.open;
                const candleClose = candle.close;

                const distanceHighToEMA = Math.abs(candleHigh - candleEMA);
                const distanceLowToEMA = Math.abs(candleLow - candleEMA);
                const distanceCloseToEMA = Math.abs(candleClose - candleEMA);

                const touchedEMA =
                  distanceHighToEMA <= marginPoints ||
                  distanceLowToEMA <= marginPoints ||
                  distanceCloseToEMA <= marginPoints;

                if (touchedEMA) {
                  touchCount++;
                  const candleDate = new Date(candle.date); // Full Date object
                  const candleTime = candleDate.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  });
                  this.logger.debug(
                    `${inst.tradingsymbol}: Candle #${i - 18} at ${candleTime} touched EMA: H=${candleHigh.toFixed(2)}, L=${candleLow.toFixed(2)}, C=${candleClose.toFixed(2)}, EMA=${candleEMA.toFixed(2)}`,
                  );

                  const candleBody = Math.abs(candleClose - candleOpen);
                  const upperWick =
                    candleHigh - Math.max(candleOpen, candleClose);
                  const lowerWick =
                    Math.min(candleOpen, candleClose) - candleLow;
                  const isRedCandle = candleClose < candleOpen;
                  const isGreenCandle = candleClose > candleOpen;

                  // BUY Signal: In uptrend, price pullback to EMA
                  if (emaTrend === 'UP') {
                    const hasLowerWickRejection =
                      lowerWick > candleBody * 1.2 &&
                      candleClose > candleEMA &&
                      candleLow <= candleEMA * 1.01;

                    const hasBullishBounce =
                      candleOpen < candleEMA &&
                      candleClose > candleEMA &&
                      isGreenCandle &&
                      candleBody > (candleHigh - candleLow) * 0.4;

                    if (hasLowerWickRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Lower wick rejection at 20 EMA',
                        price: candleClose,
                      });
                    } else if (hasBullishBounce) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Bullish bounce from 20 EMA',
                        price: candleClose,
                      });
                    }
                  }

                  // SELL Signal: In downtrend, price rally to EMA
                  if (emaTrend === 'DOWN') {
                    const hasUpperWickRejection =
                      upperWick > candleBody * 1.2 &&
                      candleClose < candleEMA &&
                      candleHigh >= candleEMA * 0.99;

                    const hasBearishRejection =
                      candleOpen > candleEMA &&
                      candleClose < candleEMA &&
                      isRedCandle &&
                      candleBody > (candleHigh - candleLow) * 0.4;

                    if (hasUpperWickRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Upper wick rejection at 20 EMA',
                        price: candleClose,
                      });
                    } else if (hasBearishRejection) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Bearish rejection from 20 EMA',
                        price: candleClose,
                      });
                    }
                  }
                }
              }

              if (rejectionSignals.length === 0) {
                this.logger.debug(
                  `${inst.tradingsymbol}: No rejection pattern found (Touched EMA ${touchCount} times)`,
                );
                return null;
              }

              this.logger.log(
                `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s): ${rejectionSignals.map((s) => `${s.recommendation} at ${s.time}`).join(', ')}`,
              );

              return {
                symbol: cleanSymbol,
                strike: inst.strike,
                optionType: inst.instrument_type as 'CE' | 'PE',
                tradingsymbol: inst.tradingsymbol,
                instrumentToken: inst.instrument_token,
                signals: rejectionSignals,
                ltp: ltp,
              };
            }

            // ============ PREVIOUS DAY HIGH/LOW STRATEGY ============
            if (strategy === 'PREV_DAY_HIGH_LOW') {
              this.logger.debug(
                `Fetching yesterday data for ${inst.tradingsymbol} (token: ${inst.instrument_token})`,
              );

              // Fetch yesterday's OHLC data
              const yesterdayHistorical = await kc.getHistoricalData(
                inst.instrument_token,
                'day',
                yesterdayFrom,
                yesterdayTo,
              );

              this.logger.debug(
                `Yesterday data for ${inst.tradingsymbol}: ${JSON.stringify(yesterdayHistorical)}`,
              );

              if (!yesterdayHistorical || yesterdayHistorical.length === 0) {
                this.logger.warn(`No yesterday data for ${inst.tradingsymbol}`);
                return null; // Skip options with no yesterday data
              }

              const yesterdayData = yesterdayHistorical[0];
              const yesterdayHigh = yesterdayData.high;
              const yesterdayLow = yesterdayData.low;

              this.logger.debug(
                `Fetching today data for ${inst.tradingsymbol}`,
              );

              // Fetch today's OHLC data based on interval
              let todayHigh = 0;
              let todayLow = 0;
              let todayOpen = 0;
              let todayClose = 0;
              let ltp = 0;

              if (interval === 'day') {
                // Full day candle
                const todayHistorical = await kc.getHistoricalData(
                  inst.instrument_token,
                  'day',
                  todayFrom,
                  todayTo,
                );

                this.logger.debug(
                  `Today data for ${inst.tradingsymbol}: ${JSON.stringify(todayHistorical)}`,
                );

                if (!todayHistorical || todayHistorical.length === 0) {
                  this.logger.warn(`No today data for ${inst.tradingsymbol}`);
                  return null;
                }

                const todayData = todayHistorical[0];
                const candleDate = new Date(todayData.date); // Use today's candle date
                const candleHigh = todayData.high;
                const candleLow = todayData.low;
                const candleOpen = todayData.open;
                const candleClose = todayData.close;
                ltp = todayData.close || 0;

                // Check for rejection at yesterday's levels
                const candleBody = Math.abs(candleClose - candleOpen);
                const upperWick =
                  candleHigh - Math.max(candleOpen, candleClose);
                const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
                const totalCandleRange = candleHigh - candleLow;
                const isRedCandle = candleClose < candleOpen;
                const isGreenCandle = candleClose > candleOpen;

                const distanceHighToYesterdayHigh = Math.abs(
                  candleHigh - yesterdayHigh,
                );
                const distanceLowToYesterdayLow = Math.abs(
                  candleLow - yesterdayLow,
                );
                const nearYesterdayHigh =
                  distanceHighToYesterdayHigh <= marginPoints;
                const nearYesterdayLow =
                  distanceLowToYesterdayLow <= marginPoints;

                const rejectionSignals: Array<{
                  time: string;
                  date: Date; // Full Date object from candle
                  recommendation: 'SELL' | 'BUY';
                  reason: string;
                  price: number;
                }> = [];

                // Check SELL signals
                if (nearYesterdayHigh) {
                  const hasRejectionAtHigh =
                    upperWick > candleBody * 1.5 &&
                    candleClose < yesterdayHigh &&
                    candleHigh >= yesterdayHigh * 0.98;

                  const hasBreakoutFailure =
                    candleOpen > yesterdayHigh &&
                    candleClose < yesterdayHigh &&
                    isRedCandle &&
                    candleBody > totalCandleRange * 0.5;

                  if (hasRejectionAtHigh) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Rejection at resistance (prev day high)',
                      price: candleClose,
                    });
                  } else if (hasBreakoutFailure) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Breakout failure at resistance',
                      price: candleClose,
                    });
                  } else if (candleHigh >= yesterdayHigh * 0.98) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'SELL',
                      reason: 'Tested resistance (prev day high)',
                      price: candleClose,
                    });
                  }
                }

                // Check BUY signals
                if (nearYesterdayLow) {
                  const hasRejectionAtLow =
                    lowerWick > candleBody * 1.5 &&
                    candleClose > yesterdayLow &&
                    candleLow <= yesterdayLow * 1.02;

                  const hasBreakdownFailure =
                    candleOpen < yesterdayLow &&
                    candleClose > yesterdayLow &&
                    isGreenCandle &&
                    candleBody > totalCandleRange * 0.5;

                  if (hasRejectionAtLow) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Rejection at support (prev day low)',
                      price: candleClose,
                    });
                  } else if (hasBreakdownFailure) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Breakdown failure at support',
                      price: candleClose,
                    });
                  } else if (candleLow <= yesterdayLow * 1.02) {
                    rejectionSignals.push({
                      time: 'Full Day',
                      date: candleDate, // Daily candle's date
                      recommendation: 'BUY',
                      reason: 'Tested support (prev day low)',
                      price: candleClose,
                    });
                  }
                }

                if (rejectionSignals.length === 0) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: No rejection signals found at prev day high/low (day candle)`,
                  );
                  return null;
                }

                this.logger.log(
                  `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s) on day candle`,
                );

                return {
                  symbol: cleanSymbol,
                  strike: inst.strike,
                  optionType: inst.instrument_type as 'CE' | 'PE',
                  tradingsymbol: inst.tradingsymbol,
                  instrumentToken: inst.instrument_token,
                  signals: rejectionSignals,
                  ltp: ltp,
                  lotSize: inst.lot_size,
                };
              } else {
                // Intraday candle logic - check ALL candles for rejection patterns
                const intradayHistorical = await kc.getHistoricalData(
                  inst.instrument_token,
                  interval,
                  todayFrom,
                  todayTo,
                );

                this.logger.debug(
                  `Intraday data for ${inst.tradingsymbol}: ${intradayHistorical?.length || 0} candles`,
                );

                if (!intradayHistorical || intradayHistorical.length === 0) {
                  this.logger.warn(
                    `No intraday data for ${inst.tradingsymbol}`,
                  );
                  return null;
                }

                // Filter candles up to specific time
                const [targetHour, targetMin] = specificTime
                  .split(':')
                  .map(Number);

                const candlesUpToTime = intradayHistorical.filter((candle) => {
                  const candleDate = new Date(candle.date);
                  const candleHour = candleDate.getHours();
                  const candleMin = candleDate.getMinutes();
                  return (
                    candleHour < targetHour ||
                    (candleHour === targetHour && candleMin <= targetMin)
                  );
                });

                if (candlesUpToTime.length === 0) {
                  this.logger.warn(
                    `No candles found at or before ${specificTime} for ${inst.tradingsymbol}`,
                  );
                  return null;
                }

                this.logger.debug(
                  `${inst.tradingsymbol}: Checking ${candlesUpToTime.length} candles for prev day high/low rejections`,
                );

                // Loop through all candles and collect rejection signals
                const rejectionSignals: Array<{
                  time: string;
                  date: Date; // Full Date object from candle
                  recommendation: 'SELL' | 'BUY';
                  reason: string;
                  price: number;
                }> = [];

                for (let i = 0; i < candlesUpToTime.length; i++) {
                  const candle = candlesUpToTime[i];
                  const candleHigh = candle.high;
                  const candleLow = candle.low;
                  const candleOpen = candle.open;
                  const candleClose = candle.close;
                  const candleBody = Math.abs(candleClose - candleOpen);
                  const upperWick =
                    candleHigh - Math.max(candleOpen, candleClose);
                  const lowerWick =
                    Math.min(candleOpen, candleClose) - candleLow;
                  const totalCandleRange = candleHigh - candleLow;
                  const isRedCandle = candleClose < candleOpen;
                  const isGreenCandle = candleClose > candleOpen;

                  // Check distance to yesterday's levels
                  const distanceHighToYesterdayHigh = Math.abs(
                    candleHigh - yesterdayHigh,
                  );
                  const distanceLowToYesterdayLow = Math.abs(
                    candleLow - yesterdayLow,
                  );

                  const nearYesterdayHigh =
                    distanceHighToYesterdayHigh <= marginPoints;
                  const nearYesterdayLow =
                    distanceLowToYesterdayLow <= marginPoints;

                  const candleDate = new Date(candle.date); // Full Date object
                  const candleTime = candleDate.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true,
                  });

                  // SELL Signal at yesterday's high
                  if (nearYesterdayHigh) {
                    const hasRejectionAtHigh =
                      upperWick > candleBody * 1.5 &&
                      candleClose < yesterdayHigh &&
                      candleHigh >= yesterdayHigh * 0.98;

                    const hasBreakoutFailure =
                      candleOpen > yesterdayHigh &&
                      candleClose < yesterdayHigh &&
                      isRedCandle &&
                      candleBody > totalCandleRange * 0.5;

                    if (hasRejectionAtHigh) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Rejection at resistance (prev day high)',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: SELL signal at ${candleTime}, YH=${yesterdayHigh.toFixed(2)}, High=${candleHigh.toFixed(2)}`,
                      );
                    } else if (hasBreakoutFailure) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Breakout failure at resistance',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: SELL signal (breakout failure) at ${candleTime}`,
                      );
                    } else if (candleHigh >= yesterdayHigh * 0.98) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'SELL',
                        reason: 'Tested resistance (prev day high)',
                        price: candleClose,
                      });
                    }
                  }

                  // BUY Signal at yesterday's low
                  if (nearYesterdayLow) {
                    const hasRejectionAtLow =
                      lowerWick > candleBody * 1.5 &&
                      candleClose > yesterdayLow &&
                      candleLow <= yesterdayLow * 1.02;

                    const hasBreakdownFailure =
                      candleOpen < yesterdayLow &&
                      candleClose > yesterdayLow &&
                      isGreenCandle &&
                      candleBody > totalCandleRange * 0.5;

                    if (hasRejectionAtLow) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Rejection at support (prev day low)',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: BUY signal at ${candleTime}, YL=${yesterdayLow.toFixed(2)}, Low=${candleLow.toFixed(2)}`,
                      );
                    } else if (hasBreakdownFailure) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Breakdown failure at support',
                        price: candleClose,
                      });
                      this.logger.debug(
                        `${inst.tradingsymbol}: BUY signal (breakdown failure) at ${candleTime}`,
                      );
                    } else if (candleLow <= yesterdayLow * 1.02) {
                      rejectionSignals.push({
                        time: candleTime,
                        date: candleDate,
                        recommendation: 'BUY',
                        reason: 'Tested support (prev day low)',
                        price: candleClose,
                      });
                    }
                  }
                }

                if (rejectionSignals.length === 0) {
                  this.logger.debug(
                    `${inst.tradingsymbol}: No rejection signals found at prev day high/low`,
                  );
                  return null;
                }

                this.logger.log(
                  `${inst.tradingsymbol}: ✓ Found ${rejectionSignals.length} signal(s): ${rejectionSignals.map((s) => `${s.recommendation} at ${s.time}`).join(', ')}`,
                );

                const lastCandle = candlesUpToTime[candlesUpToTime.length - 1];
                ltp = lastCandle.close || 0;

                return {
                  symbol: cleanSymbol,
                  strike: inst.strike,
                  optionType: inst.instrument_type as 'CE' | 'PE',
                  tradingsymbol: inst.tradingsymbol,
                  instrumentToken: inst.instrument_token,
                  signals: rejectionSignals,
                  ltp: ltp,
                  lotSize: inst.lot_size,
                  candles: candlesUpToTime, // Include candles for historical trade closure
                };
              }
            } // end PREV_DAY_HIGH_LOW

            // Both strategies return earlier, this should not be reached
            return null;
          } catch (err) {
            this.logger.error(
              `Error fetching data for ${inst.tradingsymbol}: ${err.message}`,
            );
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const validResults = batchResults.filter((r) => r !== null);
        results.push(...validResults);

        this.logger.log(
          `Batch ${Math.floor(i / batchSize) + 1}: Processed ${batchResults.length} options, ${validResults.length} with signals, ${results.length} total`,
        );

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < resolvedInstruments.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Count total signals
      const totalSignals = results.reduce(
        (sum, r) => sum + (r.signals?.length || 0),
        0,
      );
      const sellCount = results.reduce(
        (sum, r) =>
          sum +
          (r.signals?.filter((s: any) => s.recommendation === 'SELL').length ||
            0),
        0,
      );
      const buyCount = results.reduce(
        (sum, r) =>
          sum +
          (r.signals?.filter((s: any) => s.recommendation === 'BUY').length ||
            0),
        0,
      );

      this.logger.log(
        `Found ${results.length} options with ${totalSignals} total signals: ${sellCount} SELL, ${buyCount} BUY`,
      );

      // === FILTER TO ATM STRIKES FOR DAY_BUYING ===
      if (strategy === 'DAY_BUYING' && results.length > 0 && spotPrice > 0) {
        // Only keep options that have signals
        const optionsWithSignals = results.filter(
          (r) => r.signals && r.signals.length > 0,
        );

        this.logger.log(
          `[DAY_BUYING] Filtering to ATM strikes. ${optionsWithSignals.length} options with signals, Spot: ${spotPrice}`,
        );

        if (optionsWithSignals.length > 0) {
          // Find ATM CE (strike closest to spot price, below or at spot)
          const ceOptions = optionsWithSignals.filter(
            (r) => r.optionType === 'CE',
          );
          const peOptions = optionsWithSignals.filter(
            (r) => r.optionType === 'PE',
          );

          // For CE: ATM is strike <= spot, closest to spot
          const atmCE = ceOptions
            .filter((r) => r.strike <= spotPrice)
            .sort(
              (a, b) =>
                Math.abs(spotPrice - a.strike) - Math.abs(spotPrice - b.strike),
            )[0];

          // For PE: ATM is strike >= spot, closest to spot
          const atmPE = peOptions
            .filter((r) => r.strike >= spotPrice)
            .sort(
              (a, b) =>
                Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice),
            )[0];

          // Keep only ATM CE and ATM PE
          const filteredResults = [];
          if (atmCE) {
            filteredResults.push(atmCE);
            this.logger.log(
              `[DAY_BUYING] Selected ATM CE: ${atmCE.tradingsymbol} (Strike: ${atmCE.strike}, Signals: ${atmCE.signals.length})`,
            );
          } else {
            this.logger.warn(`[DAY_BUYING] No ATM CE found with signals`);
          }

          if (atmPE) {
            filteredResults.push(atmPE);
            this.logger.log(
              `[DAY_BUYING] Selected ATM PE: ${atmPE.tradingsymbol} (Strike: ${atmPE.strike}, Signals: ${atmPE.signals.length})`,
            );
          } else {
            this.logger.warn(`[DAY_BUYING] No ATM PE found with signals`);
          }

          // Replace results with filtered results
          results.splice(0, results.length, ...filteredResults);

          this.logger.log(
            `[DAY_BUYING] Filtered to ${results.length} ATM options (1 CE + 1 PE)`,
          );
        }
      }

      // === DHR / SPPP / DAY_REVERSAL: inject complementary BUY signals ===
      // When a SELL fires on CE (call premium rejected day high → price going down),
      // the PE (put premium, same expiry) gets cheaper → BUY the PE at that moment.
      // Mirror: SELL on PE → BUY on CE.
      if (
        strategy === 'DAY_HIGH_REJECTION' ||
        strategy === 'DAY_LOW_BREAK' ||
        strategy === 'SUPER_POWER_PACK' ||
        strategy === 'DAY_REVERSAL'
      ) {
        const dhrAll = results.filter(Boolean) as any[];
        const ceRes = dhrAll.find((r) => r.optionType === 'CE');
        const peRes = dhrAll.find((r) => r.optionType === 'PE');

        const injectComplementaryBuys = (sellSide: any, buySide: any) => {
          if (!sellSide?.signals?.length || !buySide?.candles?.length) return;
          const buyCandles: any[] = buySide.candles;
          const buyLotSize = canonicalLotSize(symbol, buySide.lotSize || 1);
          const buyEodClose = buyCandles[buyCandles.length - 1]?.close ?? 0;

          for (const sig of sellSide.signals) {
            if (sig.recommendation !== 'SELL') continue;

            // Mirror the SELL signal's actual qty (which may be reduced by
            // placeQtyBasedOnSL). Using paperLots * buyLotSize would over-size
            // the complementary BUY whenever position sizing reduced the SELL.
            const buyTotalQty = sig.qty ?? paperLots * buyLotSize;
            const buyHalfQty = Math.floor(buyTotalQty / 2);
            const buyRemainingQty = buyTotalQty - buyHalfQty;

            // Find the buy-side candle at or just after the SELL signal time.
            const sigTs =
              sig.date instanceof Date
                ? sig.date.getTime()
                : new Date(sig.date).getTime();
            let entryIdx = 0;
            let bestDiff = Infinity;
            let foundFutureCandle = false;
            for (let ci = 0; ci < buyCandles.length; ci++) {
              const ct =
                buyCandles[ci].date instanceof Date
                  ? buyCandles[ci].date.getTime()
                  : new Date(buyCandles[ci].date).getTime();
              const diff = ct >= sigTs ? ct - sigTs : Infinity;
              if (diff < bestDiff) {
                bestDiff = diff;
                entryIdx = ci;
                foundFutureCandle = true;
              }
            }
            if (!foundFutureCandle) {
              for (let ci = 0; ci < buyCandles.length; ci++) {
                const ct =
                  buyCandles[ci].date instanceof Date
                    ? buyCandles[ci].date.getTime()
                    : new Date(buyCandles[ci].date).getTime();
                const diff = Math.abs(ct - sigTs);
                if (diff < bestDiff) {
                  bestDiff = diff;
                  entryIdx = ci;
                }
              }
            }

            const entryCandle = buyCandles[entryIdx];
            // When Trade Finder has the full day's candles, `foundFutureCandle`
            // is true and the selected candle is the first 5-min bar AFTER the
            // signal time. Using its CLOSE would pick a price up to 5 minutes
            // into the future — artificially diverging from live mode where the
            // same candle hasn't closed yet and we use the previous bar's close.
            // Using OPEN instead aligns both: the 5-min bar's open ≈ the market
            // price at the candle's start, matching the live-mode entry price.
            // In live mode (foundFutureCandle = false) we keep the previous
            // candle's CLOSE, which approximates the current market price.
            const entryPrice = foundFutureCandle
              ? (entryCandle.open ?? entryCandle.close)
              : entryCandle.close;
            if (!entryPrice || entryPrice <= 0) continue;

            // SL and targets from SELL signal risk.
            // DAY_REVERSAL / DAY_LOW_BREAK / SUPER_POWER_PACK SELL T1 = 1:1 RR,
            // so the complementary BUY also uses 1:1 for T1 (consistent symmetry).
            // DAY_HIGH_REJECTION / EMA_REJECTION SELL T1 = 1:2 RR → BUY keeps 1:2.
            const sellRisk = Math.abs(sig.stopLoss - sig.price);
            const slPrice = entryPrice - sellRisk;
            const t1Mult =
              strategy === 'DAY_LOW_BREAK' ||
              strategy === 'SUPER_POWER_PACK' ||
              strategy === 'DAY_REVERSAL'
                ? 1
                : 2;
            const target1 = entryPrice + sellRisk * t1Mult;
            const target2 = entryPrice + sellRisk * (t1Mult + 1);
            const target3 = entryPrice + sellRisk * (t1Mult + 2);
            const pairedType = sellSide.optionType;

            // ── Two-phase outcome scan (mirrors SELL logic, inverted for BUY) ──
            // Phase 1: SL on wick low, T1 on wick high
            // Phase 2 (after T1): BE if price falls back to entry, else T2/T3/EOD
            let outcome: 'T1' | 'T2' | 'T3' | 'SL' | 'BE' | 'OPEN' = 'OPEN';
            let buyT1HitIdx = -1;

            for (let j = entryIdx + 1; j < buyCandles.length; j++) {
              const fc = buyCandles[j];
              if (fc.low <= slPrice) {
                outcome = 'SL';
                break;
              }
              if (fc.high >= target1) {
                buyT1HitIdx = j;
                break;
              }
            }

            if (buyT1HitIdx >= 0) {
              let phase2Done = false;
              for (let j = buyT1HitIdx + 1; j < buyCandles.length; j++) {
                const fc = buyCandles[j];
                if (fc.low <= entryPrice) {
                  outcome = 'BE';
                  phase2Done = true;
                  break;
                }
                if (fc.high >= target3) {
                  outcome = 'T3';
                  phase2Done = true;
                  break;
                } else if (fc.high >= target2) {
                  outcome = 'T2';
                  phase2Done = true;
                  break;
                }
              }
              if (!phase2Done) outcome = 'T1';
            }

            // ── P&L (mirrors SELL pnl logic, sign inverted for BUY) ──
            let pnl: number;
            if (outcome === 'SL') {
              pnl = (slPrice - entryPrice) * buyTotalQty; // negative
            } else if (buyT1HitIdx >= 0) {
              const t1Profit = (target1 - entryPrice) * buyHalfQty;
              if (outcome === 'BE') {
                pnl = t1Profit; // remaining closed at entry = 0
              } else if (outcome === 'T2') {
                pnl = t1Profit + (target2 - entryPrice) * buyRemainingQty;
              } else if (outcome === 'T3') {
                pnl = t1Profit + (target3 - entryPrice) * buyRemainingQty;
              } else {
                pnl = t1Profit + (buyEodClose - entryPrice) * buyRemainingQty;
              }
            } else {
              pnl = (buyEodClose - entryPrice) * buyTotalQty;
            }

            buySide.signals.push({
              time: sig.time,
              date: sig.date,
              timestamp: sig.timestamp,
              recommendation: 'BUY',
              reason: `${pairedType} rejection → BUY ${buySide.optionType} @ ₹${entryPrice.toFixed(2)}`,
              price: entryPrice,
              stopLoss: slPrice,
              target1,
              target2,
              target3,
              patternName: `${pairedType}_REJECTION_BUY`,
              outcome,
              pnl: Math.round(pnl),
              // Mirror the paired SELL signal's actual qty (respects placeQtyBasedOnSL).
              qty: buyTotalQty,
            });
          }
        };

        if (ceRes && peRes) {
          injectComplementaryBuys(ceRes, peRes); // CE SELL → PE BUY
          injectComplementaryBuys(peRes, ceRes); // PE SELL → CE BUY
        }

        // Drop instruments that ended up with 0 signals (neither SELL nor BUY)
        results.splice(
          0,
          results.length,
          ...results.filter((r: any) => r && r.signals.length > 0),
        );
      }

      // === AUTO-CREATE PAPER TRADES ===
      // Only run auto-trade creation in realtimeMode (live scheduler).
      // Manual calls from Trade Finder or other endpoints must NOT create
      // paper trades — that path only scans/displays signals.
      if (!realtimeMode) {
        return { options: results, selectedInstruments: limitedInstruments };
      }

      // Check trading limits before creating paper trades
      const canTrade = await this.paperTradingService.canPlaceNewTrade(
        broker.userId,
        35, // Max daily loss: 35 points
        targetDate, // Check limits for the specific target date
      );

      if (canTrade.canTrade && results.length > 0) {
        this.logger.log(
          `Auto-trading enabled. Checking for new signals to create paper trades...`,
        );

        // Collect ALL signals from ALL options with their option data
        const allSignalsWithOptions: Array<{
          option: any;
          signal: any;
          timeValue: number; // For sorting
        }> = [];

        for (const option of results) {
          if (!option.signals || option.signals.length === 0) continue;

          for (const signal of option.signals) {
            // Parse time string to comparable value
            // Time format: "09:40 am" or "10:05 am"
            const timeValue = parseTimeToMinutes(signal.time);

            allSignalsWithOptions.push({
              option,
              signal,
              timeValue,
            });
          }
        }

        if (allSignalsWithOptions.length === 0) {
          this.logger.log('No signals found to create paper trades');
        } else {
          // Sort by time (earliest first)
          allSignalsWithOptions.sort((a, b) => a.timeValue - b.timeValue);

          this.logger.log(
            `📊 Found ${allSignalsWithOptions.length} total signals. Processing earliest SELL + earliest BUY (2 paper trades per day)...`,
          );

          // Pick the earliest SELL and earliest BUY independently
          const earliestSell = allSignalsWithOptions.find(
            (s) => s.signal.recommendation === 'SELL',
          );
          const earliestBuy = allSignalsWithOptions.find(
            (s) => s.signal.recommendation === 'BUY',
          );

          const todayStartGuard = new Date(targetDate + 'T00:00:00.000Z');
          const todayEndGuard = new Date(targetDate + 'T23:59:59.999Z');
          const targetDateObj = new Date(targetDate);
          const todayCheck = new Date();
          todayCheck.setHours(0, 0, 0, 0);
          const isHistoricalData = targetDateObj < todayCheck;

          // ── Helper: create one paper trade + run historical candle scan ──────
          const processPaperTrade = async (
            ptOption: any,
            ptSignal: any,
          ): Promise<void> => {
            // Duplicate guard: skip if this option+direction was already paper-traded today.
            const alreadyTraded = await this.prisma.signal.findFirst({
              where: {
                userId: broker.userId,
                optionSymbol: ptOption.tradingsymbol,
                signalType: ptSignal.recommendation as any,
                strategy: strategy,
                tradeCreated: true,
                signalDate: { gte: todayStartGuard, lte: todayEndGuard },
              },
            });

            if (alreadyTraded) {
              this.logger.debug(
                `⏭️ Paper trade already created for ${ptOption.tradingsymbol} ${ptSignal.recommendation} [${strategy}] today — skipping duplicate`,
              );
              return;
            }

            try {
              const entryPrice = ptSignal.price;
              const stopLoss = Math.round(ptSignal.stopLoss);
              const target1 = Math.round(ptSignal.target1);
              const target2 = Math.round(ptSignal.target2);
              const target3 = Math.round(ptSignal.target3);
              const signalTimestamp =
                ptSignal.date ||
                parseSignalTimeToDate(targetDate, ptSignal.time);

              this.logger.log(
                `Attempting to auto-create paper trade for ${ptOption.tradingsymbol} - ${ptSignal.recommendation} @ ${entryPrice}`,
              );

              const createdTrade =
                await this.paperTradingService.createPaperTrade({
                  userId: broker.userId,
                  brokerId: broker.id,
                  symbol: ptOption.symbol,
                  optionSymbol: ptOption.tradingsymbol,
                  instrumentToken: ptOption.instrumentToken,
                  strike: ptOption.strike,
                  optionType: ptOption.optionType,
                  expiryDate: expiry,
                  signalType: ptSignal.recommendation,
                  strategy: strategy,
                  signalReason: ptSignal.reason,
                  entryPrice: entryPrice,
                  entryTime: signalTimestamp,
                  stopLoss: stopLoss,
                  target1: target1,
                  target2: target2,
                  target3: target3,
                  // Use signal qty so paper trade and signal alert show the same
                  // quantity. Fallback: option lotSize (1 lot), then 1.
                  quantity: ptSignal.qty || ptOption.lotSize || 1,
                  marginPoints: marginPoints,
                  interval: interval,
                });

              this.logger.log(
                `✅ Auto-created paper trade: ${ptOption.tradingsymbol} ${ptSignal.recommendation} @ ${entryPrice} (Signal time: ${ptSignal.time})`,
              );

              // Attach the paper trade ID to the signal object so the SCHEDULER
              // can mark it as traded AFTER saveSignal() persists it to the DB.
              ptSignal.paperTradeId = createdTrade.id;

              // Historical data: scan subsequent candles to auto-close the trade
              if (
                isHistoricalData &&
                ptOption.candles &&
                ptOption.candles.length > 0
              ) {
                this.logger.log(
                  `📊 Historical data detected. Scanning ${ptOption.candles.length} candles for SL/Target hits...`,
                );

                const signalIndex = ptOption.candles.findIndex((c: any) => {
                  const candleTime = new Date(c.date).toLocaleTimeString(
                    'en-IN',
                    { hour: '2-digit', minute: '2-digit', hour12: true },
                  );
                  return candleTime === ptSignal.time;
                });

                if (
                  signalIndex >= 0 &&
                  signalIndex < ptOption.candles.length - 1
                ) {
                  for (
                    let i = signalIndex + 1;
                    i < ptOption.candles.length;
                    i++
                  ) {
                    const candle = ptOption.candles[i];
                    const candleHigh = candle.high;
                    const candleLow = candle.low;
                    const candleClose = candle.close;
                    const candleDate = new Date(candle.date);

                    let shouldClose = false;
                    let exitPrice = candleClose;
                    let newStatus: any;

                    if (ptSignal.recommendation === 'SELL') {
                      // SELL: SL on wick high, targets on candle close
                      if (candleHigh >= stopLoss) {
                        shouldClose = true;
                        exitPrice = stopLoss;
                        newStatus = 'CLOSED_SL';
                        this.logger.log(
                          `🛑 SL HIT: ${ptOption.tradingsymbol} at ${exitPrice} (candle high: ${candleHigh})`,
                        );
                      } else if (candleClose <= target3) {
                        shouldClose = true;
                        exitPrice = target3;
                        newStatus = 'CLOSED_TARGET3';
                        this.logger.log(
                          `🎯 TARGET3 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      } else if (candleClose <= target2) {
                        shouldClose = true;
                        exitPrice = target2;
                        newStatus = 'CLOSED_TARGET2';
                        this.logger.log(
                          `🎯 TARGET2 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      } else if (candleClose <= target1) {
                        shouldClose = true;
                        exitPrice = target1;
                        newStatus = 'CLOSED_TARGET1';
                        this.logger.log(
                          `🎯 TARGET1 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      }
                    } else {
                      // BUY: SL on wick low, targets on candle close
                      if (candleLow <= stopLoss) {
                        shouldClose = true;
                        exitPrice = stopLoss;
                        newStatus = 'CLOSED_SL';
                        this.logger.log(
                          `🛑 SL HIT: ${ptOption.tradingsymbol} at ${exitPrice} (candle low: ${candleLow})`,
                        );
                      } else if (candleClose >= target3) {
                        shouldClose = true;
                        exitPrice = target3;
                        newStatus = 'CLOSED_TARGET3';
                        this.logger.log(
                          `🎯 TARGET3 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      } else if (candleClose >= target2) {
                        shouldClose = true;
                        exitPrice = target2;
                        newStatus = 'CLOSED_TARGET2';
                        this.logger.log(
                          `🎯 TARGET2 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      } else if (candleClose >= target1) {
                        shouldClose = true;
                        exitPrice = target1;
                        newStatus = 'CLOSED_TARGET1';
                        this.logger.log(
                          `🎯 TARGET1 HIT: ${ptOption.tradingsymbol} at ${exitPrice}`,
                        );
                      }
                    }

                    if (shouldClose) {
                      await this.paperTradingService.closeTrade(
                        createdTrade.id,
                        exitPrice,
                        newStatus,
                        candleDate,
                      );
                      break;
                    }
                  }
                }
              }
            } catch (err: any) {
              this.logger.error(
                `Failed to auto-create paper trade for ${ptOption.tradingsymbol}: ${err.message}`,
              );
            }
          };

          // 1. Primary SELL paper trade
          if (earliestSell) {
            this.logger.log(
              `📌 Primary SELL: ${earliestSell.option.tradingsymbol} @ ${earliestSell.signal.time}`,
            );
            await processPaperTrade(earliestSell.option, earliestSell.signal);
          }

          // 2. Complementary BUY paper trade
          if (earliestBuy) {
            this.logger.log(
              `📌 Complementary BUY: ${earliestBuy.option.tradingsymbol} @ ${earliestBuy.signal.time}`,
            );
            await processPaperTrade(earliestBuy.option, earliestBuy.signal);
          }
        }
      } else if (!canTrade.canTrade) {
        this.logger.log(`Auto-trading blocked: ${canTrade.reason}`);
      }

      // Return results even if empty - frontend will show appropriate message
      return { options: results, selectedInstruments: limitedInstruments };
    } catch (err: any) {
      this.logger.error('Failed to fetch option monitor data', err);

      // Provide user-friendly error messages
      if (
        err.message?.includes('api_key') ||
        err.message?.includes('access_token')
      ) {
        throw new Error(
          'Authentication failed. Please reconnect your broker account.',
        );
      } else if (err.message?.includes('Broker not found')) {
        throw err;
      } else if (err.message?.includes('API key not configured')) {
        throw err;
      } else if (err.message?.includes('Access token missing')) {
        throw err;
      } else if (err.message?.includes('No data')) {
        throw new Error('No market data available for the selected date/time.');
      }

      throw new Error(err?.message || 'Failed to fetch option monitor data');
    }
  }

  /**
   * Strategy Backtesting: Test strategy over a date range and generate performance report
   */
  async strategyBacktest(
    brokerId: string,
    symbol: string,
    expiry: string,
    strategy:
      | 'PREV_DAY_HIGH_LOW'
      | '20_EMA'
      | 'DAY_SELLING'
      | 'DAY_SELLING_V2'
      | 'DAY_SELLING_V2_ENHANCED'
      | 'DAY_SELLING_V1V2'
      | 'DAY_SELLING_V3'
      | 'DAY_BUYING'
      | 'SMART_SELL'
      | 'TREND_NIFTY',
    startDate: string,
    endDate: string,
    interval: 'minute' | '5minute' | '15minute' | '30minute' | '60minute',
    marginPoints: number,
  ) {
    this.logger.log(
      `Starting backtest: ${strategy} for ${symbol} from ${startDate} to ${endDate}`,
    );

    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || !broker.accessToken) {
      throw new Error('Broker not found or access token missing');
    }

    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    // Generate date range (trading days only - Mon-Fri)
    const tradingDays: string[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) {
        // Skip weekends
        tradingDays.push(d.toISOString().split('T')[0]);
      }
    }

    this.logger.log(`Testing ${tradingDays.length} trading days`);

    // Collect all trades across all days
    const allTrades: Array<{
      date: string;
      time: string;
      optionType: 'CE' | 'PE';
      strike: number;
      entry: number;
      stopLoss: number;
      target: number;
      risk: number;
      outcome: 'SL_HIT' | 'TARGET_HIT' | 'OPEN';
      pnl: number;
    }> = [];

    // Run strategy for each trading day
    for (const date of tradingDays) {
      try {
        this.logger.log(`Testing ${date}...`);

        // Run option monitor for this date
        const result = await this.optionMonitor(
          brokerId,
          symbol,
          expiry,
          marginPoints,
          date,
          interval,
          '15:30', // Full day
          strategy,
        );

        this.logger.log(
          `Date ${date}: Found ${result.options?.length || 0} options`,
        );

        if (!result.options || result.options.length === 0) {
          this.logger.debug(`No options returned for ${date}`);
          continue;
        }

        const totalSignals = result.options.reduce(
          (sum, opt) => sum + (opt.signals?.length || 0),
          0,
        );
        this.logger.log(
          `Date ${date}: Total signals across all options: ${totalSignals}`,
        );

        if (totalSignals === 0) {
          this.logger.debug(`No signals found in options for ${date}`);
          continue;
        }

        // Process each option's signals
        for (const option of result.options) {
          if (!option.signals || option.signals.length === 0) continue;

          // Get full day candles for this option to check outcomes
          const chartData = await this.getOptionChartData(
            brokerId,
            option.instrumentToken.toString(),
            date,
            interval,
            strategy,
            marginPoints,
          );

          // Check each signal's outcome
          for (const signal of option.signals) {
            const entry = signal.price;
            const stopLoss = signal.stopLoss;
            const target = signal.target1 || signal.target;
            const risk = stopLoss - entry;

            let outcome: 'SL_HIT' | 'TARGET_HIT' | 'OPEN' = 'OPEN';
            let pnl = 0;

            this.logger.debug(
              `Checking outcome for signal: Entry=${entry}, SL=${stopLoss}, Target=${target}, SignalTime=${signal.time}, Timestamp=${signal.timestamp}`,
            );

            // Find the signal candle in chartData by matching timestamp
            const signalIndex = chartData.candles.findIndex((c: any) => {
              // c.time is already a Unix timestamp in seconds (with IST offset)
              const candleTime = c.time;
              const signalTimeInSeconds = signal.timestamp || 0; // Use numeric timestamp (already has IST offset)
              return Math.abs(candleTime - signalTimeInSeconds) < 300; // Within 5 min
            });

            this.logger.debug(
              `Found signal in chartData at index ${signalIndex}`,
            );

            if (signalIndex >= 0 && signalIndex < chartData.candles.length) {
              // Check subsequent candles for SL or Target hit
              for (let i = signalIndex + 1; i < chartData.candles.length; i++) {
                const candle = chartData.candles[i];

                // For SELL trades
                if (candle.high >= stopLoss) {
                  outcome = 'SL_HIT';
                  pnl = -(stopLoss - entry); // Loss
                  this.logger.debug(
                    `SL HIT at candle ${i}: High=${candle.high} >= SL=${stopLoss}, Loss=${pnl}`,
                  );
                  break;
                } else if (candle.low <= target) {
                  outcome = 'TARGET_HIT';
                  pnl = entry - target; // Profit
                  this.logger.debug(
                    `TARGET HIT at candle ${i}: Low=${candle.low} <= Target=${target}, Profit=${pnl}`,
                  );
                  break;
                }
              }
            } else {
              this.logger.warn(
                `Signal not found in candles. SignalTime=${signal.time}, Timestamp=${signal.timestamp}, First candle time=${chartData.candles[0]?.time}`,
              );
            }

            allTrades.push({
              date,
              time: signal.time || '',
              optionType: option.optionType,
              strike: option.strike,
              entry,
              stopLoss,
              target,
              risk,
              outcome,
              pnl,
            });
          }
        }

        // Small delay to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        this.logger.warn(`Error testing ${date}: ${err.message}`);
      }
    }

    // Generate report
    const totalTrades = allTrades.length;
    const slHits = allTrades.filter((t) => t.outcome === 'SL_HIT').length;
    const targetHits = allTrades.filter(
      (t) => t.outcome === 'TARGET_HIT',
    ).length;
    const openTrades = allTrades.filter((t) => t.outcome === 'OPEN').length;
    const winRate = totalTrades > 0 ? (targetHits / totalTrades) * 100 : 0;
    const totalProfit = allTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgProfitPerTrade = totalTrades > 0 ? totalProfit / totalTrades : 0;

    // Weekly breakdown
    const weeklyData: Record<
      string,
      { trades: number; profit: number; wins: number; losses: number }
    > = {};
    allTrades.forEach((trade) => {
      const date = new Date(trade.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay() + 1); // Monday
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { trades: 0, profit: 0, wins: 0, losses: 0 };
      }

      weeklyData[weekKey].trades++;
      weeklyData[weekKey].profit += trade.pnl;
      if (trade.outcome === 'TARGET_HIT') weeklyData[weekKey].wins++;
      if (trade.outcome === 'SL_HIT') weeklyData[weekKey].losses++;
    });

    // Monthly breakdown
    const monthlyData: Record<
      string,
      { trades: number; profit: number; wins: number; losses: number }
    > = {};
    allTrades.forEach((trade) => {
      const monthKey = trade.date.substring(0, 7); // YYYY-MM

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { trades: 0, profit: 0, wins: 0, losses: 0 };
      }

      monthlyData[monthKey].trades++;
      monthlyData[monthKey].profit += trade.pnl;
      if (trade.outcome === 'TARGET_HIT') monthlyData[monthKey].wins++;
      if (trade.outcome === 'SL_HIT') monthlyData[monthKey].losses++;
    });

    this.logger.log(
      `Backtest complete: ${totalTrades} trades, ${targetHits} wins, ${slHits} losses, Win Rate: ${winRate.toFixed(2)}%, Total P&L: ${totalProfit.toFixed(2)}`,
    );

    return {
      strategy,
      symbol,
      dateRange: { startDate, endDate },
      tradingDays: tradingDays.length,
      summary: {
        totalTrades,
        targetHits,
        slHits,
        openTrades,
        winRate: Math.round(winRate * 100) / 100,
        totalProfit: Math.round(totalProfit * 100) / 100,
        avgProfitPerTrade: Math.round(avgProfitPerTrade * 100) / 100,
      },
      weeklyBreakdown: Object.entries(weeklyData).map(([week, data]) => ({
        week,
        ...data,
        profit: Math.round(data.profit * 100) / 100,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
      })),
      monthlyBreakdown: Object.entries(monthlyData).map(([month, data]) => ({
        month,
        ...data,
        profit: Math.round(data.profit * 100) / 100,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
      })),
      allTrades: allTrades.map((t) => ({
        ...t,
        pnl: Math.round(t.pnl * 100) / 100,
        risk: Math.round(t.risk * 100) / 100,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SIMULATE AUTO TRADE DAY
  // Paper-trade simulation: runs DAY_SELLING full-day scan, applies 2-trade
  // logic with configurable SL pts (default 30) / Target = SL*2 (1:2 RRR), returns P&L.
  // ─────────────────────────────────────────────────────────────────────────────

  async simulateAutoTradeDay(
    brokerId: string,
    targetDate?: string,
    interval:
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute' = 'minute',
    slPts: number = 30,
    mode: 'live' | 'historical' = 'historical',
  ): Promise<any> {
    const date = targetDate || new Date().toISOString().split('T')[0];
    const cap = 2; // max 2 trades per day
    const LOT_SIZE = 75;
    const FIXED_SL_PTS = slPts;
    const FIXED_TARGET_PTS = slPts * 2;

    // ── Broker / KiteConnect ────────────────────────────────────────────────
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });
    if (!broker?.accessToken) {
      throw new Error('Broker not found or access token missing.');
    }
    const kc = new KiteConnect({ api_key: broker.apiKey });
    kc.setAccessToken(broker.accessToken);

    // ── Nearest expiry for the SIMULATED date from the Instrument DB ────────
    // We query our own DB (updated daily) for the nearest NIFTY expiry that
    // is on or after the simulation date.  This automatically handles weekly
    // Tuesday expiries AND monthly expiries without any hard-coded weekday.
    const nextExpiry = await this.getSimulationExpiry(date);
    this.logger.log(
      `[SIM] Resolved expiry for ${date} → ${nextExpiry} (from DB)`,
    );

    // ── Full-day DAY_SELLING scan (NOT realtime — scan all candles) ──────────
    this.logger.log(
      `[SIM] Running full-day DAY_SELLING scan for ${date} expiry=${nextExpiry}`,
    );
    const monitor = await this.optionMonitor(
      brokerId,
      'NIFTY',
      nextExpiry,
      20,
      date,
      interval,
      '15:30',
      'DAY_SELLING',
      false, // realtimeMode
      mode === 'historical' ? 'db' : 'live', // instrumentSource
    );

    // ── Collect & sort all signals across all options ────────────────────────
    const allSignals: Array<{ option: any; signal: any }> = [];
    for (const option of monitor.options || []) {
      for (const signal of option.signals || []) {
        allSignals.push({ option, signal });
      }
    }
    allSignals.sort(
      (a, b) => (a.signal.timestamp || 0) - (b.signal.timestamp || 0),
    );

    this.logger.log(
      `[SIM] Total signals found: ${allSignals.length} across ${monitor.options?.length || 0} options`,
    );

    // ── Pick max N trades (unique option symbol, in chronological order) ─────
    const pickedTrades: Array<{ option: any; signal: any }> = [];
    const usedSymbols = new Set<string>();
    for (const item of allSignals) {
      if (pickedTrades.length >= cap) break;
      if (usedSymbols.has(item.option.tradingsymbol)) continue;
      usedSymbols.add(item.option.tradingsymbol);
      pickedTrades.push(item);
    }

    if (pickedTrades.length === 0) {
      return {
        date,
        expiry: nextExpiry,
        message: 'No signals found for today.',
        trades: [],
        summary: { totalTrades: 0, totalPnl: 0, totalPnlFormatted: '₹0' },
      };
    }

    // ── Simulate each trade ──────────────────────────────────────────────────
    const results: any[] = [];

    for (let tradeIdx = 0; tradeIdx < pickedTrades.length; tradeIdx++) {
      const { option, signal } = pickedTrades[tradeIdx];
      const entry = signal.price as number;
      const sl = Math.round(entry + FIXED_SL_PTS);
      const target = Math.max(Math.round(entry - FIXED_TARGET_PTS), 1);
      const lotSize = option.lotSize || LOT_SIZE;

      // Parse signal time string e.g. "09:35 am" into a JS Date in IST
      const signalDateIST = parseSignalTimeToDate(date, signal.time as string);

      const tradeBase = {
        tradeNo: tradeIdx + 1,
        optionSymbol: option.tradingsymbol,
        strike: option.strike,
        optionType: option.optionType,
        signalTime: signal.time,
        signalReason: signal.reason,
        entry,
        sl,
        target,
        lotSize,
      };

      // ── Fetch 1-min candles from signal time to 15:30 ───────────────────────
      const fromDate = signalDateIST;
      const toDateIST = new Date(date + 'T10:00:00.000Z'); // 15:30 IST = 10:00 UTC
      let exitReason = 'OPEN';
      let exitPrice = entry;
      let exitTime = '15:30 pm';
      // BE state: after T1 hit, SL moves to entry
      let t1HitSim = false;
      let activeSL = sl; // may change to entry after T1

      // If there is a next trade, record its signal arrival time so we close
      // the current trade at ITS OWN candle price at that moment.
      let nextTradeSignalDate: Date | null = null;
      if (tradeIdx < pickedTrades.length - 1) {
        nextTradeSignalDate = parseSignalTimeToDate(
          date,
          pickedTrades[tradeIdx + 1].signal.time as string,
        );
      }

      try {
        const candles: any[] = await kc.getHistoricalData(
          option.instrumentToken,
          interval,
          fromDate,
          toDateIST,
          false,
        );

        this.logger.log(
          `[SIM] Trade ${tradeIdx + 1}: ${option.tradingsymbol} — ${candles.length} candles after signal`,
        );

        // ── Walk candles: SL / Target / BE / Trade-2-replacement ─────────────
        for (const candle of candles) {
          const candleDate = new Date(candle.date);

          // Next trade signal arrives → close this trade at THIS candle's close price
          if (
            nextTradeSignalDate &&
            candleDate >= nextTradeSignalDate &&
            exitReason === 'OPEN'
          ) {
            exitReason = `REPLACED_BY_TRADE_${tradeIdx + 2}`;
            exitPrice = candle.close;
            exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            break;
          }

          // SL hit (or BE hit after T1): option price rises to activeSL
          if (candle.high >= activeSL) {
            exitReason = t1HitSim ? 'BE_HIT' : 'SL_HIT';
            exitPrice = activeSL; // SL price or entry price (for BE)
            exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
            break;
          }

          // Target hit: option price closes at or below target (profit for short seller).
          // Use candle.close not candle.low to avoid false triggers from wick spikes.
          if (candle.close <= target) {
            if (!t1HitSim) {
              // T1 hit — activate BE: move SL to entry, keep trade open
              t1HitSim = true;
              activeSL = entry;
              this.logger.log(
                `[SIM] T1 hit for ${option.tradingsymbol} — BE active, SL moved to entry ${entry}`,
              );
            } else {
              // Already past T1, target hit again means T2 or full target
              exitReason = 'TARGET_HIT';
              exitPrice = target;
              exitTime = new Date(candle.date).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
              });
              break;
            }
          }
        }

        // If still open after full scan:
        // - If last candle is before 15:25 IST AND date is today → market still open, trade is OPEN/RUNNING
        // - Otherwise → market closed, it's a genuine EOD square-off
        if (exitReason === 'OPEN' && candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          const lastCandleDate = new Date(lastCandle.date);
          const lastCandleIST = new Date(
            lastCandleDate.getTime() + 5.5 * 60 * 60 * 1000,
          );
          const lastCandleHour = lastCandleIST.getUTCHours();
          const lastCandleMin = lastCandleIST.getUTCMinutes();
          const isMarketClosed =
            lastCandleHour > 15 ||
            (lastCandleHour === 15 && lastCandleMin >= 25);

          const today = new Date().toISOString().split('T')[0];
          const isToday = date === today;

          if (!isMarketClosed && isToday) {
            // Market still open — trade is running, don't fake an EOD exit
            exitReason = 'OPEN';
            exitPrice = lastCandle.close;
            exitTime = new Date(lastCandle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
          } else {
            // T1 was hit but price never reached BE or T2 → partial profit at T1 + EOD remaining
            exitReason = t1HitSim ? 'T1_EOD' : 'EOD_CLOSE';
            exitPrice = lastCandle.close;
            exitTime = new Date(lastCandle.date).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `[SIM] Failed to fetch candles for ${option.tradingsymbol}: ${err.message}`,
        );
        exitReason = 'DATA_ERROR';
      }

      // ── Compute P&L ─────────────────────────────────────────────────────────
      // If T1 was hit, 50% of qty was exited at T1 price; remainder at exitPrice.
      let pnl: number;
      let pnlPerUnit: number;
      if (t1HitSim) {
        const halfQty = Math.floor(lotSize / 2);
        const remainQty = lotSize - halfQty;
        // Half qty locked at T1 profit; remaining qty exits at current exitPrice
        const t1Profit = (entry - target) * halfQty;
        const remainProfit =
          exitReason === 'BE_HIT'
            ? 0 // exited at entry — zero profit on remainder
            : (entry - exitPrice) * remainQty;
        pnl = Math.round((t1Profit + remainProfit) * 100) / 100;
        // Effective per-unit (for display)
        pnlPerUnit = Math.round((pnl / lotSize) * 100) / 100;
      } else {
        pnlPerUnit = entry - exitPrice; // SELL: profit when option price falls
        pnl = Math.round(pnlPerUnit * lotSize * 100) / 100;
        pnlPerUnit = Math.round(pnlPerUnit * 100) / 100;
      }

      results.push({
        ...tradeBase,
        exitReason,
        exitTime,
        exitPrice,
        pnlPerUnit,
        pnl,
        pnlFormatted: `${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
      });
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const totalPnl =
      Math.round(results.reduce((sum, t) => sum + (t.pnl || 0), 0) * 100) / 100;

    return {
      date,
      expiry: nextExpiry,
      totalSignalsFound: allSignals.length,
      trades: results,
      summary: {
        totalTrades: results.length,
        wins: results.filter((t) => t.pnl > 0).length,
        losses: results.filter((t) => t.pnl < 0).length,
        totalPnl,
        totalPnlFormatted: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}`,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SIMULATE AUTO TRADE RANGE
  // Runs simulateAutoTradeDay for every weekday in [startDate, endDate] and
  // aggregates results into daily / weekly / monthly breakdowns.
  // ─────────────────────────────────────────────────────────────────────────────

  async simulateAutoTradeRange(
    brokerId: string,
    startDate: string,
    endDate: string,
    interval:
      | 'minute'
      | '3minute'
      | '5minute'
      | '10minute'
      | '15minute'
      | '30minute'
      | '60minute' = 'minute',
    slPts: number = 30,
    mode: 'live' | 'historical' = 'historical',
  ): Promise<any> {
    // ── Build list of weekday dates in range ─────────────────────────────────
    const days: string[] = [];
    const cursor = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    while (cursor <= end) {
      const dow = cursor.getUTCDay(); // 0=Sun 6=Sat
      if (dow !== 0 && dow !== 6) {
        days.push(cursor.toISOString().split('T')[0]);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    if (days.length === 0) {
      return {
        startDate,
        endDate,
        days: [],
        weeklyBreakdown: [],
        monthlyBreakdown: [],
        summary: {
          totalDays: 0,
          tradingDays: 0,
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlFormatted: '₹0',
        },
      };
    }

    this.logger.log(
      `[SIM RANGE] Running ${days.length} days from ${startDate} to ${endDate} (interval=${interval}, slPts=${slPts})`,
    );

    // ── Run each day sequentially ─────────────────────────────────────────────
    const dayResults: any[] = [];
    for (const day of days) {
      try {
        const result = await this.simulateAutoTradeDay(
          brokerId,
          day,
          interval,
          slPts,
          mode,
        );
        dayResults.push(result);
        this.logger.log(
          `[SIM RANGE] ${day}: ${result.summary.totalTrades} trades, P&L=${result.summary.totalPnlFormatted}`,
        );
      } catch (err: any) {
        this.logger.warn(`[SIM RANGE] ${day}: failed — ${err.message}`);
        dayResults.push({
          date: day,
          trades: [],
          totalSignalsFound: 0,
          summary: {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalPnl: 0,
            totalPnlFormatted: '₹0',
          },
          error: err.message,
        });
      }
    }

    // ── Weekly aggregation ────────────────────────────────────────────────────
    const weekMap = new Map<
      string,
      { trades: number; wins: number; losses: number; pnl: number }
    >();
    for (const d of dayResults) {
      const dateObj = new Date(d.date + 'T00:00:00Z');
      // ISO week: Mon=1..Sun=7
      const day1 = new Date(Date.UTC(dateObj.getUTCFullYear(), 0, 4));
      const weekNo = Math.ceil(
        ((dateObj.getTime() - day1.getTime()) / 86400000 +
          day1.getUTCDay() +
          1) /
          7,
      );
      const weekKey = `${dateObj.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
      const existing = weekMap.get(weekKey) || {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
      };
      weekMap.set(weekKey, {
        trades: existing.trades + (d.summary.totalTrades || 0),
        wins: existing.wins + (d.summary.wins || 0),
        losses: existing.losses + (d.summary.losses || 0),
        pnl: Math.round((existing.pnl + (d.summary.totalPnl || 0)) * 100) / 100,
      });
    }
    const weeklyBreakdown = Array.from(weekMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, data]) => ({
        week,
        ...data,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
        pnlFormatted: `${data.pnl >= 0 ? '+' : ''}₹${data.pnl.toFixed(2)}`,
      }));

    // ── Monthly aggregation ───────────────────────────────────────────────────
    const monthMap = new Map<
      string,
      {
        days: number;
        trades: number;
        wins: number;
        losses: number;
        pnl: number;
      }
    >();
    for (const d of dayResults) {
      const monthKey = d.date.slice(0, 7); // YYYY-MM
      const existing = monthMap.get(monthKey) || {
        days: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
      };
      monthMap.set(monthKey, {
        days: existing.days + 1,
        trades: existing.trades + (d.summary.totalTrades || 0),
        wins: existing.wins + (d.summary.wins || 0),
        losses: existing.losses + (d.summary.losses || 0),
        pnl: Math.round((existing.pnl + (d.summary.totalPnl || 0)) * 100) / 100,
      });
    }
    const monthlyBreakdown = Array.from(monthMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, data]) => ({
        month,
        monthLabel: new Date(month + '-01').toLocaleDateString('en-IN', {
          month: 'long',
          year: 'numeric',
        }),
        ...data,
        winRate:
          data.trades > 0
            ? Math.round((data.wins / data.trades) * 10000) / 100
            : 0,
        pnlFormatted: `${data.pnl >= 0 ? '+' : ''}₹${data.pnl.toFixed(2)}`,
      }));

    // ── Overall summary ───────────────────────────────────────────────────────
    const totalTrades = dayResults.reduce(
      (s, d) => s + (d.summary.totalTrades || 0),
      0,
    );
    const totalWins = dayResults.reduce((s, d) => s + (d.summary.wins || 0), 0);
    const totalLosses = dayResults.reduce(
      (s, d) => s + (d.summary.losses || 0),
      0,
    );
    const totalPnl =
      Math.round(
        dayResults.reduce((s, d) => s + (d.summary.totalPnl || 0), 0) * 100,
      ) / 100;
    const tradingDays = dayResults.filter(
      (d) => d.summary.totalTrades > 0,
    ).length;

    // Max single-day drawdown
    const maxDayLoss = Math.min(
      ...dayResults.map((d) => d.summary.totalPnl || 0),
      0,
    );

    return {
      startDate,
      endDate,
      days: dayResults,
      weeklyBreakdown,
      monthlyBreakdown,
      summary: {
        totalDays: days.length,
        tradingDays,
        totalTrades,
        wins: totalWins,
        losses: totalLosses,
        winRate:
          totalTrades > 0
            ? Math.round((totalWins / totalTrades) * 10000) / 100
            : 0,
        totalPnl,
        totalPnlFormatted: `${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(2)}`,
        maxDayLoss: Math.round(maxDayLoss * 100) / 100,
        avgPnlPerTradingDay:
          tradingDays > 0
            ? Math.round((totalPnl / tradingDays) * 100) / 100
            : 0,
      },
    };
  }
}

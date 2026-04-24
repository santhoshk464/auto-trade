/**
 * NIFTY Futures Trend Filter
 *
 * Before firing a CE/PE sell signal, this helper fetches NIFTY Futures 5m candles
 * and checks three indicators for trend confirmation:
 *   1. SuperTrend (10, 2)
 *   2. VWAP
 *   3. VWMA (20)
 *
 * Trend is UP  when price is ABOVE all three → CE sell blocked, PE sell allowed.
 * Trend is DOWN when price is BELOW all three → CE sell allowed, PE sell blocked.
 * SIDEWAYS when indicators disagree or volume is low → signal blocked.
 *
 * Volume gate: the 1-minute futures candle at signal time must have volume > 120,000.
 * Low-volume candles are treated as SIDEWAYS regardless of indicators.
 *
 * Usage:
 *   const trend = await checkNiftyFuturesTrend({ kc, prisma, signalTime, optionType });
 *   if (!trend.aligned) { skip signal; }
 */

import { PrismaClient } from '@prisma/client';
import type { KiteConnect } from 'kiteconnect';

// kiteconnect's KiteConnect constructor returns a Connect instance.
// Using `any` here avoids the type mismatch between class and instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KiteInstance = any;

export type NiftyTrend = 'UP' | 'DOWN' | 'SIDEWAYS';

export interface NiftyTrendResult {
  /** Whether the trend aligns with the signal direction */
  aligned: boolean;
  /** Derived trend direction */
  trend: NiftyTrend;
  /** Human-readable reason (for logging) */
  reason: string;
  /** Raw indicator values at the signal candle */
  indicators?: {
    close: number;
    superTrend: number;
    superTrendDir: 'UP' | 'DOWN';
    vwap: number;
    vwma20: number;
    volume1m: number;
  };
}

interface CheckNiftyTrendOptions {
  /** KiteConnect instance (authenticated) */
  kc: KiteInstance;
  /** Prisma client for DB instrument lookup */
  prisma: PrismaClient;
  /** Symbol — NIFTY, BANKNIFTY, FINNIFTY (used to look up nearest futures contract) */
  symbol: string;
  /**
   * The signal candle's date string "YYYY-MM-DD" — used to look up the
   * nearest futures expiry and to bound the 5m candle fetch.
   */
  date: string;
  /**
   * The signal candle's UTC timestamp (ms) — used to find the 5m candle
   * bucket that contains the signal, and the 1m volume candle.
   */
  signalTimestampMs: number;
  /** CE or PE — determines which direction is "aligned" */
  optionType: 'CE' | 'PE';
  /** Volume threshold on 1m futures candle. Default 120000. */
  minVolume?: number;
}

// ─── SuperTrend (10, 2) ───────────────────────────────────────────────────────

interface Candle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

function calcSuperTrend(
  candles: Candle[],
  period = 10,
  multiplier = 2,
): Array<{ value: number; direction: 'UP' | 'DOWN' }> {
  const result: Array<{ value: number; direction: 'UP' | 'DOWN' }> = [];

  // ATR via Wilder smoothing
  let prevATR = 0;
  const atrs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    if (i < period) {
      atrs.push(tr);
      if (i === period - 1) {
        prevATR = atrs.reduce((a, b) => a + b, 0) / period;
      }
    } else {
      prevATR = (prevATR * (period - 1) + tr) / period;
    }
    atrs.push(prevATR);
  }

  let prevUpper = 0;
  let prevLower = 0;
  let prevDir: 'UP' | 'DOWN' = 'DOWN';
  let prevST = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push({ value: candles[i].close, direction: 'DOWN' });
      continue;
    }

    const c = candles[i];
    const atr = atrs[i];
    const hl2 = (c.high + c.low) / 2;
    let upperBand = hl2 + multiplier * atr;
    let lowerBand = hl2 - multiplier * atr;

    // Clamp bands
    if (i > 0) {
      if (lowerBand < prevLower || candles[i - 1].close < prevLower) {
        // keep prevLower if price was below
      } else {
        lowerBand = Math.max(lowerBand, prevLower);
      }
      if (upperBand > prevUpper || candles[i - 1].close > prevUpper) {
        // keep prevUpper if price was above
      } else {
        upperBand = Math.min(upperBand, prevUpper);
      }
    }

    let dir: 'UP' | 'DOWN';
    let st: number;

    if (prevDir === 'DOWN') {
      if (c.close <= prevST) {
        dir = 'DOWN';
        st = upperBand;
      } else {
        dir = 'UP';
        st = lowerBand;
      }
    } else {
      if (c.close >= prevST) {
        dir = 'UP';
        st = lowerBand;
      } else {
        dir = 'DOWN';
        st = upperBand;
      }
    }

    prevUpper = upperBand;
    prevLower = lowerBand;
    prevDir = dir;
    prevST = st;

    result.push({ value: st, direction: dir });
  }

  return result;
}

// ─── VWAP ────────────────────────────────────────────────────────────────────

function calcVWAP(candles: Array<Candle & { date: Date }>): number[] {
  // Reset at session open (09:15 IST each day)
  const vwaps: number[] = [];
  let cumTPV = 0;
  let cumVol = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    vwaps.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  return vwaps;
}

// ─── VWMA (20) ───────────────────────────────────────────────────────────────

function calcVWMA(candles: Candle[], period = 20): number[] {
  return candles.map((_, i) => {
    if (i < period - 1) return candles[i].close;
    const slice = candles.slice(i - period + 1, i + 1);
    const num = slice.reduce((s, c) => s + c.close * c.volume, 0);
    const den = slice.reduce((s, c) => s + c.volume, 0);
    return den > 0 ? num / den : candles[i].close;
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function checkNiftyFuturesTrend(
  opts: CheckNiftyTrendOptions,
): Promise<NiftyTrendResult> {
  const {
    kc,
    prisma,
    symbol,
    date,
    signalTimestampMs,
    optionType,
    minVolume = 120_000,
  } = opts;

  const SIDEWAYS: NiftyTrendResult = {
    aligned: false,
    trend: 'SIDEWAYS',
    reason: '',
  };

  try {
    // 1. Find the nearest futures contract for this symbol on this date
    const futInstrument = await prisma.instrument.findFirst({
      where: {
        name: symbol,
        instrumentType: 'FUT',
        segment: symbol === 'SENSEX' ? 'BFO-FUT' : 'NFO-FUT',
        expiry: { not: null, gte: date },
      },
      orderBy: { expiry: 'asc' },
    });

    if (!futInstrument) {
      return {
        aligned: true,
        trend: 'SIDEWAYS',
        reason: `No ${symbol} futures contract found in DB for ${date} — trend filter bypassed, signal allowed`,
      };
    }

    // 2. Fetch 5m candles for the session up to signal time
    const todayFrom = `${date} 09:15:00`;
    const signalDate = new Date(signalTimestampMs);
    const hh = String(signalDate.getHours()).padStart(2, '0');
    const mm = String(signalDate.getMinutes()).padStart(2, '0');
    const todayTo = `${date} ${hh}:${mm}:59`;

    const raw5m = await kc.getHistoricalData(
      futInstrument.instrumentToken,
      '5minute',
      todayFrom,
      todayTo,
    );

    if (!raw5m || raw5m.length < 15) {
      return {
        aligned: true,
        trend: 'SIDEWAYS',
        reason: `Not enough 5m futures candles (got ${raw5m?.length ?? 0}) — trend filter bypassed, signal allowed`,
      };
    }

    const candles5m = raw5m.map((c: any) => ({
      date: new Date(c.date),
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));

    // 3. Calculate indicators on the last candle
    const last = candles5m[candles5m.length - 1];
    const stResults = calcSuperTrend(candles5m, 10, 2);
    const vwaps = calcVWAP(candles5m);
    const vwmas = calcVWMA(candles5m, 20);

    const lastIdx = candles5m.length - 1;
    const st = stResults[lastIdx];
    const vwap = vwaps[lastIdx];
    const vwma = vwmas[lastIdx];
    const price = last.close;

    // 4. Fetch 1m candle at signal time for volume gate
    const from1m = `${date} ${hh}:${mm}:00`;
    const to1m = `${date} ${hh}:${mm}:59`;
    const raw1m = await kc.getHistoricalData(
      futInstrument.instrumentToken,
      'minute',
      from1m,
      to1m,
    );
    const vol1m =
      raw1m && raw1m.length > 0 ? (raw1m[raw1m.length - 1].volume ?? 0) : 0;

    // 5. Volume gate
    if (vol1m < minVolume) {
      return {
        aligned: false,
        trend: 'SIDEWAYS',
        reason: `1m futures volume ${vol1m} < ${minVolume} — low-volume candle, trend inconclusive`,
        indicators: {
          close: price,
          superTrend: st.value,
          superTrendDir: st.direction,
          vwap,
          vwma20: vwma,
          volume1m: vol1m,
        },
      };
    }

    // 6. Determine trend: all 3 must agree
    const aboveST = price > st.value && st.direction === 'UP';
    const aboveVWAP = price > vwap;
    const aboveVWMA = price > vwma;

    const bullCount = [aboveST, aboveVWAP, aboveVWMA].filter(Boolean).length;
    const bearCount = [!aboveST, !aboveVWAP, !aboveVWMA].filter(Boolean).length;

    let trend: NiftyTrend;
    if (bullCount === 3) {
      trend = 'UP';
    } else if (bearCount === 3) {
      trend = 'DOWN';
    } else {
      trend = 'SIDEWAYS';
    }

    // 7. Alignment check
    // CE sell → needs DOWN trend (price falling, CE should lose value)
    // PE sell → needs UP trend (price rising, PE should lose value)
    const aligned =
      (optionType === 'CE' && trend === 'DOWN') ||
      (optionType === 'PE' && trend === 'UP');

    const reasonParts = [
      `${symbol} Futures ${futInstrument.tradingsymbol}`,
      `close=${price.toFixed(1)}`,
      `ST=${st.value.toFixed(1)}(${st.direction})`,
      `VWAP=${vwap.toFixed(1)}`,
      `VWMA20=${vwma.toFixed(1)}`,
      `vol1m=${vol1m}`,
      `trend=${trend}`,
      aligned
        ? `✓ aligned for ${optionType} SELL`
        : `✗ not aligned for ${optionType} SELL`,
    ];

    return {
      aligned,
      trend,
      reason: reasonParts.join(' | '),
      indicators: {
        close: price,
        superTrend: st.value,
        superTrendDir: st.direction,
        vwap,
        vwma20: vwma,
        volume1m: vol1m,
      },
    };
  } catch (err: any) {
    return {
      aligned: true,
      trend: 'SIDEWAYS',
      reason: `NiftyTrendFilter error: ${err?.message ?? err} — trend filter bypassed, signal allowed`,
    };
  }
}

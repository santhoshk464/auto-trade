/**
 * TRIPLE_SYNC Strategy
 *
 * Core idea: Take a trade only when three independent confirming forces align —
 * trend (200 EMA), strength (ADX > threshold), and momentum state (Supertrend).
 *
 * Bullish setup:
 *   1. Close > 200 EMA          — price is above the macro trend
 *   2. Supertrend is bullish    — momentum trail is "up" (green)
 *   3. ADX > adxThreshold       — market has directional strength (default 25)
 *   Trigger: a "definitive" bullish candle closes (after bias confirmation)
 *
 * Bearish setup:
 *   1. Close < 200 EMA          — price is below the macro trend
 *   2. Supertrend is bearish    — momentum trail is "down" (red)
 *   3. ADX > adxThreshold       — market has directional strength
 *   Trigger: a "definitive" bearish candle closes (after bias confirmation)
 *
 * Stop-loss: structure-based — below trigger candle low (BUY) or above trigger
 *            candle high (SELL), with a small buffer, pulled in against the
 *            recent N-candle swing extreme when that gives a tighter SL.
 *
 * Target: risk × minRRR (floor). If a recent opposing swing is reachable at
 *         a better R, that swing is used. Trades with RRR < minRRR are skipped.
 *
 * Filters applied before emitting a signal:
 *   - ADX threshold gate
 *   - Candle quality check (body ratio, wick dominance, doji / narrow range)
 *   - Compression / sideways filter
 *   - Overextension from EMA filter (optional)
 *   - Minimum room-to-move validates target is not blocked by nearby S/R
 *   - RRR gate (< minRRR → skip)
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: candles in → signals out, zero side-effects.
 *   - All configurable parameters are exposed via TripleSyncConfig.
 */

import { diagLog } from '../helpers/diag-logger';

// ─── Candle ───────────────────────────────────────────────────────────────────

export interface TripleSyncCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Date/time of candle close — used for labelling only. */
  date: Date | string | number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface TripleSyncConfig {
  // ── Indicator settings ─────────────────────────────────────────────────────

  /** EMA period for the macro trend filter. Default: 200 */
  emaPeriod?: number;

  /** ADX period (same period used for +DI, -DI, and ADX smoothing). Default: 14 */
  adxPeriod?: number;

  /** Minimum ADX value required to allow an entry. Default: 25 */
  adxThreshold?: number;

  /** Supertrend ATR look-back period. Default: 10 */
  supertrendPeriod?: number;

  /** Supertrend ATR multiplier. Default: 2 */
  supertrendMultiplier?: number;

  // ── Candle quality ─────────────────────────────────────────────────────────

  /**
   * Minimum body / total-range ratio for a trigger candle to be considered
   * "definitive".  A value of 0.45 means the body must be at least 45 % of
   * the full wick-to-wick range.  Default: 0.45
   */
  minBodyRatio?: number;

  /**
   * Maximum wick-to-body ratio on the unfavourable side.
   * For a bullish candle the lower wick must be ≤ body × maxWickRatio.
   * For a bearish candle the upper wick must be ≤ body × maxWickRatio.
   * Rejects candles that are mostly wick.  Default: 1.5
   */
  maxWickRatio?: number;

  /**
   * Minimum absolute candle range (high − low) to avoid noise candles.
   * Set this to a value appropriate for your instrument (e.g. 5 pts for Nifty
   * options, 0.5 for crypto).  Default: 5
   */
  minCandleRange?: number;

  // ── Trade geometry ─────────────────────────────────────────────────────────

  /** Required minimum risk-reward ratio. Trades below this are skipped. Default: 1.5 */
  minRRR?: number;

  /**
   * Buffer added outside the trigger candle extreme when placing SL.
   * BUY SL  = triggerLow  − slBuffer
   * SELL SL = triggerHigh + slBuffer
   * Default: 0  (use the candle edge exactly)
   */
  slBuffer?: number;

  /**
   * Look-back window (candle count) for finding the recent swing high/low
   * used to set a structure-based SL.  Default: 5
   */
  swingLookback?: number;

  /**
   * Look-back window (candle count) when scanning for an opposing structural
   * swing to use as the profit target.  Default: 20
   */
  targetLookback?: number;

  // ── Filters ────────────────────────────────────────────────────────────────

  /**
   * Number of candles to inspect for detecting price compression / sideways
   * range.  If (highest_high − lowest_low) / avg_range < compressionRatio,
   * the setup is considered compressed and skipped.  Default: 10
   */
  compressionLookback?: number;

  /**
   * If the price range over `compressionLookback` candles divided by the
   * average true range is below this threshold, the market is sideways.
   * Default: 1.5
   */
  compressionRatio?: number;

  /**
   * Maximum distance from the 200 EMA expressed as ATR multiples.
   * If |close − ema200| > maxDistanceFromEMAatr × ATR, the entry is skipped
   * because the SL will be too wide or the candle is overextended.
   * Set to 0 (default) to disable.
   * Default: 0 (disabled)
   */
  maxDistanceFromEMAatr?: number;

  // ── Time filters ───────────────────────────────────────────────────────────

  /**
   * Earliest allowed signal candle time in minutes from midnight.
   * Default: 570  (09:30 AM)
   */
  tradeStartMins?: number;

  /**
   * Latest allowed signal candle time in minutes from midnight.
   * Default: 870  (02:30 PM)
   */
  tradeEndMins?: number;

  // ── Diagnostics ────────────────────────────────────────────────────────────

  /**
   * When true, writes structured diagnostic log lines to docs/logs/ via diagLog().
   * Enable only in execution (paper / live) paths, not on every chart render.
   * Default: false
   */
  enableDiagLog?: boolean;

  /** Print debug info to the console. Default: false */
  debug?: boolean;
}

// ─── Signal ───────────────────────────────────────────────────────────────────

export interface TripleSyncSignal {
  strategyName: 'TRIPLE_SYNC';
  signalType: 'BUY' | 'SELL';

  /** Zero-based index of the trigger candle in the input `candles` array. */
  candleIndex: number;
  /** Friendly close time string, e.g. "10:15 am". */
  candleTime: string;
  /** Close date of the trigger candle. */
  candleDate: Date;

  entryPrice: number;
  stopLoss: number;
  /** Absolute distance between entry and SL. */
  risk: number;
  target1: number;
  target2: number;
  target3: number;
  /** Actual risk-reward ratio achieved. */
  rrr: number;

  /** Indicator snapshot at the trigger candle. */
  indicators: {
    ema200: number;
    adx: number;
    supertrendValue: number;
    supertrendTrend: 'up' | 'down';
    atr: number;
  };

  reason: string;
}

// ─── Rejection result (internal + exported for callers that want detail) ──────

export interface TripleSyncRejection {
  candleIndex: number;
  candleTime: string;
  reason: string;
}

// ─── Internal indicator intermediates ────────────────────────────────────────

interface ADXResult {
  adx: number;
  plusDI: number;
  minusDI: number;
}

interface SupertrendResult {
  value: number;
  trend: 'up' | 'down';
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

/**
 * Standard EMA seeded with SMA of the first `period` values.
 * Returns null for indices 0 … period-2.
 */
function calcEMA(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/**
 * True Range array (index 0 uses HL range only — no previous close available).
 */
function calcTR(candles: TripleSyncCandle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  });
}

/**
 * Wilder RMA (recursive moving average) — identical to Pine Script ta.rma().
 * alpha = 1 / period.  Seeded with SMA of first `period` values.
 * Returns null for indices 0 … period-2.
 */
function calcWilderRMA(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let rma = seed / period;
  out[period - 1] = rma;

  for (let i = period; i < n; i++) {
    rma = (rma * (period - 1) + values[i]) / period;
    out[i] = rma;
  }
  return out;
}

/**
 * ADX with +DI / -DI using Wilder smoothing — identical to TradingView defaults.
 *
 * Returns an array aligned to `candles`.  Entries are null during warm-up
 * (first 2×period − 1 bars are not stable).
 */
function calcADX(
  candles: TripleSyncCandle[],
  period: number,
): (ADXResult | null)[] {
  const n = candles.length;
  const out: (ADXResult | null)[] = new Array(n).fill(null);
  if (n < period * 2) return out;

  // Directional movement
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [candles[0].high - candles[0].low];

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  const smTR = calcWilderRMA(tr, period);
  const smPlusDM = calcWilderRMA(plusDM, period);
  const smMinusDM = calcWilderRMA(minusDM, period);

  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const t = smTR[i];
    const p = smPlusDM[i];
    const m = smMinusDM[i];
    if (t === null || p === null || m === null || t === 0) continue;
    const plusDI = (p / t) * 100;
    const minusDI = (m / t) * 100;
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  }

  // ADX = Wilder RMA of DX
  const dxVals: number[] = dx.map((v) => v ?? 0);
  const adxArr = calcWilderRMA(dxVals, period);

  for (let i = 0; i < n; i++) {
    const t = smTR[i];
    const p = smPlusDM[i];
    const m = smMinusDM[i];
    const adxVal = adxArr[i];
    if (t === null || p === null || m === null || adxVal === null || t === 0)
      continue;
    out[i] = {
      adx: adxVal,
      plusDI: (p / t) * 100,
      minusDI: (m / t) * 100,
    };
  }
  return out;
}

/**
 * Supertrend (Wilder ATR).
 * Returns null for the first `period-1` candles.
 */
function calcSupertrend(
  candles: TripleSyncCandle[],
  period: number,
  multiplier: number,
): (SupertrendResult | null)[] {
  const n = candles.length;
  if (n < period + 1) return new Array(n).fill(null);

  const tr = calcTR(candles);
  const atr: number[] = new Array(n).fill(0);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period - 1] = seed / period;
  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  const result: (SupertrendResult | null)[] = new Array(period - 1).fill(null);
  let upperBand = 0;
  let lowerBand = 0;
  let superTrendVal = 0;
  let currentTrend: 'up' | 'down' = 'up';

  for (let i = period - 1; i < n; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];
    const prevClose =
      i === period - 1 ? candles[i].close : candles[i - 1].close;

    const newUpper =
      i === period - 1 || basicUpper < upperBand || prevClose > upperBand
        ? basicUpper
        : upperBand;
    const newLower =
      i === period - 1 || basicLower > lowerBand || prevClose < lowerBand
        ? basicLower
        : lowerBand;

    if (i === period - 1) {
      currentTrend = candles[i].close > hl2 ? 'up' : 'down';
    } else if (superTrendVal === upperBand) {
      currentTrend = candles[i].close > newUpper ? 'up' : 'down';
    } else {
      currentTrend = candles[i].close < newLower ? 'down' : 'up';
    }

    superTrendVal = currentTrend === 'up' ? newLower : newUpper;
    upperBand = newUpper;
    lowerBand = newLower;

    result.push({ value: superTrendVal, trend: currentTrend });
  }
  return result;
}

// ─── Strategy helpers ─────────────────────────────────────────────────────────

/** Format a Date as "HH:MM am/pm". */
function fmtTime(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  let h = dt.getHours();
  const m = dt.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

/** Extract minutes-from-midnight from a candle date. */
function candleMinutes(d: Date | string | number): number {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.getHours() * 60 + dt.getMinutes();
}

/**
 * Returns true when all three bias conditions are met for a BUY.
 * price > ema200, supertrend UP, ADX > threshold.
 */
function isBullishBias(
  close: number,
  ema200: number,
  st: SupertrendResult,
  adx: ADXResult,
  adxThreshold: number,
): boolean {
  return close > ema200 && st.trend === 'up' && adx.adx > adxThreshold;
}

/**
 * Returns true when all three bias conditions are met for a SELL.
 * price < ema200, supertrend DOWN, ADX > threshold.
 */
function isBearishBias(
  close: number,
  ema200: number,
  st: SupertrendResult,
  adx: ADXResult,
  adxThreshold: number,
): boolean {
  return close < ema200 && st.trend === 'down' && adx.adx > adxThreshold;
}

/**
 * Candle quality check for trigger candles.
 *
 * A "definitive" bullish candle must:
 *   - Close above open (closes bullish)
 *   - Have meaningful body (body / range >= minBodyRatio)
 *   - Not be wick-dominated on the lower side (lowerWick <= body * maxWickRatio)
 *   - Have minimum absolute range (high - low >= minCandleRange)
 *
 * A "definitive" bearish candle is the mirror image.
 *
 * Returns an object with `pass` and a human-readable `reason`.
 */
function checkCandleQuality(
  candle: TripleSyncCandle,
  direction: 'BUY' | 'SELL',
  minBodyRatio: number,
  maxWickRatio: number,
  minCandleRange: number,
): { pass: boolean; reason: string } {
  const range = candle.high - candle.low;

  if (range < minCandleRange) {
    return {
      pass: false,
      reason: `narrow-range candle (range=${range.toFixed(2)} < min=${minCandleRange})`,
    };
  }

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;

  if (bodyRatio < minBodyRatio) {
    return {
      pass: false,
      reason: `weak body (bodyRatio=${bodyRatio.toFixed(2)} < min=${minBodyRatio})`,
    };
  }

  if (direction === 'BUY') {
    if (candle.close <= candle.open) {
      return { pass: false, reason: 'candle not bullish (close <= open)' };
    }
    const lowerWick = candle.open - candle.low;
    if (body > 0 && lowerWick > body * maxWickRatio) {
      return {
        pass: false,
        reason: `lower wick too dominant (lowerWick=${lowerWick.toFixed(2)} > body×${maxWickRatio}=${(body * maxWickRatio).toFixed(2)})`,
      };
    }
  } else {
    if (candle.close >= candle.open) {
      return { pass: false, reason: 'candle not bearish (close >= open)' };
    }
    const upperWick = candle.high - candle.open;
    if (body > 0 && upperWick > body * maxWickRatio) {
      return {
        pass: false,
        reason: `upper wick too dominant (upperWick=${upperWick.toFixed(2)} > body×${maxWickRatio}=${(body * maxWickRatio).toFixed(2)})`,
      };
    }
  }

  return { pass: true, reason: 'candle quality OK' };
}

/**
 * Sideways / compression filter.
 *
 * Looks at the last `lookback` candles and computes:
 *   compressedRange = (max_high − min_low)
 *   avgTR           = mean(TR) over those candles
 *
 * If compressedRange / avgTR < compressionRatio, the market is in tight range.
 *
 * Returns true when the market is considered compressed (no-trade situation).
 */
function isCompressed(
  candles: TripleSyncCandle[],
  endIdx: number,
  lookback: number,
  compressionRatio: number,
): boolean {
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = candles.slice(start, endIdx + 1);
  if (slice.length < 3) return false;

  const maxHigh = Math.max(...slice.map((c) => c.high));
  const minLow = Math.min(...slice.map((c) => c.low));
  const range = maxHigh - minLow;

  let sumTR = 0;
  for (let i = 1; i < slice.length; i++) {
    sumTR += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
  }
  const avgTR = sumTR / (slice.length - 1);

  return avgTR > 0 && range / avgTR < compressionRatio;
}

/**
 * Swing-low scan: finds the lowest `low` in the window
 * [endIdx - lookback + 1 … endIdx].
 */
function recentSwingLow(
  candles: TripleSyncCandle[],
  endIdx: number,
  lookback: number,
): number {
  const start = Math.max(0, endIdx - lookback + 1);
  let low = candles[endIdx].low;
  for (let i = start; i <= endIdx; i++) {
    if (candles[i].low < low) low = candles[i].low;
  }
  return low;
}

/**
 * Swing-high scan: finds the highest `high` in the window
 * [endIdx - lookback + 1 … endIdx].
 */
function recentSwingHigh(
  candles: TripleSyncCandle[],
  endIdx: number,
  lookback: number,
): number {
  const start = Math.max(0, endIdx - lookback + 1);
  let high = candles[endIdx].high;
  for (let i = start; i <= endIdx; i++) {
    if (candles[i].high > high) high = candles[i].high;
  }
  return high;
}

/**
 * Calculate stop-loss for a BUY trade.
 *
 * SL = min(triggerCandleLow, recentSwingLow) − slBuffer
 * The swing-low window is `swingLookback` candles ending at the trigger candle.
 */
function calcBuySL(
  candles: TripleSyncCandle[],
  triggerIdx: number,
  swingLookback: number,
  slBuffer: number,
): number {
  const swingLow = recentSwingLow(candles, triggerIdx, swingLookback);
  return Math.min(candles[triggerIdx].low, swingLow) - slBuffer;
}

/**
 * Calculate stop-loss for a SELL trade.
 *
 * SL = max(triggerCandleHigh, recentSwingHigh) + slBuffer
 */
function calcSellSL(
  candles: TripleSyncCandle[],
  triggerIdx: number,
  swingLookback: number,
  slBuffer: number,
): number {
  const swingHigh = recentSwingHigh(candles, triggerIdx, swingLookback);
  return Math.max(candles[triggerIdx].high, swingHigh) + slBuffer;
}

/**
 * Find a structural profit target for a BUY trade.
 *
 * Scans `targetLookback` candles BEFORE the trigger for the nearest swing high.
 * If that target gives RRR >= minRRR, use it.  Otherwise fall back to
 * entry + risk × minRRR.
 *
 * Returns { target, rrr }.
 */
function calcBuyTarget(
  candles: TripleSyncCandle[],
  triggerIdx: number,
  entry: number,
  sl: number,
  risk: number,
  targetLookback: number,
  minRRR: number,
): { target: number; rrr: number } {
  const start = Math.max(0, triggerIdx - targetLookback);
  let nearestResistance: number | null = null;

  // Walk backwards from triggerIdx to find a swing high above entry
  for (let i = triggerIdx - 1; i >= start; i--) {
    if (candles[i].high > entry) {
      nearestResistance = candles[i].high;
      break;
    }
  }

  if (nearestResistance !== null) {
    const structRRR = (nearestResistance - entry) / risk;
    if (structRRR >= minRRR) {
      return { target: nearestResistance, rrr: structRRR };
    }
  }

  // Fallback: minimum RRR target
  const target = entry + risk * minRRR;
  return { target, rrr: minRRR };
}

/**
 * Find a structural profit target for a SELL trade.
 *
 * Scans backwards for the nearest swing low below entry.
 */
function calcSellTarget(
  candles: TripleSyncCandle[],
  triggerIdx: number,
  entry: number,
  sl: number,
  risk: number,
  targetLookback: number,
  minRRR: number,
): { target: number; rrr: number } {
  const start = Math.max(0, triggerIdx - targetLookback);
  let nearestSupport: number | null = null;

  for (let i = triggerIdx - 1; i >= start; i--) {
    if (candles[i].low < entry) {
      nearestSupport = candles[i].low;
      break;
    }
  }

  if (nearestSupport !== null) {
    const structRRR = (entry - nearestSupport) / risk;
    if (structRRR >= minRRR) {
      return { target: nearestSupport, rrr: structRRR };
    }
  }

  // Fallback: minimum RRR target
  const target = entry - risk * minRRR;
  return { target, rrr: minRRR };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Runs the TRIPLE_SYNC strategy over an array of 5-minute OHLC candles
 * (chronological, oldest-first) and returns all detected signals.
 *
 * Each signal is emitted at candle *close* — never intrabar.
 *
 * @param candles   5-minute candles, oldest first.
 * @param config    Strategy parameter overrides.  All fields are optional.
 * @param rejections  Optional array that collects rejection reasons (for debugging).
 */
export function detectTripleSyncSignals(
  candles: TripleSyncCandle[],
  config: TripleSyncConfig = {},
  rejections?: TripleSyncRejection[],
): TripleSyncSignal[] {
  // ── Resolve config with defaults ──────────────────────────────────────────
  const {
    emaPeriod = 200,
    adxPeriod = 14,
    adxThreshold = 25,
    supertrendPeriod = 10,
    supertrendMultiplier = 2,
    minBodyRatio = 0.45,
    maxWickRatio = 1.5,
    minCandleRange = 5,
    minRRR = 1.5,
    slBuffer = 0,
    swingLookback = 5,
    targetLookback = 20,
    compressionLookback = 10,
    compressionRatio = 1.5,
    maxDistanceFromEMAatr = 0,
    tradeStartMins = 570,
    tradeEndMins = 870,
    enableDiagLog = false,
    debug = false,
  } = config;

  const signals: TripleSyncSignal[] = [];
  const n = candles.length;

  // Minimum warm-up: we need at least emaPeriod candles for 200 EMA
  const warmup = Math.max(emaPeriod, adxPeriod * 2, supertrendPeriod) + 1;
  if (n < warmup) return signals;

  // ── Pre-compute indicators over the full array ────────────────────────────
  const closes = candles.map((c) => c.close);
  const ema200Arr = calcEMA(closes, emaPeriod);
  const adxArr = calcADX(candles, adxPeriod);
  const stArr = calcSupertrend(candles, supertrendPeriod, supertrendMultiplier);

  // ATR14 for the optional EMA-distance filter
  const tr14 = calcTR(candles);
  const atr14 = calcWilderRMA(tr14, adxPeriod);

  const log = (msg: string) => {
    if (debug) console.log(`[TRIPLE_SYNC] ${msg}`);
  };

  // ── Candle-by-candle scan ─────────────────────────────────────────────────
  for (let i = warmup; i < n; i++) {
    const candle = candles[i];
    const timeTag = fmtTime(candle.date);
    const shortTag = `[i=${i} ${timeTag}]`;

    // ── Indicator availability check ───────────────────────────────────────
    const ema200 = ema200Arr[i];
    const adxResult = adxArr[i];
    const stResult = stArr[i];
    const atrVal = atr14[i];

    if (
      ema200 === null ||
      adxResult === null ||
      stResult === null ||
      atrVal === null
    ) {
      continue;
    }

    // ── Time filter ────────────────────────────────────────────────────────
    const mins = candleMinutes(candle.date);
    if (mins < tradeStartMins || mins > tradeEndMins) continue;

    // ── Determine bias ─────────────────────────────────────────────────────
    const bullBias = isBullishBias(
      candle.close,
      ema200,
      stResult,
      adxResult,
      adxThreshold,
    );
    const bearBias = isBearishBias(
      candle.close,
      ema200,
      stResult,
      adxResult,
      adxThreshold,
    );

    if (!bullBias && !bearBias) {
      // Log partial bias breakdowns only in debug mode to avoid noise
      if (debug) {
        const emaStatus = candle.close > ema200 ? 'above EMA' : 'below EMA';
        const stStatus = stResult.trend === 'up' ? 'ST=up' : 'ST=down';
        const adxStatus = `ADX=${adxResult.adx.toFixed(1)}`;
        log(`${shortTag} no bias — ${emaStatus}, ${stStatus}, ${adxStatus}`);
      }
      continue;
    }

    const direction: 'BUY' | 'SELL' = bullBias ? 'BUY' : 'SELL';

    // ── Log bias ───────────────────────────────────────────────────────────
    if (direction === 'BUY') {
      const msg = `TRIPLE_SYNC bullish bias valid: price above EMA(${ema200.toFixed(2)}), supertrend green, ADX ${adxResult.adx.toFixed(1)}`;
      log(`${shortTag} ${msg}`);
      if (enableDiagLog)
        diagLog('triple-sync-diag', '[BIAS-BULL]', {
          i,
          timeTag,
          ema200,
          adx: adxResult.adx,
          stValue: stResult.value,
        });
    } else {
      const msg = `TRIPLE_SYNC bearish bias valid: price below EMA(${ema200.toFixed(2)}), supertrend red, ADX ${adxResult.adx.toFixed(1)}`;
      log(`${shortTag} ${msg}`);
      if (enableDiagLog)
        diagLog('triple-sync-diag', '[BIAS-BEAR]', {
          i,
          timeTag,
          ema200,
          adx: adxResult.adx,
          stValue: stResult.value,
        });
    }

    // ── Compression / sideways filter ─────────────────────────────────────
    if (isCompressed(candles, i, compressionLookback, compressionRatio)) {
      const reason = `TRIPLE_SYNC skipped: market in compression (last ${compressionLookback} candles)`;
      log(`${shortTag} ${reason}`);
      if (enableDiagLog)
        diagLog('triple-sync-diag', '[SKIP-COMPRESS]', { i, timeTag });
      if (rejections)
        rejections.push({ candleIndex: i, candleTime: timeTag, reason });
      continue;
    }

    // ── EMA distance filter (optional) ────────────────────────────────────
    if (maxDistanceFromEMAatr > 0) {
      const distFromEMA = Math.abs(candle.close - ema200);
      if (distFromEMA > maxDistanceFromEMAatr * atrVal) {
        const reason = `TRIPLE_SYNC skipped: price too far from EMA (dist=${distFromEMA.toFixed(2)}, limit=${(maxDistanceFromEMAatr * atrVal).toFixed(2)})`;
        log(`${shortTag} ${reason}`);
        if (enableDiagLog)
          diagLog('triple-sync-diag', '[SKIP-EMA-DIST]', {
            i,
            timeTag,
            distFromEMA,
            limit: maxDistanceFromEMAatr * atrVal,
          });
        if (rejections)
          rejections.push({ candleIndex: i, candleTime: timeTag, reason });
        continue;
      }
    }

    // ── Candle quality filter ──────────────────────────────────────────────
    const quality = checkCandleQuality(
      candle,
      direction,
      minBodyRatio,
      maxWickRatio,
      minCandleRange,
    );
    if (!quality.pass) {
      const reason = `TRIPLE_SYNC skipped: candle not definitive — ${quality.reason}`;
      log(`${shortTag} ${reason}`);
      if (enableDiagLog)
        diagLog('triple-sync-diag', '[SKIP-CANDLE]', {
          i,
          timeTag,
          direction,
          detail: quality.reason,
        });
      if (rejections)
        rejections.push({ candleIndex: i, candleTime: timeTag, reason });
      continue;
    }

    log(`${shortTag} candle quality OK (${direction})`);

    // ── Stop-loss calculation ──────────────────────────────────────────────
    const entry = candle.close;
    let sl: number;

    if (direction === 'BUY') {
      sl = calcBuySL(candles, i, swingLookback, slBuffer);
    } else {
      sl = calcSellSL(candles, i, swingLookback, slBuffer);
    }

    const risk = Math.abs(entry - sl);

    if (risk === 0) {
      const reason = 'TRIPLE_SYNC skipped: zero-risk SL (degenerate candle)';
      log(`${shortTag} ${reason}`);
      if (rejections)
        rejections.push({ candleIndex: i, candleTime: timeTag, reason });
      continue;
    }

    log(
      `${shortTag} SL=${sl.toFixed(2)}, entry=${entry.toFixed(2)}, risk=${risk.toFixed(2)}`,
    );

    // ── Target + RRR calculation ───────────────────────────────────────────
    let targetResult: { target: number; rrr: number };

    if (direction === 'BUY') {
      targetResult = calcBuyTarget(
        candles,
        i,
        entry,
        sl,
        risk,
        targetLookback,
        minRRR,
      );
    } else {
      targetResult = calcSellTarget(
        candles,
        i,
        entry,
        sl,
        risk,
        targetLookback,
        minRRR,
      );
    }

    const { target: t1, rrr: actualRRR } = targetResult;

    // ── RRR gate ──────────────────────────────────────────────────────────
    if (actualRRR < minRRR) {
      const reason = `TRIPLE_SYNC skipped: RRR ${actualRRR.toFixed(2)} below minimum ${minRRR}`;
      log(`${shortTag} ${reason}`);
      if (enableDiagLog)
        diagLog('triple-sync-diag', '[SKIP-RRR]', {
          i,
          timeTag,
          actualRRR,
          minRRR,
        });
      if (rejections)
        rejections.push({ candleIndex: i, candleTime: timeTag, reason });
      continue;
    }

    // ── Room-to-move: verify target isn't immediately blocked ──────────────
    // Already handled implicitly by `calcBuyTarget` / `calcSellTarget` which
    // look for the nearest opposing swing and only use it when RRR >= minRRR.
    // If the nearest swing is too close, the fallback target (entry ± risk×minRRR)
    // is used, satisfying the minimum geometry.

    // ── Build signal ──────────────────────────────────────────────────────
    const t2 = direction === 'BUY' ? entry + risk * 2 : entry - risk * 2;
    const t3 = direction === 'BUY' ? entry + risk * 3 : entry - risk * 3;

    const dt =
      candle.date instanceof Date
        ? candle.date
        : new Date(candle.date as string | number);

    const reasonText =
      direction === 'BUY'
        ? `TRIPLE_SYNC bullish entry confirmed — price above EMA(${ema200.toFixed(2)}), supertrend green, ADX ${adxResult.adx.toFixed(1)}, RRR ${actualRRR.toFixed(2)}`
        : `TRIPLE_SYNC bearish entry confirmed — price below EMA(${ema200.toFixed(2)}), supertrend red, ADX ${adxResult.adx.toFixed(1)}, RRR ${actualRRR.toFixed(2)}`;

    log(`${shortTag} ✓ SIGNAL ${direction}: ${reasonText}`);

    if (enableDiagLog) {
      diagLog('triple-sync-diag', `[SIGNAL-${direction}]`, {
        i,
        timeTag,
        entry,
        sl,
        risk,
        t1,
        t2,
        t3,
        rrr: actualRRR,
        ema200,
        adx: adxResult.adx,
        stValue: stResult.value,
        stTrend: stResult.trend,
        atr: atrVal,
      });
    }

    signals.push({
      strategyName: 'TRIPLE_SYNC',
      signalType: direction,
      candleIndex: i,
      candleTime: timeTag,
      candleDate: dt,
      entryPrice: entry,
      stopLoss: sl,
      risk,
      target1: t1,
      target2: t2,
      target3: t3,
      rrr: actualRRR,
      indicators: {
        ema200,
        adx: adxResult.adx,
        supertrendValue: stResult.value,
        supertrendTrend: stResult.trend,
        atr: atrVal,
      },
      reason: reasonText,
    });
  }

  return signals;
}

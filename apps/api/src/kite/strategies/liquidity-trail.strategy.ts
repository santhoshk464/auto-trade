/**
 * Liquidity Trail Signals Strategy
 *
 * Exact port of the "Liquidity Trail Signals [BOSWaves]" Pine Script indicator.
 *
 * Core idea: An ATR-based trailing stop that ratchets with the EMA baseline.
 * When the trailing stop flips direction, it generates a BUY or SELL signal.
 *
 * Trend Engine:
 *   raw_up = EMA(maLen) - ATR(atrLen) × atrMult   ← bull trail (below price)
 *   raw_dn = EMA(maLen) + ATR(atrLen) × atrMult   ← bear trail (above price)
 *
 *   Init (first valid bar):
 *     close > EMA  →  trend=+1, trail=raw_up
 *     close ≤ EMA  →  trend=-1, trail=raw_dn
 *
 *   In uptrend (trend=+1):
 *     trail = max(raw_up, prev_trail)    ← ratchets upward, never retreats
 *     close < trail  →  flip to -1, trail=raw_dn
 *
 *   In downtrend (trend=-1):
 *     trail = min(raw_dn, prev_trail)    ← ratchets downward, never retreats
 *     close > trail  →  flip to +1, trail=raw_up
 *
 * Signal generation (identical to Pine Script plotshape / alertcondition):
 *   BUY   — trend flips -1 → +1  (flip_bull)
 *   SELL  — trend flips +1 → -1  (flip_bear)
 *
 * Entry  = close at the flip candle
 * SL     = trail at the flip candle  (raw_up for BUY, raw_dn for SELL)
 * TP1/2/3 = entry ± |risk| × R multiplier  (defaults: 1R / 2R / 3R)
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: candles in → signals out, zero side-effects.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityTrailCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Close timestamp — used only for labelling in signal output. */
  date: Date | string | number;
}

export interface LiquidityTrailConfig {
  /** EMA baseline length (Pine Script default: 28). */
  maLen?: number;
  /** ATR period — Wilder RMA (Pine Script default: 15). */
  atrLen?: number;
  /** Trail distance in ATR multiples (Pine Script default: 1.25). */
  atrMult?: number;
  /** Take-profit 1 as R multiple (Pine Script default: 1.0). */
  tp1R?: number;
  /** Take-profit 2 as R multiple (Pine Script default: 2.0). */
  tp2R?: number;
  /** Take-profit 3 as R multiple (Pine Script default: 3.0). */
  tp3R?: number;
  /** Take-profit 4 as R multiple (default: 4.0). */
  tp4R?: number;
  /** Take-profit 5 as R multiple (default: 5.0). */
  tp5R?: number;
}

export interface LiquidityTrailSignal {
  /** Zero-based index of the flip candle in the input array. */
  candleIndex: number;
  /** Formatted close time, e.g. "09:40 am". */
  candleTime: string;
  /** Close date of the flip candle. */
  candleDate: Date;
  signalType: 'BUY' | 'SELL';
  reason: string;
  entryPrice: number;
  stopLoss: number;
  /** Absolute distance between entry and SL. */
  risk: number;
  target1: number;
  target2: number;
  target3: number;
  target4: number;
  target5: number;
  /** Trail value at the signal candle (= SL). */
  trail: number;
  /** Trend direction at signal: +1 = bull, -1 = bear. */
  trend: 1 | -1;
  /** EMA value at the signal candle. */
  ema: number;
  /** ATR value at the signal candle. */
  atr: number;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * EMA with standard multiplier k = 2 / (period + 1).
 * Seeded with SMA of the first `period` values.
 * Returns null for the warm-up period (indices 0 … period-2).
 */
function calcEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  out[period - 1] = seed / period;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    out[i] = closes[i] * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/**
 * ATR using Wilder RMA (alpha = 1/period) — identical to Pine Script ta.atr().
 * Seeded with SMA of the first `period` TR values.
 * Returns null for indices 0 … period-2.
 */
function calcATR(
  candles: LiquidityTrailCandle[],
  period: number,
): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  // True-range array (first bar: no prev-close reference, use HL range)
  const tr: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < n; i++) {
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  // Seed ATR with SMA of first `period` TR values
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  out[period - 1] = atr;

  // Wilder smoothing: atr = (prev * (period-1) + TR) / period
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Format a Date as "HH:MM am/pm". */
function fmtTime(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  let h = dt.getHours();
  const m = dt.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Runs the Liquidity Trail Signals strategy over an array of OHLC candles
 * (oldest-first) and returns all BUY / SELL signal objects detected.
 *
 * This is a direct port of the Pine Script logic:
 *   ma_len=28, atr_len=15, atr_mult=1.25  (overridable via config)
 *
 * @param candles  Candle array in chronological order (oldest first).
 * @param config   Optional parameter overrides.
 */
export function detectLiquidityTrailSignals(
  candles: LiquidityTrailCandle[],
  config: LiquidityTrailConfig = {},
): LiquidityTrailSignal[] {
  const {
    maLen = 28,
    atrLen = 15,
    atrMult = 1.25,
    tp1R = 1.0,
    tp2R = 2.0,
    tp3R = 3.0,
    tp4R = 4.0,
    tp5R = 5.0,
  } = config;

  const n = candles.length;
  const signals: LiquidityTrailSignal[] = [];
  if (n < Math.max(maLen, atrLen) + 2) return signals;

  const closes = candles.map((c) => c.close);
  const ema = calcEMA(closes, maLen);
  const atr = calcATR(candles, atrLen);

  let trend: 1 | -1 = 1;
  let trail = 0;
  let initialized = false;

  for (let i = 0; i < n; i++) {
    const maVal = ema[i];
    const atrVal = atr[i];

    // Skip warm-up period until both indicators are ready
    if (maVal === null || atrVal === null) continue;

    const close = candles[i].close;
    const rawUp = maVal - atrVal * atrMult; // bull trail level
    const rawDn = maVal + atrVal * atrMult; // bear trail level

    // ── Initialise on first valid bar ────────────────────────────────────────
    if (!initialized) {
      trend = close > maVal ? 1 : -1;
      trail = trend === 1 ? rawUp : rawDn;
      initialized = true;
      continue;
    }

    // ── Trend engine ─────────────────────────────────────────────────────────
    const prevTrend = trend;

    if (trend === 1) {
      // Uptrend: ratchet trail upward
      trail = Math.max(rawUp, trail);
      if (close < trail) {
        // Bear flip
        trend = -1;
        trail = rawDn;
      }
    } else {
      // Downtrend: ratchet trail downward
      trail = Math.min(rawDn, trail);
      if (close > trail) {
        // Bull flip
        trend = 1;
        trail = rawUp;
      }
    }

    const flipBull = trend === 1 && prevTrend === -1;
    const flipBear = trend === -1 && prevTrend === 1;

    if (!flipBull && !flipBear) continue;

    // ── Build signal ──────────────────────────────────────────────────────────
    const signalType = flipBull ? 'BUY' : 'SELL';
    const entry = close; // Pine Script: entry_px = close
    const sl = trail; // Pine Script: sl_px    = trail
    const risk = Math.abs(entry - sl);

    // Avoid degenerate zero-risk signals (shouldn't happen but guard anyway)
    if (risk === 0) continue;

    const target1 = flipBull ? entry + risk * tp1R : entry - risk * tp1R;
    const target2 = flipBull ? entry + risk * tp2R : entry - risk * tp2R;
    const target3 = flipBull ? entry + risk * tp3R : entry - risk * tp3R;
    const target4 = flipBull ? entry + risk * tp4R : entry - risk * tp4R;
    const target5 = flipBull ? entry + risk * tp5R : entry - risk * tp5R;

    const dt =
      candles[i].date instanceof Date
        ? (candles[i].date as Date)
        : new Date(candles[i].date as string | number);

    signals.push({
      candleIndex: i,
      candleTime: fmtTime(dt),
      candleDate: dt,
      signalType,
      reason:
        signalType === 'BUY'
          ? 'Liquidity Trail Bull Flip — ATR trail reversed upward, momentum shift confirmed'
          : 'Liquidity Trail Bear Flip — ATR trail reversed downward, momentum shift confirmed',
      entryPrice: entry,
      stopLoss: sl,
      risk,
      target1,
      target2,
      target3,
      target4,
      target5,
      trail,
      trend,
      ema: maVal,
      atr: atrVal,
    });
  }

  return signals;
}

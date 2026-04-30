/**
 * Previous Day High Rejection Strategy (PDHR)
 *
 * Monitors NIFTY SPOT 5-minute candles for bearish rejections of the
 * Previous Day High (PDH) level.
 *
 * State machine:
 *   WAITING_FOR_PDH_TOUCH
 *       ↓ any candle: high ≥ pdh − touchTolerance  OR  open ≥ pdh (gap-up)
 *   PDH_TOUCHED  (zoneHigh tracks max high seen since first touch)
 *       ↓ red candle (close < open) + close < pdh, within trade window
 *   SIGNAL_FIRED  → requiresRecovery = true, hasTouchedPdh + zoneHigh reset
 *       ↓ close ≥ pdh
 *   RECOVERY_COMPLETE  → hasTouchedPdh + zoneHigh reset, allow re-entry
 *
 * Scenarios handled:
 *   1. Gap-up 9:15 open above PDH — same-candle rejection fires if red
 *   2. Open far below PDH, rally to PDH, rejection — hasTouchedPdh persists across candles
 *   3. Liquidity sweep (high > pdh then crash) — zoneHigh captures sweep high for wider SL
 *   4. Multiple candles touching PDH — zoneHigh accumulates across all touches
 *   5. Rejection candle does not re-touch PDH — hasTouchedPdh from prior candle still active
 *   6. Evening Star (3-candle) — doji candle sets hasTouchedPdh, bear bar fires signal + A++
 *
 * Range quality filters (previous day context):
 *   - range < minPreviousDayRangePoints  → strategy skipped (narrow consolidation day)
 *   - closeRatio ≥ 0.67 (top third)     → strategy skipped (bullish close; PDH likely breaks)
 *   - closeRatio determines signal score (strong / moderate / weak)
 *
 * Score / grade:
 *   A++ + strong or moderate range → 10 (full position)
 *   A++ + weak range               →  6 (half position)
 *   A   + strong or moderate range →  6 (half position)
 *   A   + weak range               →  4 (quarter position)
 *
 * Entry  : close of the triggering 5-minute candle
 * SL     : max(zoneHigh, candle.high) + stopLossBuffer
 *          (natural SL distance < minStopLossPoints → extended to minStopLossPoints)
 * T1     : entry − risk × 1  (1:1 RR)
 * T2     : entry − risk × 2  (1:2 RR, floored at PDL when provided)
 * T3     : entry − risk × 3  (1:3 RR, floored at PDL when provided)
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import { diagLog } from '../helpers/diag-logger';

// ─── Candle ───────────────────────────────────────────────────────────────────

export interface PdhrCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** Date/time of the candle — used for time-gate checks and labels. */
  date: Date | string | number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface PdhrConfig {
  /**
   * Previous Day High of the NIFTY SPOT index (the key resistance level).
   * Required — no signals are emitted if this is 0 or negative.
   */
  previousDayHigh: number;

  /**
   * Previous Day Low of the NIFTY SPOT index.
   * Used as the maximum allowed target (T2 / T3 are floored at PDL).
   * Also used for range quality calculation.
   * Default: undefined (no cap on targets; range quality = 'unknown')
   */
  previousDayLow?: number;

  /**
   * Previous Day Close of the NIFTY SPOT index.
   * Determines how strongly yesterday's session rejected at PDH:
   *   closeRatio = (prevClose − prevLow) / (prevHigh − prevLow)
   *   < 0.33 → strong bearish close  (PDH very meaningful resistance) → score not penalised
   *   < 0.67 → moderate              (PDH meaningful)                 → score not penalised
   *   ≥ 0.67 → bullish close near PDH (PDH likely to break today)     → PDHR skipped entirely
   * Default: undefined (range quality = 'unknown'; no quality penalty or skip)
   */
  previousDayClose?: number;

  /**
   * Previous Day Open of the NIFTY SPOT index.
   * Informational only — echoed on the signal for reference.
   * Default: undefined
   */
  previousDayOpen?: number;

  /**
   * Minimum range (PDH − PDL) for the previous day in points.
   * Narrow range days produce a soft PDH level — skip PDHR if range is too tight.
   * Default: 0 (disabled)
   */
  minPreviousDayRangePoints?: number;

  /**
   * Points below PDH within which a candle high counts as "touching PDH".
   * Also used for pattern detection proximity checks.
   * Default: 5
   */
  touchTolerance?: number;

  /**
   * Buffer (points) added above zoneHigh for the stop-loss.
   * Default: 3
   */
  stopLossBuffer?: number;

  /**
   * Minimum stop-loss distance (points) from entry.
   * If the natural SL distance is smaller, SL is extended to entry + minStopLossPoints.
   * Default: 17
   */
  minStopLossPoints?: number;

  /**
   * Maximum number of entry signals allowed per session.
   * Default: 2
   */
  maxSignals?: number;

  /**
   * Earliest 5m candle start time allowed for a signal, in minutes from midnight.
   * Default: 570  (09:30 AM)
   */
  tradeStartMins?: number;

  /**
   * Latest 5m candle start time allowed for a signal, in minutes from midnight.
   * Default: 870  (02:30 PM)
   */
  tradeEndMins?: number;

  /** When true, prints diagnostic lines to console. Default: false */
  debug?: boolean;
}

// ─── Signal ──────────────────────────────────────────────────────────────────

export type PdhrRangeQuality = 'strong' | 'moderate' | 'weak' | 'unknown';

export interface PdhrSignal {
  strategyName: 'Prev Day High Rejection';
  signal: true;
  setupType: 'PREV_DAY_HIGH_REJECTION';

  /** 5-minute candle close price — used as the short-entry price. */
  entryPrice: number;

  /** Stop-loss level based on zoneHigh (not just the signal candle's high). */
  stopLoss: number;

  /** PDH level that was rejected. */
  previousDayHigh: number;

  /** PDL level — max target cap (when provided). */
  previousDayLow?: number;

  /** Previous day close — echoed for context / diagnostics. */
  previousDayClose?: number;

  /** Previous day open — echoed for context / diagnostics. */
  previousDayOpen?: number;

  /** Index of the triggering 5m candle in the input `candles` array. */
  setupIndex: number;

  /** Human-readable signal description. */
  reason: string;

  /** 1 = first entry of the day, 2 = re-entry after recovery. */
  signalNumber: 1 | 2;

  /** True when a recognised bearish reversal pattern was detected. */
  isAplusPlus: boolean;

  /** Name of the A++ pattern, or null if none detected. */
  pattern: string | null;

  /** Grade derived from pattern presence. */
  setupGrade: 'A++' | 'A';

  /**
   * Numeric score for position sizing.
   * 10 = full position, 6 = half, 4 = quarter.
   * Computed from grade × range quality.
   */
  score: number;

  /**
   * Max high seen across all candles since the first PDH touch.
   * The SL is derived from this value (not just the signal candle high),
   * so it correctly accounts for liquidity sweeps above PDH.
   */
  zoneHigh: number;

  /**
   * True when zoneHigh > previousDayHigh — price swept above PDH before reversing.
   * Indicates a liquidity sweep: the SL is wider but the setup is often cleaner.
   */
  sweepDetected: boolean;

  /** Quality of yesterday's closing position within the day's range. */
  rangeQuality: PdhrRangeQuality;

  /** Target 1 — 1:1 RR (entry − risk) */
  t1: number;

  /** Target 2 — 1:2 RR (entry − risk × 2), floored at PDL */
  t2: number;

  /** Target 3 — 1:3 RR (entry − risk × 3), floored at PDL */
  t3: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function candleLabel(candle: PdhrCandle, index: number): string {
  try {
    const d = new Date(candle.date as any);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `[${index}] ${hh}:${mm}`;
  } catch {
    return `[${index}]`;
  }
}

/**
 * Derive range quality from where yesterday's session closed within its range.
 * A close in the bottom third signals a strong bearish rejection at PDH.
 * A close in the top third signals bullish momentum — PDH likely to break today.
 */
function computeRangeQuality(
  pdh: number,
  pdl: number | undefined,
  pdc: number | undefined,
): { quality: PdhrRangeQuality; closeRatio: number | null } {
  if (pdl == null || pdc == null) return { quality: 'unknown', closeRatio: null };
  const range = pdh - pdl;
  if (range <= 0) return { quality: 'unknown', closeRatio: null };
  const closeRatio = (pdc - pdl) / range;
  const quality: PdhrRangeQuality =
    closeRatio < 0.33 ? 'strong' : closeRatio < 0.67 ? 'moderate' : 'weak';
  return { quality, closeRatio };
}

/**
 * Translate grade + range quality into a numeric position-sizing score.
 * Weak range quality reduces score by one tier (A++ → 6, A → 4).
 */
function computeScore(isAplusPlus: boolean, rangeQuality: PdhrRangeQuality): number {
  if (isAplusPlus) return rangeQuality === 'weak' ? 6 : 10;
  return rangeQuality === 'weak' ? 4 : 6;
}

/**
 * Detect whether the candle at `idx` (or the 2-3 candle sequence ending at it)
 * forms a recognised A++ bearish reversal pattern near PDH.
 *
 * Checks (in order):
 *   1. Shooting Star  — single candle, long upper wick, closes near low
 *   2. Evening Star   — 3-candle: strong bull → small doji near PDH → strong bear
 *   3. Bearish Engulfing — current bear body engulfs prior bull body
 *   4. Bearish Kicker    — current bear opens below prior bull open (gap reversal)
 */
function detectBearishPattern(
  candles: PdhrCandle[],
  idx: number,
  pdh: number,
  touchTol: number,
): { isAplusPlus: boolean; pattern: string | null } {
  const c = candles[idx];
  const prev = idx > 0 ? candles[idx - 1] : null;
  const prev2 = idx > 1 ? candles[idx - 2] : null;

  const range = c.high - c.low;
  if (range <= 0) return { isAplusPlus: false, pattern: null };

  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const isBearish = c.close < c.open;

  // ── 1. Shooting Star ──────────────────────────────────────────────────────
  if (
    upperWick / range >= 0.55 &&
    body / range <= 0.35 &&
    c.high >= pdh - touchTol
  ) {
    return { isAplusPlus: true, pattern: 'Shooting Star' };
  }

  // ── 2. Evening Star ───────────────────────────────────────────────────────
  if (prev && prev2) {
    const prevRange = prev.high - prev.low;
    const prevBody = Math.abs(prev.close - prev.open);
    const prev2Range = prev2.high - prev2.low;
    const prev2Body = Math.abs(prev2.close - prev2.open);

    if (
      prev2.close > prev2.open &&
      prev2Body / (prev2Range || 1) >= 0.5 &&
      prevBody / (prevRange || 1) <= 0.3 &&
      prev.high >= pdh - touchTol &&
      isBearish &&
      body / range >= 0.45
    ) {
      return { isAplusPlus: true, pattern: 'Evening Star' };
    }
  }

  // ── 3. Bearish Engulfing ──────────────────────────────────────────────────
  if (prev && isBearish) {
    const isBullishPrev = prev.close > prev.open;
    if (
      isBullishPrev &&
      c.open >= prev.close &&
      c.close <= prev.open
    ) {
      return { isAplusPlus: true, pattern: 'Bearish Engulfing' };
    }
  }

  // ── 4. Bearish Kicker ─────────────────────────────────────────────────────
  if (prev && isBearish) {
    const isBullishPrev = prev.close > prev.open;
    const prevRange = prev.high - prev.low;
    const prevBody = Math.abs(prev.close - prev.open);
    if (
      isBullishPrev &&
      prevBody / (prevRange || 1) >= 0.5 &&
      c.open < prev.open &&
      body / range >= 0.55
    ) {
      return { isAplusPlus: true, pattern: 'Bearish Kicker' };
    }
  }

  return { isAplusPlus: false, pattern: null };
}

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * Scan `candles` (5-minute NIFTY SPOT) for Previous Day High Rejection setups.
 *
 * @param candles  Ordered intraday 5m spot candles, earliest first. Needs ≥ 2.
 * @param config   Strategy parameters — `previousDayHigh` is required.
 * @returns        Array of PdhrSignal (at most `maxSignals` per session).
 */
export function detectPreviousDayHighRejectionOnly(
  candles: PdhrCandle[],
  config: PdhrConfig,
): PdhrSignal[] {
  const {
    previousDayHigh: pdh,
    previousDayLow: pdl,
    previousDayClose: pdc,
    previousDayOpen: pdo,
    minPreviousDayRangePoints = 0,
    touchTolerance = 5,
    stopLossBuffer = 3,
    minStopLossPoints = 17,
    maxSignals = 2,
    tradeStartMins = 9 * 60 + 30,
    tradeEndMins = 14 * 60 + 30,
    debug = false,
  } = config;

  const log = debug
    ? (...args: unknown[]) => console.log('[PDHR]', ...args)
    : () => {};

  const signals: PdhrSignal[] = [];

  if (candles.length < 2 || pdh <= 0) {
    log('Skipping: insufficient candles or invalid PDH.');
    return signals;
  }

  // ── Range quality — check previous day context before scanning ──────────────

  const { quality: rangeQuality, closeRatio } = computeRangeQuality(pdh, pdl, pdc);

  // Skip if previous day range is too narrow (consolidation day → weak PDH level)
  if (pdl != null && minPreviousDayRangePoints > 0) {
    const prevRange = pdh - pdl;
    if (prevRange < minPreviousDayRangePoints) {
      log(
        `Skipping: previous day range ${prevRange.toFixed(0)} pts < ` +
        `minPreviousDayRangePoints ${minPreviousDayRangePoints} pts (consolidation day).`,
      );
      return signals;
    }
  }

  // Skip if yesterday closed in the top third of its range (bullish day → PDH likely to break)
  if (closeRatio !== null && closeRatio >= 0.67) {
    log(
      `Skipping: previous day closeRatio=${(closeRatio * 100).toFixed(0)}% ` +
      `(top third of range) — bullish close suggests PDH breakout today, not rejection.`,
    );
    return signals;
  }

  log(
    `PDHR scan: PDH=${pdh}, PDL=${pdl ?? 'none'}, PDC=${pdc ?? 'none'}, ` +
    `rangeQuality=${rangeQuality}` +
    (closeRatio !== null ? ` (closeRatio=${(closeRatio * 100).toFixed(0)}%)` : '') +
    `, candles=${candles.length}`,
  );

  diagLog('pdhr-strategy-diag', '[PDHR-SCAN]', {
    pdh,
    pdl,
    pdc,
    pdo,
    rangeQuality,
    closeRatio,
    candleCount: candles.length,
  });

  // ── State ────────────────────────────────────────────────────────────────────
  //   hasTouchedPdh   — price has reached the PDH zone; persist across candles
  //   zoneHigh        — max high seen since the first PDH touch (SL anchor)
  //   requiresRecovery — after a signal fires, wait for close ≥ PDH before re-entry
  let hasTouchedPdh = false;
  let zoneHigh = 0;
  let requiresRecovery = false;
  let signalCount = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const label = candleLabel(candle, i);

    if (signalCount >= maxSignals) break;

    // ── Recovery: wait for close ≥ PDH after a signal fires ───────────────
    // During recovery we skip all other logic — no touch tracking, no signals.
    if (requiresRecovery) {
      if (candle.close >= pdh) {
        requiresRecovery = false;
        hasTouchedPdh = false;
        zoneHigh = 0;
        log(`${label}: Recovery complete (close=${candle.close} >= PDH ${pdh}) — re-entry enabled`);
        diagLog('pdhr-strategy-diag', '[PDHR-RECOVERY]', {
          i,
          label,
          close: candle.close,
          pdh,
        });
      }
      continue;
    }

    // ── Update zoneHigh while PDH zone is active ───────────────────────────
    if (hasTouchedPdh && candle.high > zoneHigh) {
      zoneHigh = candle.high;
    }

    // ── Detect first touch of PDH zone ────────────────────────────────────
    // Gap-up open above PDH (candle.open >= pdh) also counts as a touch.
    if (!hasTouchedPdh) {
      const touchesZone =
        candle.high >= pdh - touchTolerance || candle.open >= pdh;
      if (touchesZone) {
        hasTouchedPdh = true;
        zoneHigh = candle.high;
        log(`${label}: PDH zone touched — high=${candle.high}, open=${candle.open}, zoneHigh=${zoneHigh}`);
        diagLog('pdhr-strategy-diag', '[PDHR-TOUCH]', {
          i,
          label,
          high: candle.high,
          open: candle.open,
          zoneHigh,
          pdh,
        });
      }
    }

    // ── Time gate ─────────────────────────────────────────────────────────
    const d = new Date(candle.date as any);
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < tradeStartMins || mins > tradeEndMins) {
      if (hasTouchedPdh) {
        log(`${label}: Touch recorded (zoneHigh=${zoneHigh}) but outside trade window (${mins} mins) — waiting`);
      }
      continue;
    }

    // ── Signal check — only when PDH has been touched ─────────────────────
    if (!hasTouchedPdh) continue;

    if (candle.close >= candle.open) {
      log(`${label}: Green candle — not bearish (close=${candle.close} >= open=${candle.open}), skip`);
      continue;
    }
    if (candle.close >= pdh) {
      log(`${label}: Red candle but close=${candle.close} >= PDH ${pdh} — no rejection yet`);
      continue;
    }

    // ── A++ pattern detection ─────────────────────────────────────────────
    const { isAplusPlus, pattern } = detectBearishPattern(
      candles,
      i,
      pdh,
      touchTolerance,
    );

    // ── Weak Bearish Engulfing — defer to next candle ──────────────────────
    // When the engulfing body is < 50% below PDH the conviction is low.
    // Skip firing on this candle; hasTouchedPdh + zoneHigh are retained so
    // the very next red candle that closes below PDH will trigger the signal.
    if (pattern === 'Bearish Engulfing') {
      const body = candle.open - candle.close; // positive (bearish)
      const bodyBelowPdh = pdh - candle.close;
      if (body > 0 && bodyBelowPdh / body < 0.5) {
        log(
          `${label}: Weak BE — only ${((bodyBelowPdh / body) * 100).toFixed(0)}% of body below PDH` +
          ` — deferring (hasTouchedPdh retained, zoneHigh=${zoneHigh})`,
        );
        continue;
      }
    }

    // ── Compute SL using zoneHigh (accounts for liquidity sweeps) ─────────
    const entryPrice = candle.close;
    const slBase = Math.max(zoneHigh, candle.high);
    const naturalSlDist = slBase + stopLossBuffer - entryPrice;
    const risk = Math.max(naturalSlDist, minStopLossPoints);
    const stopLoss = entryPrice + risk;
    const sweepDetected = zoneHigh > pdh;

    const t1 = entryPrice - risk;
    const t2Raw = entryPrice - risk * 2;
    const t3Raw = entryPrice - risk * 3;
    const t2 = pdl != null ? Math.max(t2Raw, pdl) : t2Raw;
    const t3 = pdl != null ? Math.max(t3Raw, pdl) : t3Raw;

    const score = computeScore(isAplusPlus, rangeQuality);

    const reason =
      `PDHR #${signalCount + 1}: ${label} entry ${entryPrice.toFixed(2)} below PDH ${pdh}` +
      ` | zoneHigh=${slBase.toFixed(2)} | SL ${stopLoss.toFixed(2)}` +
      ` | T1 ${t1.toFixed(2)} | T2 ${t2.toFixed(2)} | T3 ${t3.toFixed(2)}` +
      ` | grade=${isAplusPlus ? 'A++' : 'A'} score=${score}` +
      ` | rangeQuality=${rangeQuality}` +
      (sweepDetected ? ' | SWEEP' : '') +
      (pattern ? ` | Pattern: ${pattern}` : '');

    log(reason);
    diagLog('pdhr-strategy-diag', '[PDHR-SIGNAL]', {
      i,
      label,
      entryPrice,
      stopLoss,
      slBase,
      risk,
      sweepDetected,
      isAplusPlus,
      pattern,
      score,
      rangeQuality,
      pdh,
      pdl,
      t1,
      t2,
      t3,
    });

    signals.push({
      strategyName: 'Prev Day High Rejection',
      signal: true,
      setupType: 'PREV_DAY_HIGH_REJECTION',
      entryPrice,
      stopLoss,
      previousDayHigh: pdh,
      previousDayLow: pdl,
      previousDayClose: pdc,
      previousDayOpen: pdo,
      setupIndex: i,
      reason,
      signalNumber: (signalCount + 1) as 1 | 2,
      isAplusPlus,
      pattern,
      setupGrade: isAplusPlus ? 'A++' : 'A',
      score,
      zoneHigh: slBase,
      sweepDetected,
      rangeQuality,
      t1,
      t2,
      t3,
    });

    signalCount++;
    requiresRecovery = true;
    hasTouchedPdh = false;
    zoneHigh = 0;
  }

  log(`PDHR scan complete: ${signals.length} signal(s) found.`);
  diagLog('pdhr-strategy-diag', '[PDHR-DONE]', { signalCount: signals.length });
  return signals;
}

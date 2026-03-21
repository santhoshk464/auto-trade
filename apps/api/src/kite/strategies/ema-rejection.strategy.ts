/**
 * 20 EMA Rejection Selling Strategy
 *
 * Detects bearish continuation trades where the market is weak relative to the
 * 20 EMA, price pulls back toward the EMA, fails to reclaim it, and resumes
 * downside movement.
 *
 * Two bearish context types:
 *   Type A — Bearish Acceptance:
 *     Market opens below the 20 EMA. Sellers in control from session start.
 *
 *   Type B — Rejection From Above:
 *     First candle opens above the 20 EMA but closes below it.
 *     Bulls failed to hold — price rejected back through the EMA.
 *
 * State machine:
 *   WAITING_FOR_BEARISH_CONTEXT
 *     → WAITING_FOR_PULLBACK   (bearish context confirmed)
 *   WAITING_FOR_PULLBACK
 *     → IN_EMA_ZONE            (price approaches EMA zone from below)
 *     → SETUP_INVALIDATED      (pullback too deep — bullish acceptance)
 *   IN_EMA_ZONE
 *     → FAKE_BREAK_ABOVE_EMA   (price closes above EMA within tolerance)
 *     → REJECTION_CONFIRMED    (direct rejection without break)
 *     → SETUP_INVALIDATED      (sustained bullish break or chop filter)
 *   FAKE_BREAK_ABOVE_EMA
 *     → REJECTION_CONFIRMED    (close back below EMA with bearish follow-through)
 *     → SETUP_INVALIDATED      (too many candles above / bullish acceptance)
 *   REJECTION_CONFIRMED
 *     → TRADE_TRIGGERED        (1m confirmation or direct 5m signal)
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import fs from 'fs';
import path from 'path';

// ─── State ───────────────────────────────────────────────────────────────────

type EmaRejState =
  | 'WAITING_FOR_BEARISH_CONTEXT'
  | 'WAITING_FOR_PULLBACK'
  | 'IN_EMA_ZONE'
  | 'FAKE_BREAK_ABOVE_EMA'
  | 'REJECTION_CONFIRMED'
  | 'TRADE_TRIGGERED'
  | 'SETUP_INVALIDATED';

// ─── Candle ──────────────────────────────────────────────────────────────────

export interface EmaRejCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Date/time of candle. Used for labelling only. */
  date: Date | string | number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface EmaRejConfig {
  /**
   * Zone width (pts) around the 20 EMA for "near touch" detection.
   * Price is considered in the EMA zone when: high >= ema - emaTouchBufferPts.
   * Default: 5
   */
  emaTouchBufferPts?: number;

  /**
   * Maximum pts above the EMA still considered a tolerable fake break.
   * If price exceeds ema + emaBreakTolerancePts, it leans toward invalidation.
   * Default: 8
   */
  emaBreakTolerancePts?: number;

  /**
   * Soft reference count for candles above EMA during a fake break.
   * NOT a hard cutoff — the critical signal is failure to sustain (bullish follow-through).
   * This is used alongside momentum checks, not as a sole disqualifier.
   * Default: 3
   */
  maxFakeBreakCandlesReference?: number;

  /**
   * Minimum bearish body / total range ratio for a rejection candle to be
   * considered meaningful. Below this threshold the candle is too indecisive.
   * Default: 0.3
   */
  minRejectionStrengthReference?: number;

  /**
   * Minimum pts of downside swing room from entry to the next structural level.
   * Assessed against recent intraday swing structure, not a fixed support level.
   * Default: 20
   */
  minDownsideRoomReference?: number;

  /**
   * Minimum acceptable risk:reward ratio.
   * Default: 1.5
   */
  minRiskRewardReference?: number;

  /**
   * Maximum allowed stop-loss width in pts. Signals with wider SL are skipped.
   * Default: 30
   */
  maxAllowedSLReference?: number;

  /**
   * Buffer (pts) added above the rejection zone high when placing the stop-loss.
   * Default: 5
   */
  stopLossBuffer?: number;

  /**
   * Number of 1m candles to scan for entry confirmation after a 5m rejection.
   * 0 = no limit.
   * Default: 10
   */
  oneMinuteConfirmationWindow?: number;

  /**
   * Max candles overlapping the EMA zone (alternating above/below) before the
   * chop filter fires and the setup is skipped.
   * Default: 4
   */
  chopFilterReference?: number;

  /**
   * Recent 5m candle lookback for finding the nearest structural support below.
   * Default: 15
   */
  rrLookbackCandles?: number;

  /** When true, prints debug lines to console. Default: false */
  debug?: boolean;
}

// ─── Signal ──────────────────────────────────────────────────────────────────

export interface EmaRejSignal {
  strategyName: 'EMA Rejection';
  signal: true;
  /** Direct rejection vs fake-break-then-fail */
  setupType: 'EMA_REJECTION' | 'EMA_FAKE_BREAK_REJECTION';
  /**
   * Bearish context type that opened the session.
   * A = market opened below EMA (Bearish Acceptance).
   * B = first candle opened above but closed below EMA (Rejection From Above).
   */
  contextType: 'A' | 'B';
  entryPrice: number;
  stopLoss: number;
  /** Target 1 — 1:1 RR (entry − risk × 1) */
  t1: number;
  /** Target 2 — 1:2 RR (entry − risk × 2) */
  t2: number;
  /** Target 3 — 1:3 RR (entry − risk × 3) */
  t3: number;
  /** 20 EMA value at the rejection candle */
  emaReference: number;
  /** Index of the 5m rejection/setup candle in `candles`. */
  setupIndex: number;
  /** Index of the 1m confirmation candle in `candles1m` (or -1 if 5m direct). */
  confirmIndex: number;
  /** Number of retests of the EMA zone before this signal. 0 = first touch. */
  retestCount: number;
  reason: string;
}

// ─── File logger ─────────────────────────────────────────────────────────────

function emaRejFileLog(tag: string, data: object): void {
  const logFile = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'logs',
    `ema-rejection-diag-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function candleLabel(candle: EmaRejCandle, index: number): string {
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
 * Returns the 1m candle slice starting at or after the 5m candle's open time,
 * capped to `windowSize` candles.
 */
function getOneMinuteWindow(
  candles1m: EmaRejCandle[],
  setup5mCandle: EmaRejCandle,
  windowSize: number,
): { candles: EmaRejCandle[]; startIdx: number } {
  const setupTime = new Date(setup5mCandle.date as any).getTime();
  let startIdx = 0;
  if (!isNaN(setupTime)) {
    const found = candles1m.findIndex(
      (c) => new Date(c.date as any).getTime() >= setupTime,
    );
    if (found !== -1) startIdx = found;
  }
  const end =
    windowSize > 0
      ? Math.min(startIdx + windowSize, candles1m.length)
      : candles1m.length;
  return { candles: candles1m.slice(startIdx, end), startIdx };
}

/**
 * Finds the highest candle low that is BELOW `referencePrice` within the
 * last `lookback` 5m candles before `currentIdx`.
 * Returns null if none found (infinite room — no RR cap).
 */
function findNearestSupportBelow(
  candles: EmaRejCandle[],
  currentIdx: number,
  referencePrice: number,
  lookback: number,
): number | null {
  const start = Math.max(0, currentIdx - lookback);
  let nearest: number | null = null;
  // Only treat a candle as structural support if it is a SWING LOW —
  // i.e., a local minimum where both the preceding and following candles
  // have higher lows.  This prevents the immediately-prior candle low in a
  // smooth downtrend from being mistaken as "support" (which would give a
  // tiny reward of 2-3 pts and kill valid setups).
  // When no genuine swing low is found below, null is returned and the
  // caller treats that as infinite room (RR check only).
  for (let i = start + 1; i < currentIdx - 1; i++) {
    const low = candles[i].low;
    if (low < referencePrice) {
      // Must be a local minimum (swing low): both neighbors have higher lows
      if (low < candles[i - 1].low && low < candles[i + 1].low) {
        if (nearest === null || low > nearest) nearest = low;
      }
    }
  }
  return nearest;
}

/**
 * Checks whether a candle shows bullish acceptance above the EMA:
 * Strong body closing above EMA with meaningful range.
 * Used to detect "sustained bullish break" as an invalidation signal.
 */
function isBullishAcceptanceAboveEma(
  candle: EmaRejCandle,
  ema: number,
  minBodyRatio: number = 0.35,
): boolean {
  if (candle.close <= ema) return false;
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  // Bullish body closing above EMA with decent body size
  return candle.close > candle.open && bodyRatio >= minBodyRatio;
}

/**
 * Measures whether recent candles exhibit EMA chop:
 * alternating closes above/below EMA without a decisive direction.
 * Returns the count of candles that overlapped the EMA zone
 * (i.e. had their range cross the EMA level).
 */
function countZoneOverlapCandles(
  candles: EmaRejCandle[],
  emaValues: (number | null)[],
  fromIdx: number,
  toIdx: number,
): number {
  let count = 0;
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    const ema = emaValues[i];
    if (ema == null) continue;
    // Candle overlaps EMA zone if its range straddles the EMA
    if (candles[i].low < ema && candles[i].high > ema) {
      count++;
    }
  }
  return count;
}

/**
 * Determines whether a candle shows bearish rejection quality near the EMA:
 * - Upper wick is meaningful (selling pressure at EMA)
 * - OR bearish close below EMA
 * Returns a quality score 0–1 (higher = stronger rejection).
 */
function rejectionQuality(candle: EmaRejCandle, ema: number): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const bodyRatio = body / range;
  const wickRatio = upperWick / range;
  // Quality increases with upper wick at EMA and bearish body
  let score = 0;
  if (candle.close < ema) score += 0.4; // closed below EMA
  if (candle.close < candle.open) score += bodyRatio * 0.3; // bearish body ratio
  if (upperWick > 0 && candle.high >= ema) score += wickRatio * 0.3; // upper wick at EMA
  return Math.min(score, 1);
}

/**
 * Checks whether there is "meaningful downside continuation" after a candle.
 * Used for retest quality degradation — a prior retest is only considered
 * "resolved with continuation" if price moved DOWN by at least
 * `minContinuationPts` from the entry candle low in subsequent candles.
 * This prevents incrementing the retest counter when price just hovered
 * near the EMA without going anywhere.
 */
function hadMeaningfulDownsideContinuation(
  candles: EmaRejCandle[],
  fromIdx: number,
  entryLow: number,
  minContinuationPts: number,
): boolean {
  for (let i = fromIdx + 1; i < candles.length; i++) {
    if (candles[i].low <= entryLow - minContinuationPts) return true;
  }
  return false;
}

// ─── Main detector ───────────────────────────────────────────────────────────

/**
 * Scan `candles` (5-minute) for 20 EMA Rejection sell setups.
 *
 * @param candles      Ordered intraday 5m candles, earliest first. Needs ≥ 2.
 * @param emaValues    Pre-computed 20 EMA values aligned to `candles` (same length).
 *                     Null entries (insufficient data) are tolerated.
 * @param config       Optional tuning parameters.
 * @param candles1m    Optional 1m candles for entry precision confirmation.
 * @returns            Array of EmaRejSignal (can have multiple per session if
 *                     invalidation/reset occurs, but typically one).
 */
export function detectEmaRejectionOnly(
  candles: EmaRejCandle[],
  emaValues: (number | null)[],
  config: EmaRejConfig = {},
  candles1m?: EmaRejCandle[],
): EmaRejSignal[] {
  const {
    emaTouchBufferPts = 5,
    emaBreakTolerancePts = 8,
    maxFakeBreakCandlesReference = 3,
    minRejectionStrengthReference = 0.3,
    minDownsideRoomReference = 20,
    minRiskRewardReference = 1.5,
    maxAllowedSLReference = 30,
    stopLossBuffer = 5,
    oneMinuteConfirmationWindow = 10,
    chopFilterReference = 4,
    rrLookbackCandles = 15,
    debug = false,
  } = config;

  // Minimum pts of downside move after a retest to count as "continuation"
  const minContinuationPts = Math.max(5, minDownsideRoomReference * 0.25);

  const log = debug
    ? (...args: unknown[]) => console.log('[EMA-REJ]', ...args)
    : () => {};

  const signals: EmaRejSignal[] = [];

  if (candles.length < 2) {
    log('Not enough candles (need ≥ 2). Skipping.');
    return signals;
  }
  if (emaValues.length !== candles.length) {
    log(
      `EMA values length (${emaValues.length}) does not match candles (${candles.length}). Skipping.`,
    );
    return signals;
  }

  // ── Step 1: Detect bearish context type from first candle ─────────────────
  const firstCandle = candles[0];
  const firstEma = emaValues[0];

  if (firstEma == null) {
    log(
      'No EMA for first candle — cannot determine bearish context. Skipping.',
    );
    return signals;
  }

  let contextType: 'A' | 'B' | null = null;

  // Type A: Market opened below EMA (open price is the signal — no wick restriction)
  if (firstCandle.open < firstEma) {
    contextType = 'A';
    log(
      `Bearish context Type A: open ${firstCandle.open} < EMA ${firstEma.toFixed(2)} (${candleLabel(firstCandle, 0)})`,
    );
  }
  // Type B: First candle opened above EMA but closed below it (rejection from above)
  else if (firstCandle.open >= firstEma && firstCandle.close < firstEma) {
    contextType = 'B';
    log(
      `Bearish context Type B: open ${firstCandle.open} >= EMA ${firstEma.toFixed(2)}, close ${firstCandle.close} < EMA (${candleLabel(firstCandle, 0)})`,
    );
  }

  if (contextType === null) {
    log(
      `No bearish context on first candle (open=${firstCandle.open}, close=${firstCandle.close}, EMA=${firstEma.toFixed(2)}). Skipping session.`,
    );
    return signals;
  }

  emaRejFileLog('[EMA-REJ-CONTEXT]', {
    contextType,
    firstOpen: firstCandle.open,
    firstClose: firstCandle.close,
    ema: firstEma,
    candleLabel: candleLabel(firstCandle, 0),
  });

  // ── State machine ─────────────────────────────────────────────────────────
  let state: EmaRejState = 'WAITING_FOR_PULLBACK';

  // Fake break tracking
  let fakeBreakStartIdx = -1; // index of the first candle that closed above EMA
  let fakeBreakHighestClose = -Infinity; // highest close seen during fake break

  // Rejection zone tracking (the high of the zone to place SL above)
  let rejectionZoneHigh = 0;
  let rejectionSetupIdx = -1;

  // Chop tracking: zone entry index for counting overlapping candles
  let zoneEntryIdx = -1;

  // Retest quality degradation tracking
  let retestCount = 0; // number of EMA zone retests that resolved WITHOUT continuation
  let lastRetestIdx = -1; // index of the last retest entry (for continuation check)
  let lastRetestLow = 0; // low of the candle at the last retest

  // ── Walk candles from index 1 (first candle used only for context) ────────
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const ema = emaValues[i];
    const lbl = candleLabel(c, i);

    if (ema == null) {
      log(`${lbl}: No EMA value, skipping.`);
      continue;
    }

    // ── State: WAITING_FOR_PULLBACK ────────────────────────────────────────
    if (state === 'WAITING_FOR_PULLBACK') {
      // Invalidation: Bullish acceptance above EMA → session context broken
      // Price must be producing meaningful bullish closes well above EMA
      if (c.close > ema && isBullishAcceptanceAboveEma(c, ema)) {
        // Further confirm: look if this is not just an isolated spike by checking
        // if prior candle also closed above EMA (two consecutive bullish closes above)
        const prevEma = emaValues[i - 1];
        if (prevEma != null && candles[i - 1].close > prevEma) {
          state = 'SETUP_INVALIDATED';
          log(
            `${lbl}: INVALIDATED in PULLBACK — two consecutive bullish closes above EMA (close=${c.close}, EMA=${ema.toFixed(2)})`,
          );
          emaRejFileLog('[EMA-REJ-INVALIDATED-PULLBACK]', {
            candleLabel: lbl,
            close: c.close,
            ema,
          });
          break;
        }
      }

      // Breakout: price approaches the EMA zone from below
      // Condition: high reaches within emaTouchBufferPts below EMA
      if (c.high >= ema - emaTouchBufferPts) {
        state = 'IN_EMA_ZONE';
        zoneEntryIdx = i;
        log(
          `${lbl}: Entered EMA zone — high=${c.high}, EMA=${ema.toFixed(2)}, buffer=${emaTouchBufferPts}`,
        );
        emaRejFileLog('[EMA-REJ-ZONE-ENTERED]', {
          candleLabel: lbl,
          high: c.high,
          ema,
          emaTouchBufferPts,
        });

        // Track retest degradation: if we had a prior resolved retest,
        // check if it had meaningful downside continuation.
        if (lastRetestIdx >= 0) {
          const hadContinuation = hadMeaningfulDownsideContinuation(
            candles,
            lastRetestIdx,
            lastRetestLow,
            minContinuationPts,
          );
          if (!hadContinuation) {
            retestCount++;
            log(
              `Retest count incremented to ${retestCount} — prior retest at [${lastRetestIdx}] had no meaningful continuation`,
            );
          } else {
            retestCount = 0; // reset: prior retest DID produce continuation, quality is fresh
            log(`Retest count reset — prior retest had continuation`);
          }
        }
        lastRetestIdx = i;
        lastRetestLow = c.low;

        // Fall-through: also evaluate this candle in IN_EMA_ZONE below
        // (so a single-candle rejection is not missed)
      } else {
        continue;
      }
    }

    // ── State: IN_EMA_ZONE ────────────────────────────────────────────────
    if (state === 'IN_EMA_ZONE') {
      // ── Chop filter ──────────────────────────────────────────────────────
      const overlapCount = countZoneOverlapCandles(
        candles,
        emaValues,
        zoneEntryIdx,
        i,
      );
      if (overlapCount >= chopFilterReference) {
        state = 'SETUP_INVALIDATED';
        log(
          `${lbl}: CHOP FILTER triggered — ${overlapCount} zone-overlap candles (ref=${chopFilterReference})`,
        );
        emaRejFileLog('[EMA-REJ-CHOP-FILTER]', {
          candleLabel: lbl,
          overlapCount,
          chopFilterReference,
        });
        break;
      }

      // ── Bullish acceptance invalidation (clean break above EMA with follow-through) ──
      // Only invalidate if: price is above EMA AND it's a strong bullish candle
      // AND the move is beyond tolerance AND prior candle also confirmed bullish
      if (
        c.close > ema + emaBreakTolerancePts &&
        isBullishAcceptanceAboveEma(c, ema)
      ) {
        const prevEma = emaValues[i - 1];
        if (prevEma != null && candles[i - 1].close > prevEma) {
          state = 'SETUP_INVALIDATED';
          log(
            `${lbl}: INVALIDATED in EMA_ZONE — strong bullish close ${c.close} > EMA+tolerance ${(ema + emaBreakTolerancePts).toFixed(2)}`,
          );
          emaRejFileLog('[EMA-REJ-INVALIDATED-ZONE]', {
            candleLabel: lbl,
            close: c.close,
            ema,
            emaBreakTolerancePts,
          });
          break;
        }
      }

      // ── Price closes above EMA (fake break candidate) ─────────────────────
      if (c.close > ema) {
        // If within tolerance, move to FAKE_BREAK state
        if (c.close <= ema + emaBreakTolerancePts) {
          if (state !== ('FAKE_BREAK_ABOVE_EMA' as EmaRejState)) {
            state = 'FAKE_BREAK_ABOVE_EMA';
            fakeBreakStartIdx = i;
            fakeBreakHighestClose = c.close;
            log(
              `${lbl}: Fake break started — close=${c.close}, EMA=${ema.toFixed(2)}, tolerance=${emaBreakTolerancePts}`,
            );
            emaRejFileLog('[EMA-REJ-FAKE-BREAK-START]', {
              candleLabel: lbl,
              close: c.close,
              ema,
              emaBreakTolerancePts,
            });
          }
        }
        continue;
      }

      // ── Price closes below EMA — direct rejection ─────────────────────────
      // Candle high reached EMA zone but close is below EMA
      if (c.high >= ema - emaTouchBufferPts && c.close < ema) {
        const quality = rejectionQuality(c, ema);
        if (quality >= minRejectionStrengthReference) {
          state = 'REJECTION_CONFIRMED';
          rejectionZoneHigh = c.high;
          rejectionSetupIdx = i;
          log(
            `${lbl}: Direct rejection confirmed — high=${c.high}, close=${c.close}, EMA=${ema.toFixed(2)}, quality=${quality.toFixed(2)}`,
          );
          emaRejFileLog('[EMA-REJ-DIRECT-REJECTION]', {
            candleLabel: lbl,
            high: c.high,
            close: c.close,
            ema,
            quality,
          });
          // Fall-through to REJECTION_CONFIRMED handler below
        }
      }
    }

    // ── State: FAKE_BREAK_ABOVE_EMA ──────────────────────────────────────
    if (state === 'FAKE_BREAK_ABOVE_EMA') {
      // Track highest close seen above EMA during fake break
      if (c.close > fakeBreakHighestClose) fakeBreakHighestClose = c.close;

      const candlesAboveEma = i - fakeBreakStartIdx + 1;

      // ── Chop filter during fake break ───────────────────────────────────
      const overlapCount = countZoneOverlapCandles(
        candles,
        emaValues,
        zoneEntryIdx,
        i,
      );
      if (overlapCount >= chopFilterReference) {
        state = 'SETUP_INVALIDATED';
        log(
          `${lbl}: CHOP FILTER triggered during fake break — ${overlapCount} overlap candles`,
        );
        emaRejFileLog('[EMA-REJ-CHOP-FAKE-BREAK]', {
          candleLabel: lbl,
          overlapCount,
          chopFilterReference,
        });
        break;
      }

      // ── Bullish acceptance: strong close well above tolerance with follow-through ──
      // Primary signal: expanding bullish range beyond tolerance + consecutive closes
      if (
        c.close > ema + emaBreakTolerancePts &&
        isBullishAcceptanceAboveEma(c, ema)
      ) {
        const prevEma = emaValues[i - 1];
        if (prevEma != null && candles[i - 1].close > prevEma) {
          state = 'SETUP_INVALIDATED';
          log(
            `${lbl}: INVALIDATED — bullish acceptance during fake break, close=${c.close}, EMA+tol=${(ema + emaBreakTolerancePts).toFixed(2)}`,
          );
          emaRejFileLog('[EMA-REJ-INVALIDATED-FAKEBREAK]', {
            candleLabel: lbl,
            close: c.close,
            candlesAboveEma,
            maxFakeBreakCandlesReference,
            ema,
          });
          break;
        }
      }

      // Soft pressure: candles above EMA soft reference exceeded AND momentum is bullish
      // (expanding closes upward with no sign of failure) — lean toward invalidation
      if (candlesAboveEma > maxFakeBreakCandlesReference) {
        // Check for bullish momentum: last 2 closes both above EMA and higher than previous
        const prevClose = candles[i - 1]?.close ?? 0;
        const prevPrevClose = candles[i - 2]?.close ?? 0;
        const prevEma = emaValues[i - 1];
        if (
          prevEma != null &&
          prevClose > prevEma &&
          c.close > prevClose &&
          prevClose > prevPrevClose
        ) {
          state = 'SETUP_INVALIDATED';
          log(
            `${lbl}: INVALIDATED — ${candlesAboveEma} candles above EMA with rising momentum (soft ref=${maxFakeBreakCandlesReference})`,
          );
          emaRejFileLog('[EMA-REJ-INVALIDATED-MOMENTUM]', {
            candleLabel: lbl,
            candlesAboveEma,
            maxFakeBreakCandlesReference,
            close: c.close,
            prevClose,
            prevPrevClose,
          });
          break;
        }
      }

      // ── Rejection from fake break: close back below EMA ──────────────────
      // Primary confirmation: close back below EMA (most important signal)
      if (c.close < ema) {
        const quality = rejectionQuality(c, ema);
        if (quality >= minRejectionStrengthReference) {
          state = 'REJECTION_CONFIRMED';
          // Zone high = the highest point seen during the fake break + this candle
          rejectionZoneHigh = Math.max(fakeBreakHighestClose, c.high);
          rejectionSetupIdx = i;
          log(
            `${lbl}: Fake break rejection confirmed — close=${c.close} < EMA=${ema.toFixed(2)}, zoneHigh=${rejectionZoneHigh.toFixed(2)}, quality=${quality.toFixed(2)}`,
          );
          emaRejFileLog('[EMA-REJ-FAKEBREAK-CONFIRMED]', {
            candleLabel: lbl,
            close: c.close,
            ema,
            zoneHigh: rejectionZoneHigh,
            candlesAboveEma,
            quality,
          });
          // Fall-through to REJECTION_CONFIRMED handler below
        } else {
          log(
            `${lbl}: Close back below EMA but rejection quality too low (${quality.toFixed(2)} < ${minRejectionStrengthReference}) — waiting`,
          );
          // Stay in FAKE_BREAK state, wait for stronger confirmation
          continue;
        }
      } else {
        continue;
      }
    }

    // ── State: REJECTION_CONFIRMED ────────────────────────────────────────
    if (state === 'REJECTION_CONFIRMED') {
      const setupCandle = candles[rejectionSetupIdx];
      const setupEma = emaValues[rejectionSetupIdx];

      // ── Stop-loss calculation ─────────────────────────────────────────────
      // SL = rejection zone high + buffer
      const stopLoss = rejectionZoneHigh + stopLossBuffer;
      const risk = stopLoss - setupCandle.close;

      if (risk <= 0) {
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: Risk <= 0, skipping.`,
        );
        state = 'WAITING_FOR_PULLBACK';
        continue;
      }

      // ── SL width filter ───────────────────────────────────────────────────
      if (risk > maxAllowedSLReference) {
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: SL too wide — risk=${risk.toFixed(1)} > max=${maxAllowedSLReference}`,
        );
        emaRejFileLog('[EMA-REJ-SKIPPED-SL-WIDE]', {
          candleLabel: candleLabel(setupCandle, rejectionSetupIdx),
          risk,
          maxAllowedSLReference,
        });
        state = 'WAITING_FOR_PULLBACK';
        continue;
      }

      // ── EMA slope quality check (supporting factor, not standalone) ───────
      // EMA slope is checked alongside price structure, not as sole disqualifier.
      // If EMA is curling upward AND price is also making higher structure, lean invalid.
      if (setupEma != null && rejectionSetupIdx >= 2) {
        const emaPrev = emaValues[rejectionSetupIdx - 1];
        const emaPrev2 = emaValues[rejectionSetupIdx - 2];
        if (emaPrev != null && emaPrev2 != null) {
          const emaSlope = setupEma - emaPrev;
          const prevEmaSlope = emaPrev - emaPrev2;
          const emaAccelerating =
            emaSlope > 0 && prevEmaSlope > 0 && emaSlope > prevEmaSlope;
          // Only invalidate if EMA is accelerating UP AND price structure confirms
          // (i.e., candle prior to setup was also bullish and above EMA)
          if (emaAccelerating) {
            const prevCandle = candles[rejectionSetupIdx - 1];
            const prevCandleEma = emaValues[rejectionSetupIdx - 1];
            if (
              prevCandleEma != null &&
              prevCandle.close > prevCandleEma &&
              prevCandle.close > prevCandle.open
            ) {
              log(
                `${candleLabel(setupCandle, rejectionSetupIdx)}: Skipped — EMA accelerating upward with bullish price structure`,
              );
              emaRejFileLog('[EMA-REJ-SKIPPED-EMA-SLOPE]', {
                candleLabel: candleLabel(setupCandle, rejectionSetupIdx),
                setupEma,
                emaPrev,
                emaPrev2,
                emaSlope,
                prevEmaSlope,
              });
              state = 'WAITING_FOR_PULLBACK';
              continue;
            }
          }
        }
      }

      // ── Bearish candle requirement ─────────────────────────────────────
      // Setup candle MUST be bearish (close < open). Entering on a green
      // candle risks immediate SL hit because momentum is still bullish.
      if (setupCandle.close >= setupCandle.open) {
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: Skipped — setup candle is not bearish (open=${setupCandle.open}, close=${setupCandle.close})`,
        );
        emaRejFileLog('[EMA-REJ-SKIPPED-NOT-BEARISH]', {
          candleLabel: candleLabel(setupCandle, rejectionSetupIdx),
          open: setupCandle.open,
          close: setupCandle.close,
        });
        state = 'WAITING_FOR_PULLBACK';
        // Reset fake-break tracking so a later candle can re-trigger
        fakeBreakStartIdx = -1;
        fakeBreakHighestClose = -Infinity;
        rejectionZoneHigh = 0;
        rejectionSetupIdx = -1;
        continue;
      }

      // ── Downside room check (structural) ─────────────────────────────────
      // 1st touch (retestCount === 0): skip room/RR check entirely.
      //   In a strong downtrend the 1st EMA rejection is the cleanest setup —
      //   sellers are fresh and price almost always continues down. Adding an
      //   RR gate here only filters out valid trades.
      // 2nd+ touch (retestCount >= 1): the EMA is now a contested zone, so we
      //   require at least minRiskRewardReference × risk of room below before entry.
      if (retestCount >= 1) {
        const nearestSupport = findNearestSupportBelow(
          candles,
          rejectionSetupIdx,
          setupCandle.close,
          rrLookbackCandles,
        );

        if (nearestSupport !== null) {
          const reward = setupCandle.close - nearestSupport;
          const rr = reward / risk;

          if (rr < minRiskRewardReference) {
            log(
              `${candleLabel(setupCandle, rejectionSetupIdx)}: Insufficient RR on retest#${retestCount + 1} — rr=${rr.toFixed(2)} < min=${minRiskRewardReference}`,
            );
            emaRejFileLog('[EMA-REJ-SKIPPED-RR]', {
              candleLabel: candleLabel(setupCandle, rejectionSetupIdx),
              rr,
              minRiskRewardReference,
              reward,
              risk,
              nearestSupport,
              retestCount,
            });
            state = 'WAITING_FOR_PULLBACK';
            continue;
          }
        }
        // If no swing-low support found → infinite room, allow signal
      } else {
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: 1st touch — skipping room/RR check (retestCount=0)`,
        );
      }

      // ── 1-minute confirmation (optional precision layer) ──────────────────
      // 5m rejection is the primary signal. 1m is used only for entry precision.
      let confirmIdx = -1;
      let entryPrice = setupCandle.close; // default: 5m close as entry

      if (
        candles1m &&
        candles1m.length > 0 &&
        oneMinuteConfirmationWindow > 0
      ) {
        const { candles: win, startIdx: winStart } = getOneMinuteWindow(
          candles1m,
          setupCandle,
          oneMinuteConfirmationWindow,
        );
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: Scanning ${win.length} 1m candles for confirmation`,
        );

        for (let j = 0; j < win.length; j++) {
          const c1m = win[j];
          // 1m confirmation: close below the 5m setup candle's low (breakdown)
          if (c1m.close < setupCandle.low) {
            const c1mRange = c1m.high - c1m.low;
            const c1mLowerWick = Math.min(c1m.open, c1m.close) - c1m.low;
            const wickPct = c1mRange > 0 ? c1mLowerWick / c1mRange : 0;
            // Filter: excessive lower wick = counter-pressure, skip
            if (wickPct > 0.4) {
              log(
                `[1m] ${candleLabel(c1m, winStart + j)}: Skipped — excessive lower wick (${(wickPct * 100).toFixed(0)}%)`,
              );
              continue;
            }
            confirmIdx = winStart + j;
            entryPrice = c1m.close;
            log(
              `[1m] ${candleLabel(c1m, winStart + j)}: Confirmed — close=${c1m.close} < setup low ${setupCandle.low}`,
            );
            break;
          }
        }

        if (confirmIdx === -1) {
          log(
            `${candleLabel(setupCandle, rejectionSetupIdx)}: No 1m confirmation within window — using 5m signal direct`,
          );
        }
      }

      // ── Build signal ──────────────────────────────────────────────────────
      const finalRisk = stopLoss - entryPrice;
      if (finalRisk <= 0) {
        log(
          `${candleLabel(setupCandle, rejectionSetupIdx)}: Final risk <= 0 after entry refinement, skipping.`,
        );
        state = 'WAITING_FOR_PULLBACK';
        continue;
      }

      const t1 = entryPrice - finalRisk;
      const t2 = entryPrice - finalRisk * 2;
      const t3 = entryPrice - finalRisk * 3;

      const setupType: EmaRejSignal['setupType'] =
        fakeBreakStartIdx >= 0 && rejectionSetupIdx > fakeBreakStartIdx
          ? 'EMA_FAKE_BREAK_REJECTION'
          : 'EMA_REJECTION';

      const reason = [
        `EMA-REJ(${contextType}): ${setupType}`,
        `@ ${candleLabel(setupCandle, rejectionSetupIdx)}`,
        `entry=${entryPrice.toFixed(2)}`,
        `SL=${stopLoss.toFixed(2)}`,
        `EMA=${(setupEma ?? 0).toFixed(2)}`,
        retestCount > 0 ? `retest#${retestCount + 1}` : '',
        confirmIdx >= 0 ? '1m-confirmed' : '5m-direct',
      ]
        .filter(Boolean)
        .join(' | ');

      const signal: EmaRejSignal = {
        strategyName: 'EMA Rejection',
        signal: true,
        setupType,
        contextType,
        entryPrice,
        stopLoss,
        t1,
        t2,
        t3,
        emaReference: setupEma ?? 0,
        setupIndex: rejectionSetupIdx,
        confirmIndex: confirmIdx,
        retestCount,
        reason,
      };

      signals.push(signal);
      state = 'TRADE_TRIGGERED';

      log(`Signal triggered: ${reason}`);
      emaRejFileLog('[EMA-REJ-SIGNAL]', {
        setupType,
        contextType,
        entryPrice,
        stopLoss,
        t1,
        t2,
        t3,
        emaReference: setupEma,
        setupIndex: rejectionSetupIdx,
        confirmIndex: confirmIdx,
        retestCount,
        reason,
      });

      // Reset for potential next signal later in the session
      // (allowed after trade resolves, but we stop re-triggering immediately)
      fakeBreakStartIdx = -1;
      fakeBreakHighestClose = -Infinity;
      rejectionZoneHigh = 0;
      rejectionSetupIdx = -1;
      // Stay in TRADE_TRIGGERED — no further signals until price revisits and
      // a new pullback cycle begins. In practice, one signal per session is typical.
      break;
    }

    // ── State: SETUP_INVALIDATED / TRADE_TRIGGERED ──────────────────────
    if (
      (state as string) === 'SETUP_INVALIDATED' ||
      (state as string) === 'TRADE_TRIGGERED'
    ) {
      break;
    }
  }

  return signals;
}

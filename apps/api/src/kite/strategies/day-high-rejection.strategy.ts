/**
 * Day High Rejection Strategy â€” Standalone (v1)
 *
 * Detects bearish "Day High Rejection" sell signals from intraday candle data.
 *
 * Signal subtypes:
 *   DAY_HIGH_REJECTION        â€” candle touches the rolling day high and shows rejection.
 *   DAY_HIGH_SWEEP_REJECTION  â€” candle breaks slightly above the zone then closes back below.
 *
 * Zone cooldown: after a signal fires from a zone, the same zone is suppressed
 * for N candles or until price moves meaningfully away.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in â†’ out, no side-effects beyond optional debug logs.
 */

import fs from 'fs';
import path from 'path';

// â”€â”€â”€ Candle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DhrCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** Date/time of the candle. Used only for labelling in logs. */
  date: Date | string | number;
}

// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DhrConfig {
  /**
   * Maximum points the candle high can be above or below the rolling high
   * for a "near-touch" zone test.  Default: 5
   */
  touchTolerance?: number;

  /**
   * Min upper-wick / total-range ratio for wick-based rejection (0â€“1).
   * Default: 0.45
   */
  minUpperWickRatio?: number;

  /**
   * Min bearish-body / total-range ratio for body-based rejection (0â€“1).
   * Default: 0.45
   */
  minBearishBodyRatio?: number;

  /**
   * Points above zone reference for stop-loss placement.  Default: 5
   */
  stopLossBuffer?: number;

  /**
   * When true â†’ wait for the next candle to confirm before firing.
   * Default: false
   */
  requireNextCandleConfirmation?: boolean;

  /**
   * Max points a candle's high can penetrate above the zone and still
   * qualify as a sweep (failed breakout).  If the candle goes higher than
   * zone + sweepBuffer it is treated as a real breakout.  Default: 10
   */
  sweepBuffer?: number;

  /**
   * After a signal fires from a zone, suppress further signals from that
   * same zone reference for this many candles.  Default: 5
   */
  zoneCooldownCandles?: number;

  /**
   * Rearm the zone early if the close drops at least this many points
   * below the zone reference (price has moved meaningfully away).  Default: 15
   */
  zoneRearmMoveAwayPts?: number;

  /**
   * Minimum candles that must pass before `movedAway` can trigger early
   * zone rearm.  Prevents rearming after just 1 bounce candle.  Default: 3
   */
  minRearmCandles?: number;

  /**
   * Pre-calculated 20-EMA value from the **previous session** (yesterday's daily close data).
   * Provided by the caller — the strategy itself has no access to historical daily data.
   *
   * Session activation gate:
   *   - If provided: strategy runs only when firstCandle.open is at/below EMA20 + tolerance.
   *   - If omitted or undefined: gate is disabled, strategy always runs.
   */
  ema20?: number;

  /**
   * Fractional tolerance added above the EMA20 line for the session gate.
   * A first-candle open at or below `ema20 * (1 + ema20SessionTolerance)` is
   * treated as "at or below EMA20" — allowing small gap-up days that still
   * produce valid day-high rejection setups.
   * Default: 0.005  (0.5% — e.g. EMA20=23087 → gate passes up to ~23202)
   */
  ema20SessionTolerance?: number;

  // ── 1-minute entry confirmation ──────────────────────────────────────────

  /**
   * When true, a valid 5m DHR setup creates a candidate zone and waits for
   * 1-minute confirmation before firing the signal.
   * When false (default) existing direct-entry / next-5m-candle behaviour is preserved.
   */
  useOneMinuteEntryConfirmation?: boolean;

  /**
   * How many 1-minute candles to look at after the 5m setup candle closes.
   * Default: 10 (covers roughly the same 5m candle duration).  Set to 0 = no limit.
   */
  oneMinuteConfirmationWindow?: number;

  /**
   * Enable Option A: two consecutive bearish 1m candles → entry at 2nd candle close.
   * Default: true
   */
  enableTwoCandleConfirm?: boolean;

  /**
   * Enable Option B: one 1m rejection candle then the next breaks its low → entry.
   * Default: true
   */
  enableLowBreakConfirm?: boolean;

  /**
   * Enable Option C: 1m lower-high forms then local 1m support breaks → entry.
   * Default: false  (noisier; off by default)
   */
  enableLowerHighBreakConfirm?: boolean;

  /**
   * Extra buffer added above the 1m trigger candle high for 1m-mode stop-loss.
   * Final SL = max(1m swing high + oneMinuteStopBuffer, 5m zone SL).
   * Default: 3
   */
  oneMinuteStopBuffer?: number;

  /**
   * Enable Option D: 1m candle closes below the 5m DHR setup candle low -> entry.
   * SL is placed above the 5m setup candle high + fiveMinuteSignalStopBuffer.
   * Default: false
   */
  enableFiveMinuteSignalLowBreakConfirm?: boolean;

  /**
   * Buffer added above the 5m DHR setup candle high for stop-loss in
   * FIVE_MIN_SIGNAL_LOW_BREAK mode.  Default: 3
   */
  fiveMinuteSignalStopBuffer?: number;

  // ── Direct-entry quality gate ─────────────────────────────────────────────

  /**
   * Minimum bearish body / total-range ratio for a **direct** (no-confirmation)
   * zone-touch DHR entry.  Only used when `useOneMinuteEntryConfirmation = false`.
   * Signals that do not meet this, `minDirectEntryWickRatio`, or the combined
   * condition are skipped as too weak.
   * Default: 0.60  (strong body only)
   */
  minDirectEntryBodyRatio?: number;

  /**
   * Minimum upper-wick / total-range ratio for a **direct** zone-touch DHR entry.
   * Only used when `useOneMinuteEntryConfirmation = false`.
   * Default: 0.50  (strong wick only)
   */
  minDirectEntryWickRatio?: number;

  /**
   * Maximum lower-wick / upper-wick ratio for a valid rejection candle.
   * Candles where the lower (bottom) wick is too large relative to the upper
   * wick indicate bullish demand at the low and are REJECTED as sell signals.
   * Example: 0.5 means lower wick must be ≤ 50% of the upper wick.
   * Applies to both wick-based and body-based rejection paths.
   * Default: 0.5
   */
  maxLowerWickRatio?: number;

  /**
   * When true, direct (no-1m-confirmation) zone-touch entries require a
   * significant upper wick.  Body-only rejections are still used for setup
   * recognition in 1m-confirmation mode but will NOT trigger direct entries.
   * Default: false
   */
  preferWickRejection?: boolean;

  // ── Room-to-move filter ───────────────────────────────────────────────────

  /**
   * When true, skips DHR signals that do not have enough downside room between
   * entry and the current session low / nearest support.  Default: true
   */
  enableRoomToMoveFilter?: boolean;

  /**
   * Minimum fixed points required between entry price and the current session
   * low.  If the gap is smaller the signal is skipped.  Default: 20
   */
  minRoomToMovePts?: number;

  /**
   * Minimum ratio of (entry − session low) / risk that must be satisfied.
   * e.g. 1.5 means the trade needs at least 1.5× the stop-loss risk as
   * downside room.  Default: 1.5
   */
  minRoomToMoveRiskRatio?: number;

  // ── Session compression filter ────────────────────────────────────────────

  /**
   * When true, restricts signals on days that look compressed / range-bound.
   * Default: false
   */
  enableSessionCompressionFilter?: boolean;

  /**
   * Number of opening candles used as "first-hour" sample.  Default: 6 (30 min on 5m)
   */
  compressionFirstHourCandles?: number;

  /**
   * Maximum first-hour range (high − low) as a fraction of ATR for the
   * session to be considered compressed.  Default: 0.8
   */
  compressionFirstHourAtrRatio?: number;

  /**
   * How many recent candles to examine for overlap/choppiness scoring.
   * Default: 6
   */
  compressionRecentWindow?: number;

  /**
   * Fraction of recent candles that must be overlapping for the session to
   * register as compressed.  Default: 0.6  (60 % overlap)
   */
  compressionOverlapThreshold?: number;

  /**
   * When the session is flagged as compressed AND a prior signal already
   * fired in the same session, block all further signals.  Default: true
   */
  blockRepeatedSignalsWhenCompressed?: boolean;

  /**
   * When true, prints simple debug lines to console.  Default: false
   */
  debug?: boolean;

  /**
   * Earliest signal candle time allowed, in minutes from midnight.
   * Signals whose trigger candle falls before this time are discarded.
   * Default: 570 (09:30 AM)
   */
  tradeStartMins?: number;

  /**
   * Latest signal candle time allowed, in minutes from midnight.
   * Signals whose trigger candle falls after this time are discarded.
   * Default: 870 (02:30 PM)
   */
  tradeEndMins?: number;

  /**
   * Minimum number of candles the `rollingHigh` must have held (without being
   * surpassed by a newer high) before it is eligible to act as a DHR zone.
   *
   * Why this matters in live auto-trade: the scheduler evaluates candles only
   * up to the current wall-clock time (`specificTime = currentTime`).  A local
   * morning peak can temporarily appear to be the "day high" and trigger DHR.
   * Later in the session that level gets surpassed, revealing it was just a
   * mid-session bump — but the live SELL order has already been placed and SL hit.
   *
   * Setting this to 3 requires the zone to have held for at least 3 five-minute
   * candles (15 minutes) before DHR can fire — matching the behaviour of
   * Trade Finder which evaluates the full day and never fires on transient highs.
   *
   * Default: 0 (disabled — backward-compatible, any zone fires immediately)
   */
  minZoneAgeCandles?: number;
}

// â”€â”€â”€ Signal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DhrSignal {
  strategyName: 'Day High Rejection Only';
  signal: true;
  setupType: 'DAY_HIGH_REJECTION' | 'DAY_HIGH_SWEEP_REJECTION';
  /** Suggested entry price. */
  entryPrice: number;
  /** Suggested stop-loss price. */
  stopLoss: number;
  /** 1:1 risk-reward target (entry − risk). */
  t1: number;
  /** 1:2 risk-reward target (entry − risk × 2). */
  t2: number;
  /** 1:3 risk-reward target (entry − risk × 3). */
  t3: number;
  /** The rolling high value that acted as the rejection zone. */
  zoneReference: number;
  /** Index of the candle where the rejection was detected. */
  setupIndex: number;
  /** Index of the confirmation candle, or null for direct-entry signals. */
  confirmIndex: number | null;
  /** Human-readable description of why this signal fired. */
  reason: string;
  /**
   * Confidence score for position sizing.
   * 10 = high-confidence (clean bearish session + strong wick) → full qty.
   *  6 = medium-confidence (marginal session open or body-only rejection) → half qty.
   * Score is always ≥ 6; signals below that threshold are never emitted.
   */
  score: 10 | 6;
  /** Setup grade derived from score: A (score=10) full qty, B (score=6) half qty. */
  setupGrade: 'A' | 'B';
  /**
   * Present only when 1-minute confirmation mode was used.
   * Describes which confirmation type triggered the entry.
   */
  oneMinuteConfirmationType?:
    | 'TWO_CANDLE'
    | 'LOW_BREAK'
    | 'LOWER_HIGH_BREAK'
    | 'FIVE_MIN_SIGNAL_LOW_BREAK';
  /**
   * Index of the 1-minute confirmation candle within the candles1m array.
   * Present only when 1-minute confirmation mode was used.
   */
  oneMinuteConfirmIndex?: number;
}

// â”€â”€â”€ File logger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Target date (YYYY-MM-DD) used in log filenames. Set from candles[0] each run. */
let _dhrTargetDate = '';

function dhrRunTimestamp(): string {
  const d = new Date();
  const date = _dhrTargetDate || d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `${date}_${time}`;
}

function dhrFileLog(tag: string, data: object): void {
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
    `dhr-strategy-diag-${dhrRunTimestamp()}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore â€” log directory may not exist in test envs */
  }
}

// â”€â”€â”€ Helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function candleLabel(candle: DhrCandle, index: number): string {
  try {
    const d = new Date(candle.date as any);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `[${index}] ${hh}:${mm}`;
  } catch {
    return `[${index}]`;
  }
}

// ─── 1-minute confirmation helpers ──────────────────────────────────────────

/**
 * Returns the slice of 1-minute candles that fall strictly after the
 * 5-minute setup candle's open time, up to `windowSize` candles.
 *
 * Returns an empty array in two cases:
 *  - No 1m candle exists strictly after the setup candle's timestamp
 *    (e.g. scheduler runs at exactly a 5m boundary and the next 1m bar
 *    has not been published yet).
 *  - The setup candle has an invalid/NaN timestamp.
 * In both cases we must NOT fall back to slice(0), which would use
 * early-session candles as confirmations for a late-session setup.
 */
function getOneMinuteWindow(
  candles1m: DhrCandle[],
  setup5mCandle: DhrCandle,
  windowSize: number,
): { candles: DhrCandle[]; startIdx: number } {
  const setupTime = new Date(setup5mCandle.date as any).getTime();
  if (!isNaN(setupTime)) {
    const found = candles1m.findIndex(
      (c) => new Date(c.date as any).getTime() > setupTime, // strictly after setup candle
    );
    // No 1m candle exists strictly after the setup candle — return empty.
    if (found === -1) return { candles: [], startIdx: candles1m.length };
    const end =
      windowSize > 0
        ? Math.min(found + windowSize, candles1m.length)
        : candles1m.length;
    return { candles: candles1m.slice(found, end), startIdx: found };
  }
  // Invalid/NaN date on setup candle — cannot determine window position safely.
  return { candles: [], startIdx: candles1m.length };
}

/** True if the candle shows a bearish rejection (upper wick or red body). */
function isOneMinuteRejectionCandle(
  c: DhrCandle,
  minUpperWickRatio: number,
): boolean {
  const range = c.high - c.low;
  if (range <= 0) return false;
  const wick = c.high - Math.max(c.open, c.close);
  return wick / range >= minUpperWickRatio || c.close < c.open;
}

/** Option A: two consecutive bearish 1m candles. */
function checkTwoCandleConfirm(
  window: DhrCandle[],
  minUpperWickRatio: number,
): { confirmed: boolean; index: number } {
  for (let i = 0; i + 1 < window.length; i++) {
    if (
      isOneMinuteRejectionCandle(window[i], minUpperWickRatio) &&
      (window[i + 1].close < window[i + 1].open ||
        window[i + 1].close < window[i].close)
    ) {
      return { confirmed: true, index: i + 1 };
    }
  }
  return { confirmed: false, index: -1 };
}

/** Option B: rejection candle then next breaks its low. */
function checkLowBreakConfirm(
  window: DhrCandle[],
  minUpperWickRatio: number,
): { confirmed: boolean; index: number } {
  for (let i = 0; i + 1 < window.length; i++) {
    if (
      isOneMinuteRejectionCandle(window[i], minUpperWickRatio) &&
      window[i + 1].low < window[i].low
    ) {
      return { confirmed: true, index: i + 1 };
    }
  }
  return { confirmed: false, index: -1 };
}

/** Option C: 1m lower high then local 1m support breaks. */
function checkLowerHighBreakConfirm(window: DhrCandle[]): {
  confirmed: boolean;
  index: number;
} {
  if (window.length < 3) return { confirmed: false, index: -1 };
  for (let i = 1; i + 1 < window.length; i++) {
    const lowerHigh = window[i].high < window[i - 1].high;
    const breakdown = window[i + 1].close < window[i].low;
    if (lowerHigh && breakdown) return { confirmed: true, index: i + 1 };
  }
  return { confirmed: false, index: -1 };
}

/**
 * True when the candle has strong enough rejection quality for a direct
 * (no-confirmation) zone-touch DHR entry.
 *
 * Passes if any of these hold:
 *   A – bearish body >= minBodyRatio  (strong body)
 *   B – upper wick >= minWickRatio AND wick dominates lower wick  (strong wick)
 *   C – combined: wick >= 0.40 AND bearish body >= 0.40  (medium wick + body)
 *
 * Sweep-failure candles are never tested here (handled separately in Step 4a).
 */
function isStrongDirectDhrSignal(
  candle: DhrCandle,
  minBodyRatio: number,
  minWickRatio: number,
): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bodySize = Math.abs(candle.close - candle.open);
  const isRed = candle.close < candle.open;
  const wickRatio = upperWick / range;
  const bodyRatio = bodySize / range;

  // A: strong bearish body
  if (isRed && bodyRatio >= minBodyRatio) return true;
  // B: strong upper wick (dominant)
  if (wickRatio >= minWickRatio && upperWick > lowerWick) return true;
  // C: combined medium wick + medium body
  if (wickRatio >= 0.4 && isRed && bodyRatio >= 0.4) return true;

  return false;
}

/** Option D: any 1m candle closes below the 5m setup candle low. */
function checkFiveMinSignalLowBreak(
  window: DhrCandle[],
  setup5mLow: number,
): { confirmed: boolean; index: number } {
  for (let i = 0; i < window.length; i++) {
    if (window[i].close < setup5mLow) {
      return { confirmed: true, index: i };
    }
  }
  return { confirmed: false, index: -1 };
}

// ─── Internal per-iteration context ─────────────────────────────────────────
// Bundles all derived per-candle values that helpers need; avoids threading
// dozens of individual arguments through every call.

interface DhrIterCtx {
  candles: DhrCandle[];
  idx: number;
  candle: DhrCandle;
  label: string;
  intradayDayHigh: number;
  sessionLow: number;
  sessionScore: 10 | 6;
  sessionGrade: 'A' | 'B';
  adaptiveTouchTolerance: number;
  adaptiveSweepBuffer: number;
  adaptiveStopLossBuffer: number;
  adaptiveZoneRearmMoveAwayPts: number;
  adaptiveMinRoomToMovePts: number;
  candles1m: DhrCandle[] | undefined;
  signals: DhrSignal[];
  cfg: Required<DhrConfig>;
  log: (...args: unknown[]) => void;
}

// ─── checkSessionGate ────────────────────────────────────────────────────────
/**
 * Returns `true` when the session is eligible for DHR signals.
 * Also emits the diagnostic file-log entry and debug line.
 * When `ema20` is not configured (null/0) the gate is always open.
 */
function checkSessionGate(
  candles: DhrCandle[],
  ema20: number | undefined,
  ema20SessionTolerance: number,
  log: (...args: unknown[]) => void,
): boolean {
  if (ema20 == null || ema20 <= 0) return true;

  const firstCandle = candles[0];
  const firstOpen = firstCandle.open;
  const firstClose = firstCandle.close;
  const sessionDate = new Date(firstCandle.date as any)
    .toISOString()
    .split('T')[0];

  const ema20Upper = ema20 * (1 + ema20SessionTolerance);
  const sessionActive =
    firstOpen <= ema20Upper || (firstOpen > ema20Upper && firstClose < ema20);

  const abovePct = (((firstOpen - ema20) / ema20) * 100).toFixed(2);
  log(
    `[${sessionDate}] Session gate: firstOpen=${firstOpen} firstClose=${firstClose}` +
      ` | EMA20(yesterday)=${ema20.toFixed(2)} ema20Upper=${ema20Upper.toFixed(2)}` +
      ` (+${ema20SessionTolerance * 100}%) | active=${sessionActive}`,
  );
  dhrFileLog('[DHR-SESSION-GATE]', {
    sessionDate,
    firstOpen,
    firstClose,
    ema20_yesterday: ema20,
    ema20Upper,
    openAboveEma20Pct: parseFloat(abovePct),
    sessionActive,
    reason: sessionActive
      ? firstOpen <= ema20Upper
        ? `[${sessionDate}] Open ${firstOpen} <= EMA20+tol ${ema20Upper.toFixed(2)} (+${abovePct}%) — DHR active`
        : `[${sessionDate}] Open ${firstOpen} > EMA20+tol but Close ${firstClose} < EMA20 — reversal open, DHR active`
      : `[${sessionDate}] Open ${firstOpen} > EMA20+tol ${ema20Upper.toFixed(2)} (+${abovePct}%) and Close ${firstClose} >= EMA20 — bullish session, DHR skipped`,
  });

  return sessionActive;
}

// ─── checkSweepCandidate ─────────────────────────────────────────────────────
/**
 * Returns `true` when the candle looks like a failed breakout (sweep) of the
 * zone — i.e. it pierced above the zone but closed back below it — AND the
 * rejection quality is sufficient to act on.
 *
 * When it returns `true` the caller can also read the rejection-detail fields
 * via the returned object so the same computation is not repeated.
 */
interface SweepResult {
  isSweep: boolean;
  upperWickRatio: number;
  isRedCandle: boolean;
  sweepRejectionValid: boolean;
  sweepReason: string;
}
function checkSweepCandidate(
  candle: DhrCandle,
  intradayDayHigh: number,
  adaptiveTouchTolerance: number,
  adaptiveSweepBuffer: number,
  minBearishBodyRatio: number,
  minUpperWickRatio: number,
): SweepResult {
  const isSweep =
    candle.high > intradayDayHigh + adaptiveTouchTolerance &&
    candle.high <= intradayDayHigh + adaptiveSweepBuffer &&
    candle.close < intradayDayHigh;

  if (!isSweep) {
    return {
      isSweep: false,
      upperWickRatio: 0,
      isRedCandle: false,
      sweepRejectionValid: false,
      sweepReason: '',
    };
  }

  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const upperWickRatio = totalRange > 0 ? upperWick / totalRange : 0;
  const isRedCandle = candle.close < candle.open;
  const sweepBodyRatio =
    totalRange > 0 ? Math.abs(candle.close - candle.open) / totalRange : 0;
  const sweepClosePositionInRange =
    totalRange > 0 ? (candle.close - candle.low) / totalRange : 1;
  const sweepBodyQuality =
    sweepBodyRatio >= minBearishBodyRatio && sweepClosePositionInRange <= 0.25;
  const sweepRejectionValid =
    isRedCandle &&
    candle.close < intradayDayHigh &&
    (upperWickRatio >= minUpperWickRatio || sweepBodyQuality);

  const sweepPts = (candle.high - intradayDayHigh).toFixed(1);
  const sweepReason = `sweep +${sweepPts}pts above zone | upper wick ${(upperWickRatio * 100).toFixed(0)}% | closed below zone`;

  return {
    isSweep: true,
    upperWickRatio,
    isRedCandle,
    sweepRejectionValid,
    sweepReason,
  };
}

// ─── checkZoneRejection ──────────────────────────────────────────────────────
/**
 * Evaluates the rejection quality of a candle that touched the zone.
 * Returns the computed metrics and a boolean `isRejection` flag.
 */
interface ZoneRejectionResult {
  isRejection: boolean;
  upperWickRatio: number;
  bearishBodyRatio: number;
  upperWick: number;
  lowerWick: number;
  hasSignificantUpperWick: boolean;
  hasStrongBearishBodyRejection: boolean;
  closedBackBelowZone: boolean;
  lowerWickTooLarge: boolean;
  rejectionReason: string;
  rejectBlockReason: string;
}
function checkZoneRejection(
  candle: DhrCandle,
  intradayDayHigh: number,
  minUpperWickRatio: number,
  minBearishBodyRatio: number,
  maxLowerWickRatio: number,
): ZoneRejectionResult {
  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bodySize = Math.abs(candle.close - candle.open);
  const isRedCandle = candle.close < candle.open;

  const upperWickRatio = totalRange > 0 ? upperWick / totalRange : 0;
  const bearishBodyRatio = totalRange > 0 ? bodySize / totalRange : 0;

  const hasSignificantUpperWick =
    upperWickRatio >= minUpperWickRatio && upperWick > lowerWick;
  const closePositionInRange =
    totalRange > 0 ? (candle.close - candle.low) / totalRange : 1;
  const hasStrongBearishBodyRejection =
    isRedCandle &&
    bearishBodyRatio >= minBearishBodyRatio &&
    closePositionInRange <= 0.25;
  const closedBackBelowZone = candle.close < intradayDayHigh && isRedCandle;
  const lowerWickTooLarge =
    upperWick > 0 && lowerWick > upperWick * maxLowerWickRatio;

  const isRejection =
    isRedCandle &&
    closedBackBelowZone &&
    !lowerWickTooLarge &&
    (hasSignificantUpperWick || hasStrongBearishBodyRejection);

  const rejectBlockReason = lowerWickTooLarge
    ? `lowerWickTooLarge (lower=${lowerWick.toFixed(1)} > upper=${upperWick.toFixed(1)}×${maxLowerWickRatio})`
    : !isRedCandle
      ? 'notRedCandle'
      : !closedBackBelowZone
        ? 'didNotCloseBackBelowZone'
        : `wick=${(upperWickRatio * 100).toFixed(0)}% < ${(minUpperWickRatio * 100).toFixed(0)}% AND body=${(bearishBodyRatio * 100).toFixed(0)}% < ${(minBearishBodyRatio * 100).toFixed(0)}%`;

  const reasonParts: string[] = [];
  if (hasSignificantUpperWick)
    reasonParts.push(`upper wick ${(upperWickRatio * 100).toFixed(0)}%`);
  if (hasStrongBearishBodyRejection)
    reasonParts.push(
      `bearish body ${(bearishBodyRatio * 100).toFixed(0)}% (close pos ${(closePositionInRange * 100).toFixed(0)}%)`,
    );
  if (closedBackBelowZone) reasonParts.push('closed back below zone');
  const rejectionReason = reasonParts.join(' | ');

  return {
    isRejection,
    upperWickRatio,
    bearishBodyRatio,
    upperWick,
    lowerWick,
    hasSignificantUpperWick,
    hasStrongBearishBodyRejection,
    closedBackBelowZone,
    lowerWickTooLarge,
    rejectionReason,
    rejectBlockReason,
  };
}

// ─── confirmWith1m ───────────────────────────────────────────────────────────
/**
 * Runs all enabled 1-minute confirmation checks against a slice of 1m candles
 * that follow the 5m setup candle.  Returns the first confirmation that fires.
 */
interface OneMinConfirmResult {
  confirmed: boolean;
  confirmType: DhrSignal['oneMinuteConfirmationType'];
  confirm1mIdx: number;
  entryPrice: number;
  stopLoss: number;
}
function confirmWith1m(
  candles1m: DhrCandle[],
  setup5mCandle: DhrCandle,
  zoneHighForSl: number, // intradayDayHigh (zone) or candle.high (sweep)
  adaptiveStopLossBuffer: number,
  cfg: Pick<
    Required<DhrConfig>,
    | 'oneMinuteConfirmationWindow'
    | 'enableTwoCandleConfirm'
    | 'enableLowBreakConfirm'
    | 'enableLowerHighBreakConfirm'
    | 'enableFiveMinuteSignalLowBreakConfirm'
    | 'oneMinuteStopBuffer'
    | 'fiveMinuteSignalStopBuffer'
    | 'minUpperWickRatio'
  >,
  log: (...args: unknown[]) => void,
  label: string,
): OneMinConfirmResult {
  const {
    oneMinuteConfirmationWindow,
    enableTwoCandleConfirm,
    enableLowBreakConfirm,
    enableLowerHighBreakConfirm,
    enableFiveMinuteSignalLowBreakConfirm,
    oneMinuteStopBuffer,
    fiveMinuteSignalStopBuffer,
    minUpperWickRatio,
  } = cfg;

  const { candles: win, startIdx: winStart } = getOneMinuteWindow(
    candles1m,
    setup5mCandle,
    oneMinuteConfirmationWindow,
  );
  log(
    `${label}  [1m] window has ${win.length} 1m candle(s) starting at 1m idx ${winStart}`,
  );

  let confirmed = false;
  let confirmType: DhrSignal['oneMinuteConfirmationType'];
  let confirm1mIdx = -1;
  let entryPrice = setup5mCandle.close;
  let stopLoss = zoneHighForSl + oneMinuteStopBuffer;

  if (!confirmed && enableTwoCandleConfirm) {
    const r = checkTwoCandleConfirm(win, minUpperWickRatio);
    if (r.confirmed) {
      confirmed = true;
      confirmType = 'TWO_CANDLE';
      confirm1mIdx = winStart + r.index;
      entryPrice = win[r.index].close;
      const sl1m = win[r.index].high + oneMinuteStopBuffer;
      stopLoss = Math.max(sl1m, zoneHighForSl + adaptiveStopLossBuffer);
      log(
        `${label}  [1m] ✅ TWO_CANDLE confirmed @ ${entryPrice}, SL ${stopLoss}`,
      );
    }
  }
  if (!confirmed && enableLowBreakConfirm) {
    const r = checkLowBreakConfirm(win, minUpperWickRatio);
    if (r.confirmed) {
      confirmed = true;
      confirmType = 'LOW_BREAK';
      confirm1mIdx = winStart + r.index;
      entryPrice = win[r.index].close;
      const sl1m =
        win[r.index - 1 >= 0 ? r.index - 1 : 0].high + oneMinuteStopBuffer;
      stopLoss = Math.max(sl1m, zoneHighForSl + adaptiveStopLossBuffer);
      log(
        `${label}  [1m] ✅ LOW_BREAK confirmed @ ${entryPrice}, SL ${stopLoss}`,
      );
    }
  }
  if (!confirmed && enableLowerHighBreakConfirm) {
    const r = checkLowerHighBreakConfirm(win);
    if (r.confirmed) {
      confirmed = true;
      confirmType = 'LOWER_HIGH_BREAK';
      confirm1mIdx = winStart + r.index;
      entryPrice = win[r.index].close;
      const sl1m =
        win[r.index - 1 >= 0 ? r.index - 1 : 0].high + oneMinuteStopBuffer;
      stopLoss = Math.max(sl1m, zoneHighForSl + adaptiveStopLossBuffer);
      log(
        `${label}  [1m] ✅ LOWER_HIGH_BREAK confirmed @ ${entryPrice}, SL ${stopLoss}`,
      );
    }
  }
  if (!confirmed && enableFiveMinuteSignalLowBreakConfirm) {
    const r = checkFiveMinSignalLowBreak(win, setup5mCandle.low);
    if (r.confirmed) {
      confirmed = true;
      confirmType = 'FIVE_MIN_SIGNAL_LOW_BREAK';
      confirm1mIdx = winStart + r.index;
      entryPrice = win[r.index].close;
      stopLoss = setup5mCandle.high + fiveMinuteSignalStopBuffer;
      log(
        `${label}  [1m] FIVE_MIN_SIGNAL_LOW_BREAK @ ${entryPrice}, SL ${stopLoss}` +
          ` (5m high ${setup5mCandle.high} + ${fiveMinuteSignalStopBuffer})`,
      );
    }
  }

  return { confirmed, confirmType, confirm1mIdx, entryPrice, stopLoss };
}

// ─── passesRoomToMove ────────────────────────────────────────────────────────
/**
 * Returns `true` when there is enough downside room between `entryPrice` and
 * the current `sessionLow` for the trade to be viable.
 */
function passesRoomToMove(
  entryPrice: number,
  stopLoss: number,
  sessionLow: number,
  minPts: number,
  minRiskRatio: number,
): boolean {
  return hasEnoughRoomToMove(
    entryPrice,
    stopLoss,
    sessionLow,
    minPts,
    minRiskRatio,
  );
}

// ─── passesCompressionFilter ─────────────────────────────────────────────────
/**
 * Returns `true` when the signal should be allowed through the compression
 * gate — i.e. either the filter is disabled, the session is not compressed,
 * or no prior signal has fired yet.
 */
function passesCompressionFilter(
  candles: DhrCandle[],
  idx: number,
  priorSignalCount: number,
  cfg: Pick<
    Required<DhrConfig>,
    | 'enableSessionCompressionFilter'
    | 'compressionFirstHourCandles'
    | 'compressionFirstHourAtrRatio'
    | 'compressionRecentWindow'
    | 'compressionOverlapThreshold'
    | 'blockRepeatedSignalsWhenCompressed'
  >,
): boolean {
  if (!cfg.enableSessionCompressionFilter) return true;
  if (!cfg.blockRepeatedSignalsWhenCompressed || priorSignalCount === 0)
    return true;
  return !isSessionCompressed(
    candles,
    idx,
    cfg.compressionFirstHourCandles,
    cfg.compressionFirstHourAtrRatio,
    cfg.compressionRecentWindow,
    cfg.compressionOverlapThreshold,
  );
}

// ─── Room-to-move filter ─────────────────────────────────────────────────────

/**
 * Returns true when the trade has enough downside room between `entryPrice`
 * and the current session low.
 *
 * Either condition must be met (not both required):
 *   1. (entry − sessionLow) >= minPts
 *   2. (entry − sessionLow) >= minRiskRatio × abs(stopLoss − entry)
 */

// ─── Adaptive threshold helpers ──────────────────────────────────────────────

function getAverageRecentRange(
  candles: DhrCandle[],
  currentIdx: number,
  lookback = 5,
): number {
  const start = Math.max(0, currentIdx - lookback);
  const slice = candles.slice(start, currentIdx);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, c) => sum + (c.high - c.low), 0) / slice.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getAdaptiveThresholds(
  candles: DhrCandle[],
  currentIdx: number,
  {
    touchTolerance,
    sweepBuffer,
    stopLossBuffer,
    zoneRearmMoveAwayPts,
    minRoomToMovePts,
  }: {
    touchTolerance: number;
    sweepBuffer: number;
    stopLossBuffer: number;
    zoneRearmMoveAwayPts: number;
    minRoomToMovePts: number;
  },
) {
  const avgRange = getAverageRecentRange(candles, currentIdx, 5);
  const adaptiveTouchTolerance = clamp(avgRange * 0.2, 2, touchTolerance);
  // Sweep buffer must always exceed touch tolerance so the sweep window is non-empty.
  // Cap at the configured sweepBuffer, but override if that would be less than touchTolerance+2.
  const rawSweep = Math.min(avgRange * 0.45, sweepBuffer);
  const adaptiveSweepBuffer = Math.max(rawSweep, adaptiveTouchTolerance + 2);
  const adaptiveStopLossBuffer = clamp(avgRange * 0.15, 2, stopLossBuffer);
  const adaptiveZoneRearmMoveAwayPts = clamp(
    avgRange * 1.2,
    10,
    zoneRearmMoveAwayPts,
  );
  const adaptiveMinRoomToMovePts = Math.max(minRoomToMovePts, avgRange * 1.2);
  return {
    avgRange,
    adaptiveTouchTolerance,
    adaptiveSweepBuffer,
    adaptiveStopLossBuffer,
    adaptiveZoneRearmMoveAwayPts,
    adaptiveMinRoomToMovePts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function hasEnoughRoomToMove(
  entryPrice: number,
  stopLoss: number,
  sessionLow: number,
  minPts: number,
  minRiskRatio: number,
): boolean {
  const roomPts = entryPrice - sessionLow;
  if (roomPts <= 0) return false;
  const risk = Math.abs(stopLoss - entryPrice);
  return roomPts >= minPts || (risk > 0 && roomPts >= minRiskRatio * risk);
}

// ─── Session compression filter ──────────────────────────────────────────────

/**
 * Returns true when the session looks compressed / range-bound.
 *
 * Scores three signals and flags compression when at least 2 fire:
 *   A. First-hour range is narrow relative to session ATR.
 *   B. Recent candles show heavy overlap.
 *   C. Full session range is narrow relative to ATR.
 */
function isSessionCompressed(
  candles: DhrCandle[],
  currentIdx: number,
  firstHourCandles: number,
  firstHourAtrRatio: number,
  recentWindow: number,
  overlapThreshold: number,
): boolean {
  if (currentIdx < 2) return false;

  const slice = candles.slice(0, currentIdx + 1);

  // ATR estimate: average true range over all candles so far
  let atrSum = 0;
  for (let k = 1; k < slice.length; k++) {
    atrSum += Math.max(
      slice[k].high - slice[k].low,
      Math.abs(slice[k].high - slice[k - 1].close),
      Math.abs(slice[k].low - slice[k - 1].close),
    );
  }
  const atr = atrSum / (slice.length - 1);
  if (atr <= 0) return false;

  let signals = 0;

  // Signal A: first-hour range is narrow
  const fhEnd = Math.min(firstHourCandles, slice.length);
  if (fhEnd >= 2) {
    const fhHigh = Math.max(...slice.slice(0, fhEnd).map((c) => c.high));
    const fhLow = Math.min(...slice.slice(0, fhEnd).map((c) => c.low));
    if (fhHigh - fhLow < firstHourAtrRatio * atr) signals++;
  }

  // Signal B: recent candle overlap is high
  const recent = slice.slice(Math.max(0, currentIdx + 1 - recentWindow));
  if (recent.length >= 3) {
    let overlaps = 0;
    for (let k = 1; k < recent.length; k++) {
      if (
        Math.min(recent[k - 1].high, recent[k].high) >
        Math.max(recent[k - 1].low, recent[k].low)
      )
        overlaps++;
    }
    if (overlaps / (recent.length - 1) >= overlapThreshold) signals++;
  }

  // Signal C: full session range is narrow
  const sessionHigh = Math.max(...slice.map((c) => c.high));
  const sessionLow = Math.min(...slice.map((c) => c.low));
  if (sessionHigh - sessionLow < firstHourAtrRatio * atr * 1.5) signals++;

  return signals >= 2;
}

// â”€â”€â”€ Main detector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Scan `candles` for Day High Rejection and Day High Sweep Rejection sell setups.
 *
 * @param candles  Ordered intraday candles, earliest first. Needs â‰¥ 2 candles.
 * @param config   Optional tuning parameters (see DhrConfig).
 * @returns        Array of detected signals (empty if none found).
 */
export function detectDayHighRejectionOnly(
  candles: DhrCandle[],
  config: DhrConfig = {},
  candles1m?: DhrCandle[],
): DhrSignal[] {
  const {
    touchTolerance = 5,
    minUpperWickRatio = 0.45,
    minBearishBodyRatio = 0.45,
    stopLossBuffer = 5,
    requireNextCandleConfirmation = false,
    sweepBuffer = 10,
    zoneCooldownCandles = 12,
    minRearmCandles = 3,
    zoneRearmMoveAwayPts = 25,
    ema20,
    ema20SessionTolerance = 0.005,
    useOneMinuteEntryConfirmation = false,
    oneMinuteConfirmationWindow = 10,
    enableTwoCandleConfirm = false,
    enableLowBreakConfirm = false,
    enableLowerHighBreakConfirm = false,
    oneMinuteStopBuffer = 3,
    enableFiveMinuteSignalLowBreakConfirm = true,
    fiveMinuteSignalStopBuffer = 3,
    minDirectEntryBodyRatio = 0.6,
    minDirectEntryWickRatio = 0.5,
    maxLowerWickRatio = 0.5,
    preferWickRejection = false,
    // Room-to-move filter
    enableRoomToMoveFilter = true,
    minRoomToMovePts = 20,
    minRoomToMoveRiskRatio = 1.5,
    // Session compression filter
    enableSessionCompressionFilter = true,
    compressionFirstHourCandles = 12,
    compressionFirstHourAtrRatio = 0.8,
    compressionRecentWindow = 8,
    compressionOverlapThreshold = 0.7,
    blockRepeatedSignalsWhenCompressed = true,
    debug = false,
    tradeStartMins = 9 * 60 + 30,
    tradeEndMins = 14 * 60 + 30,
    minZoneAgeCandles = 0,
  } = config;

  const use1m =
    useOneMinuteEntryConfirmation &&
    Array.isArray(candles1m) &&
    candles1m.length > 0;

  const log = debug
    ? (...args: unknown[]) => console.log('[DHR]', ...args)
    : () => {};

  const signals: DhrSignal[] = [];

  if (candles.length < 2) {
    log('Not enough candles (need â‰¥ 2). Skipping.');
    return signals;
  }

  // Seed log filename with target date (candle date, not today's date)
  try {
    _dhrTargetDate = new Date(candles[0].date as any)
      .toISOString()
      .slice(0, 10);
  } catch {
    /* ignore */
  }

  // ── Session activation gate (20-EMA bearish-open filter) ──────────────────
  if (!checkSessionGate(candles, ema20, ema20SessionTolerance, log)) {
    return signals;
  }

  // ── Session confidence score ───────────────────────────────────────────────
  // Score 10: clean bearish open (first candle opened AT or BELOW EMA20, no tolerance used).
  // Score  6: marginal session (open inside EMA20 tolerance band i.e. slightly above ema20).
  // Score is attached to every signal so callers can size position accordingly:
  //   score=10 → full qty | score=6 → half qty
  const firstOpen0 = candles[0].open;
  const sessionScore: 10 | 6 =
    ema20 == null || ema20 <= 0 || firstOpen0 <= ema20 ? 10 : 6;
  const sessionGrade: 'A' | 'B' = sessionScore === 10 ? 'A' : 'B';
  log(
    `Session score=${sessionScore} (${sessionGrade}) — firstOpen=${firstOpen0} vs EMA20=${ema20 ?? 'n/a'}`,
  );

  // First candle seeds the rolling high; never a signal candle itself.
  let rollingHigh = candles[0].high;
  // Tracks the candle index where rollingHigh was last updated.
  // Used by the minZoneAgeCandles gate: a freshly-set rolling high (age < N)
  // is a transient local peak, not a meaningful day-high resistance zone.
  let rollingHighLastSetAtIdx = 0;
  let sessionLow = candles[0].low; // tracks intraday low for room-to-move filter
  log(
    `Seed: rolling high = ${rollingHigh} from first candle ${candleLabel(candles[0], 0)}`,
  );

  // Pending setup for next-candle confirmation (one at a time).
  let pendingSetup: {
    setupIndex: number;
    zoneReference: number;
    setupCandleLow: number;
    setupCandleMid: number;
    setupType: 'DAY_HIGH_REJECTION' | 'DAY_HIGH_SWEEP_REJECTION';
    adaptiveStopLossBuffer: number;
  } | null = null;

  // Zone cooldown state.
  let cooldownZone: number | null = null;
  let cooldownFromIdx = -1;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const label = candleLabel(candle, i);

    // ── Adaptive thresholds for this candle ──────────────────────────────────
    const {
      adaptiveTouchTolerance,
      adaptiveSweepBuffer,
      adaptiveStopLossBuffer,
      adaptiveZoneRearmMoveAwayPts,
      adaptiveMinRoomToMovePts,
    } = getAdaptiveThresholds(candles, i, {
      touchTolerance,
      sweepBuffer,
      stopLossBuffer,
      zoneRearmMoveAwayPts,
      minRoomToMovePts,
    });
    // â”€â”€ Step 1: Attempt to confirm the previous candle's pending setup â”€â”€â”€â”€â”€â”€â”€
    if (pendingSetup) {
      const prev = pendingSetup;
      pendingSetup = null;

      const confirmedByLowBreak = candle.low < prev.setupCandleLow;
      const confirmedByMidBreak = candle.close < prev.setupCandleMid;

      if (confirmedByLowBreak || confirmedByMidBreak) {
        const entryPrice = candle.close;
        const stopLoss = prev.zoneReference + prev.adaptiveStopLossBuffer;
        const trigger = confirmedByLowBreak
          ? `broke setup-candle low (${prev.setupCandleLow.toFixed(1)})`
          : `closed below setup-candle midpoint (${prev.setupCandleMid.toFixed(1)})`;

        log(
          `${label} âœ… CONFIRMED entry @ ${entryPrice} | ${trigger} | zone ${prev.zoneReference.toFixed(1)} | SL ${stopLoss.toFixed(1)}`,
        );

        const confirmedRisk = stopLoss - entryPrice;
        const confirmedSig: DhrSignal = {
          strategyName: 'Day High Rejection Only',
          signal: true,
          setupType: prev.setupType,
          entryPrice,
          stopLoss,
          t1: entryPrice - confirmedRisk,
          t2: entryPrice - confirmedRisk * 2,
          t3: entryPrice - confirmedRisk * 3,
          zoneReference: prev.zoneReference,
          setupIndex: prev.setupIndex,
          confirmIndex: i,
          reason: `Confirmed (${trigger}): zone ${prev.zoneReference.toFixed(1)}`,
          score: sessionScore,
          setupGrade: sessionGrade,
        };
        // ── Room-to-move + compression gates ──────────────────────────────────
        const confirmedPassesRtm =
          !enableRoomToMoveFilter ||
          passesRoomToMove(
            entryPrice,
            stopLoss,
            sessionLow,
            adaptiveMinRoomToMovePts,
            minRoomToMoveRiskRatio,
          );
        const confirmedPassesComp = passesCompressionFilter(
          candles,
          i,
          signals.length,
          {
            enableSessionCompressionFilter,
            compressionFirstHourCandles,
            compressionFirstHourAtrRatio,
            compressionRecentWindow,
            compressionOverlapThreshold,
            blockRepeatedSignalsWhenCompressed,
          },
        );
        if (!confirmedPassesRtm) {
          log(
            `${label}  ✗ CONFIRMED SKIPPED: not enough room to move (entry=${entryPrice.toFixed(1)}, SL=${stopLoss.toFixed(1)}, sessionLow=${sessionLow.toFixed(1)})`,
          );
        } else if (!confirmedPassesComp) {
          log(
            `${label}  ✗ CONFIRMED SKIPPED: session compressed and prior signal exists`,
          );
        } else {
          const sigD = new Date(candle.date as any);
          const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
          if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
            signals.push(confirmedSig);
            cooldownZone = prev.zoneReference;
            cooldownFromIdx = i;
            dhrFileLog('[DHR-SIGNAL-CONFIRMED]', {
              candleTime: label,
              entryPrice,
              stopLoss,
              zone: prev.zoneReference,
              trigger,
              setupType: prev.setupType,
              setupIndex: prev.setupIndex,
              confirmIndex: i,
              score: sessionScore,
              setupGrade: sessionGrade,
              volume: candle.volume,
            });
          }
        }
      } else {
        log(
          `${label} ❌ Pending setup from index ${prev.setupIndex} NOT confirmed — low ${candle.low.toFixed(1)} vs ${prev.setupCandleLow.toFixed(1)}, close ${candle.close.toFixed(1)} vs mid ${prev.setupCandleMid.toFixed(1)}`,
        );
      }
    }

    // -- Step 2: Capture previous rolling high BEFORE updating it ----------
    const intradayDayHigh = rollingHigh;

    log(
      `${label}  H=${candle.high} L=${candle.low} O=${candle.open} C=${candle.close} Vol=${candle.volume ?? 0} | prev-rolling-high=${intradayDayHigh.toFixed(1)}`,
    );

    // -- Step 3: Zone cooldown check
    if (
      cooldownZone !== null &&
      Math.abs(intradayDayHigh - cooldownZone) < adaptiveTouchTolerance
    ) {
      const candlesSinceSig = i - cooldownFromIdx;
      const movedAway =
        candle.close < cooldownZone - adaptiveZoneRearmMoveAwayPts;

      if (
        candlesSinceSig >= zoneCooldownCandles ||
        (movedAway && candlesSinceSig >= minRearmCandles)
      ) {
        log(
          `${label} Zone ${cooldownZone.toFixed(1)} REARMED (candlesSince=${candlesSinceSig}, movedAway=${movedAway})`,
        );
        dhrFileLog('[DHR-ZONE-REARMED]', {
          candleTime: label,
          zone: cooldownZone,
          candlesSinceSig,
          movedAway,
        });
        cooldownZone = null;
        cooldownFromIdx = -1;
      } else {
        log(
          `${label}  â¸ Zone ${intradayDayHigh.toFixed(1)} in COOLDOWN (${candlesSinceSig}/${zoneCooldownCandles} candles, movedAway=${movedAway})`,
        );
        dhrFileLog('[DHR-ZONE-COOLDOWN]', {
          candleTime: label,
          zone: intradayDayHigh,
          candlesSinceSig,
          zoneCooldownCandles,
        });
        if (candle.high > rollingHigh) { rollingHigh = candle.high; rollingHighLastSetAtIdx = i; }
        if (candle.low < sessionLow) sessionLow = candle.low;
        continue;
      }
    }

    // -- Step 3b: Zone-age gate ------------------------------------------------
    // Require the rolling high to have held for minZoneAgeCandles candles
    // without being surpassed.  A zone set just 1–2 candles ago is a transient
    // local peak, not a proven day-high resistance level.  This prevents DHR
    // from firing on morning bumps that later get surpassed (the live scheduler
    // sees only a partial-day candle set, so a local high appears to be the
    // day high until the market pushes through it later).
    const zoneAge = i - rollingHighLastSetAtIdx;
    if (minZoneAgeCandles > 0 && zoneAge < minZoneAgeCandles) {
      log(
        `${label}  ⏳ Zone age ${zoneAge}/${minZoneAgeCandles} candles — too young to trigger DHR`,
      );
      if (candle.high > rollingHigh) {
        rollingHigh = candle.high;
        rollingHighLastSetAtIdx = i;
      }
      if (candle.low < sessionLow) sessionLow = candle.low;
      continue;
    }

    // -- Step 4a: Sweep / failed-breakout detection ----------------------------
    const sweepResult = checkSweepCandidate(
      candle,
      intradayDayHigh,
      adaptiveTouchTolerance,
      adaptiveSweepBuffer,
      minBearishBodyRatio,
      minUpperWickRatio,
    );

    if (sweepResult.isSweep) {
      if (!sweepResult.sweepRejectionValid) {
        log(
          `${label}  \u2717 Sweep candidate \u2014 rejection quality insufficient (wick=${(sweepResult.upperWickRatio * 100).toFixed(0)}%, red=${sweepResult.isRedCandle})`,
        );
      } else {
        const { sweepReason } = sweepResult;
        const setupCandleMid = (candle.high + candle.low) / 2;

        log(
          `${label}  \uD83C\uDF0A SWEEP: zone ${intradayDayHigh.toFixed(1)} | high ${candle.high} | ${sweepReason}`,
        );

        if (!requireNextCandleConfirmation) {
          if (use1m) {
            // -- 1-minute confirmation mode ------------------------------------
            log(
              `${label}  [1m] SWEEP setup detected \u2014 entering 1-minute confirmation window (max ${oneMinuteConfirmationWindow} candles)`,
            );
            dhrFileLog('[DHR-1M-SWEEP-SETUP]', {
              candleTime: label,
              zone: intradayDayHigh,
              sweepHigh: candle.high,
              sweepReason,
              volume: candle.volume,
            });

            const {
              confirmed,
              confirmType,
              confirm1mIdx,
              entryPrice,
              stopLoss,
            } = confirmWith1m(
              candles1m!,
              candle,
              candle.high,
              adaptiveStopLossBuffer,
              {
                oneMinuteConfirmationWindow,
                enableTwoCandleConfirm,
                enableLowBreakConfirm,
                enableLowerHighBreakConfirm,
                enableFiveMinuteSignalLowBreakConfirm,
                oneMinuteStopBuffer,
                fiveMinuteSignalStopBuffer,
                minUpperWickRatio,
              },
              log,
              label,
            );

            if (confirmed) {
              if (confirmType === 'FIVE_MIN_SIGNAL_LOW_BREAK') {
                dhrFileLog('[DHR-1M-5MIN-LOW-BREAK-SWEEP]', {
                  candleTime: label,
                  setup5mLow: candle.low,
                  setup5mHigh: candle.high,
                  entryPrice,
                  stopLoss,
                  confirm1mIdx,
                  volume: candle.volume,
                });
              }
              const sweepRisk1m = stopLoss - entryPrice;
              const sweepSig1m: DhrSignal = {
                strategyName: 'Day High Rejection Only',
                signal: true,
                setupType: 'DAY_HIGH_SWEEP_REJECTION',
                entryPrice,
                stopLoss,
                t1: entryPrice - sweepRisk1m,
                t2: entryPrice - sweepRisk1m * 2,
                t3: entryPrice - sweepRisk1m * 3,
                zoneReference: intradayDayHigh,
                setupIndex: i,
                confirmIndex: null,
                reason: `Sweep(1m ${confirmType}): ${sweepReason}`,
                oneMinuteConfirmationType: confirmType,
                oneMinuteConfirmIndex: confirm1mIdx,
                score: sessionScore,
                setupGrade: sessionGrade,
              };
              const sweep1mPassesRtm =
                !enableRoomToMoveFilter ||
                passesRoomToMove(
                  entryPrice,
                  stopLoss,
                  sessionLow,
                  adaptiveMinRoomToMovePts,
                  minRoomToMoveRiskRatio,
                );
              const sweep1mPassesComp = passesCompressionFilter(
                candles,
                i,
                signals.length,
                {
                  enableSessionCompressionFilter,
                  compressionFirstHourCandles,
                  compressionFirstHourAtrRatio,
                  compressionRecentWindow,
                  compressionOverlapThreshold,
                  blockRepeatedSignalsWhenCompressed,
                },
              );
              if (!sweep1mPassesRtm) {
                log(
                  `${label}  \u2717 SWEEP-1M SKIPPED: not enough room to move (entry=${entryPrice.toFixed(1)}, SL=${stopLoss.toFixed(1)}, sessionLow=${sessionLow.toFixed(1)})`,
                );
                dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
                  candleTime: label,
                  skipReason: 'room-to-move',
                  path: 'SWEEP-1M',
                  zone: intradayDayHigh,
                  entryPrice,
                  stopLoss,
                  sessionLow: +sessionLow.toFixed(1),
                  score: sessionScore,
                  setupGrade: sessionGrade,
                  volume: candle.volume,
                });
              } else if (!sweep1mPassesComp) {
                log(
                  `${label}  \u2717 SWEEP-1M SKIPPED: session compressed and prior signal exists`,
                );
                dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
                  candleTime: label,
                  skipReason: 'session-compressed',
                  path: 'SWEEP-1M',
                  zone: intradayDayHigh,
                  score: sessionScore,
                  setupGrade: sessionGrade,
                  volume: candle.volume,
                });
              } else {
                const sigD = new Date(candle.date as any);
                const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
                if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
                  signals.push(sweepSig1m);
                  cooldownZone = intradayDayHigh;
                  cooldownFromIdx = i;
                  dhrFileLog('[DHR-1M-CONFIRMED]', {
                    candleTime: label,
                    confirmType,
                    entryPrice,
                    stopLoss,
                    zone: intradayDayHigh,
                    confirm1mIdx,
                    score: sessionScore,
                    setupGrade: sessionGrade,
                    volume: candle.volume,
                  });
                }
              }
            } else {
              log(
                `${label}  [1m] \u23F1 SWEEP setup expired \u2014 no 1m confirmation in window`,
              );
              dhrFileLog('[DHR-1M-EXPIRED]', {
                candleTime: label,
                setupType: 'SWEEP',
                zone: intradayDayHigh,
                volume: candle.volume,
              });
            }
          } else {
            // -- Original direct-entry path (1m mode off) ----------------------
            const entryPrice = candle.close;
            const stopLoss = candle.high + adaptiveStopLossBuffer;
            const sweepRisk = stopLoss - entryPrice;
            const sweepSig: DhrSignal = {
              strategyName: 'Day High Rejection Only',
              signal: true,
              setupType: 'DAY_HIGH_SWEEP_REJECTION',
              entryPrice,
              stopLoss,
              t1: entryPrice - sweepRisk,
              t2: entryPrice - sweepRisk * 2,
              t3: entryPrice - sweepRisk * 3,
              zoneReference: intradayDayHigh,
              setupIndex: i,
              confirmIndex: null,
              reason: `Sweep: ${sweepReason}`,
              score: sessionScore,
              setupGrade: sessionGrade,
            };
            const sweepPassesRtm =
              !enableRoomToMoveFilter ||
              passesRoomToMove(
                entryPrice,
                stopLoss,
                sessionLow,
                adaptiveMinRoomToMovePts,
                minRoomToMoveRiskRatio,
              );
            const sweepPassesComp = passesCompressionFilter(
              candles,
              i,
              signals.length,
              {
                enableSessionCompressionFilter,
                compressionFirstHourCandles,
                compressionFirstHourAtrRatio,
                compressionRecentWindow,
                compressionOverlapThreshold,
                blockRepeatedSignalsWhenCompressed,
              },
            );
            if (!sweepPassesRtm) {
              log(
                `${label}  \u2717 SWEEP SKIPPED: not enough room to move (entry=${entryPrice.toFixed(1)}, SL=${stopLoss.toFixed(1)}, sessionLow=${sessionLow.toFixed(1)})`,
              );
            } else if (!sweepPassesComp) {
              log(
                `${label}  \u2717 SWEEP SKIPPED: session compressed and prior signal exists`,
              );
            } else {
              const sigD = new Date(candle.date as any);
              const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
              if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
                signals.push(sweepSig);
                cooldownZone = intradayDayHigh;
                cooldownFromIdx = i;
                dhrFileLog('[DHR-SIGNAL-SWEEP]', {
                  candleTime: label,
                  entryPrice,
                  stopLoss,
                  zone: intradayDayHigh,
                  sweepHigh: candle.high,
                  setupIndex: i,
                  volume: candle.volume,
                });
              }
            }
          }
        } else {
          log(
            `${label}  \u23F3 SWEEP PENDING confirmation: zone ${intradayDayHigh.toFixed(1)} | setup-low=${candle.low}`,
          );
          pendingSetup = {
            setupIndex: i,
            zoneReference: intradayDayHigh,
            setupCandleLow: candle.low,
            setupCandleMid,
            setupType: 'DAY_HIGH_SWEEP_REJECTION',
            adaptiveStopLossBuffer,
          };
        }

        if (candle.high > rollingHigh) { rollingHigh = candle.high; rollingHighLastSetAtIdx = i; }
        if (candle.low < sessionLow) sessionLow = candle.low;
        continue;
      }
    }

    // â”€â”€ Step 4b: Near-touch zone detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Upper bound uses sweepBuffer (not touchTolerance) so candles that
    // overshoot the zone slightly are still caught as zone touches.
    const touchesZone =
      candle.high >= intradayDayHigh - adaptiveTouchTolerance &&
      candle.high <= intradayDayHigh + adaptiveSweepBuffer;

    if (!touchesZone) {
      if (candle.high > intradayDayHigh + adaptiveSweepBuffer) {
        log(
          `${label}  â†” Candle high ${candle.high} exceeded zone + sweep buffer (${(intradayDayHigh + adaptiveSweepBuffer).toFixed(1)}) â€” real breakout`,
        );
      } else {
        log(
          `${label}  - Candle high ${candle.high} did not reach zone ${intradayDayHigh.toFixed(1)} (tolerance=${adaptiveTouchTolerance.toFixed(2)})`,
        );
      }
      if (candle.high > rollingHigh) { rollingHigh = candle.high; rollingHighLastSetAtIdx = i; }
      if (candle.low < sessionLow) sessionLow = candle.low;
      continue;
    }

    log(
      `${label}  ðŸŽ¯ Candle high ${candle.high} TOUCHES zone ${intradayDayHigh.toFixed(1)} (Â±${touchTolerance})`,
    );

    // -- Step 5: Evaluate rejection quality -----------------------------------
    const zr = checkZoneRejection(
      candle,
      intradayDayHigh,
      minUpperWickRatio,
      minBearishBodyRatio,
      maxLowerWickRatio,
    );

    if (!zr.isRejection) {
      log(
        `${label}  \u2717 Zone touch \u2013 rejection NOT met: ${zr.rejectBlockReason}`,
      );
      dhrFileLog('[DHR-REJECTION-BLOCKED]', {
        candleTime: label,
        zone: intradayDayHigh,
        rejectReason: zr.rejectBlockReason,
        lowerWickTooLarge: zr.lowerWickTooLarge,
        upperWick: +zr.upperWick.toFixed(1),
        lowerWick: +zr.lowerWick.toFixed(1),
        upperWickRatio: +(zr.upperWickRatio * 100).toFixed(0),
        bearishBodyRatio: +(zr.bearishBodyRatio * 100).toFixed(0),
        isRedCandle: candle.close < candle.open,
        closePositionInRange: 0,
        volume: candle.volume,
      });
      if (candle.high > rollingHigh) { rollingHigh = candle.high; rollingHighLastSetAtIdx = i; }
      if (candle.low < sessionLow) sessionLow = candle.low;
      continue;
    }

    const {
      rejectionReason,
      hasSignificantUpperWick,
      hasStrongBearishBodyRejection,
    } = zr;

    // -- Step 6: Direct entry or queue for confirmation ----------------------
    const setupCandleMid = (candle.high + candle.low) / 2;

    if (!requireNextCandleConfirmation) {
      if (use1m) {
        // -- 1-minute confirmation mode ----------------------------------------
        log(
          `${label}  [1m] ZONE setup detected \u2014 entering 1-minute confirmation window (max ${oneMinuteConfirmationWindow} candles)`,
        );
        dhrFileLog('[DHR-1M-SETUP]', {
          candleTime: label,
          zone: intradayDayHigh,
          rejection: rejectionReason,
          volume: candle.volume,
        });

        const { confirmed, confirmType, confirm1mIdx, entryPrice, stopLoss } =
          confirmWith1m(
            candles1m!,
            candle,
            intradayDayHigh,
            adaptiveStopLossBuffer,
            {
              oneMinuteConfirmationWindow,
              enableTwoCandleConfirm,
              enableLowBreakConfirm,
              enableLowerHighBreakConfirm,
              enableFiveMinuteSignalLowBreakConfirm,
              oneMinuteStopBuffer,
              fiveMinuteSignalStopBuffer,
              minUpperWickRatio,
            },
            log,
            label,
          );

        if (confirmed) {
          if (confirmType === 'FIVE_MIN_SIGNAL_LOW_BREAK') {
            dhrFileLog('[DHR-1M-5MIN-LOW-BREAK-ZONE]', {
              candleTime: label,
              setup5mLow: candle.low,
              setup5mHigh: candle.high,
              entryPrice,
              stopLoss,
              confirm1mIdx,
              volume: candle.volume,
            });
          }
          const directRisk1m = stopLoss - entryPrice;
          const directSig1m: DhrSignal = {
            strategyName: 'Day High Rejection Only',
            signal: true,
            setupType: 'DAY_HIGH_REJECTION',
            entryPrice,
            stopLoss,
            t1: entryPrice - directRisk1m,
            t2: entryPrice - directRisk1m * 2,
            t3: entryPrice - directRisk1m * 3,
            zoneReference: intradayDayHigh,
            setupIndex: i,
            confirmIndex: null,
            reason: `Zone(1m ${confirmType}): zone ${intradayDayHigh.toFixed(1)} | ${rejectionReason}`,
            oneMinuteConfirmationType: confirmType,
            oneMinuteConfirmIndex: confirm1mIdx,
            score: sessionScore,
            setupGrade: sessionGrade,
          };
          const zone1mPassesRtm =
            !enableRoomToMoveFilter ||
            passesRoomToMove(
              entryPrice,
              stopLoss,
              sessionLow,
              adaptiveMinRoomToMovePts,
              minRoomToMoveRiskRatio,
            );
          const zone1mPassesComp = passesCompressionFilter(
            candles,
            i,
            signals.length,
            {
              enableSessionCompressionFilter,
              compressionFirstHourCandles,
              compressionFirstHourAtrRatio,
              compressionRecentWindow,
              compressionOverlapThreshold,
              blockRepeatedSignalsWhenCompressed,
            },
          );
          if (!zone1mPassesRtm) {
            log(
              `${label}  \u2717 ZONE-1M SKIPPED: not enough room to move (entry=${entryPrice.toFixed(1)}, SL=${stopLoss.toFixed(1)}, sessionLow=${sessionLow.toFixed(1)})`,
            );
            dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
              candleTime: label,
              skipReason: 'room-to-move',
              path: 'ZONE-1M',
              zone: intradayDayHigh,
              entryPrice,
              stopLoss,
              sessionLow: +sessionLow.toFixed(1),
              score: sessionScore,
              setupGrade: sessionGrade,
              volume: candle.volume,
            });
          } else if (!zone1mPassesComp) {
            log(
              `${label}  \u2717 ZONE-1M SKIPPED: session compressed and prior signal exists`,
            );
            dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
              candleTime: label,
              skipReason: 'session-compressed',
              path: 'ZONE-1M',
              zone: intradayDayHigh,
              score: sessionScore,
              setupGrade: sessionGrade,
              volume: candle.volume,
            });
          } else {
            const sigD = new Date(candle.date as any);
            const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
            if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
              signals.push(directSig1m);
              cooldownZone = intradayDayHigh;
              cooldownFromIdx = i;
              dhrFileLog('[DHR-1M-CONFIRMED]', {
                candleTime: label,
                confirmType,
                entryPrice,
                stopLoss,
                zone: intradayDayHigh,
                rejection: rejectionReason,
                confirm1mIdx,
                score: sessionScore,
                setupGrade: sessionGrade,
                volume: candle.volume,
              });
            }
          }
        } else {
          log(
            `${label}  [1m]  ZONE setup expired \u2014 no 1m confirmation in window`,
          );
          dhrFileLog('[DHR-1M-EXPIRED]', {
            candleTime: label,
            setupType: 'DAY_HIGH_REJECTION',
            zone: intradayDayHigh,
            volume: candle.volume,
          });
        }
      } else {
        // -- Original direct-entry path (1m mode off) --------------------------
        if (
          !isStrongDirectDhrSignal(
            candle,
            minDirectEntryBodyRatio,
            minDirectEntryWickRatio,
          )
        ) {
          log(
            `${label}  \u2717 Direct entry skipped \u2014 weak rejection (body=${(zr.bearishBodyRatio * 100).toFixed(0)}%, wick=${(zr.upperWickRatio * 100).toFixed(0)}%)`,
          );
          dhrFileLog('[DHR-DIRECT-SKIPPED-WEAK]', {
            candleTime: label,
            zone: intradayDayHigh,
            bearishBodyRatio: zr.bearishBodyRatio,
            upperWickRatio: zr.upperWickRatio,
            rejection: rejectionReason,
            volume: candle.volume,
          });
        } else if (preferWickRejection && !hasSignificantUpperWick) {
          log(
            `${label}  \u2717 Direct entry skipped \u2014 preferWickRejection=true but no significant upper wick (wick=${(zr.upperWickRatio * 100).toFixed(0)}%, need ${(minUpperWickRatio * 100).toFixed(0)}%)`,
          );
          dhrFileLog('[DHR-DIRECT-SKIPPED-NO-WICK]', {
            candleTime: label,
            zone: intradayDayHigh,
            upperWickRatio: zr.upperWickRatio,
            rejection: rejectionReason,
            volume: candle.volume,
          });
        } else {
          const entryPrice = candle.close;
          const stopLoss = intradayDayHigh + adaptiveStopLossBuffer;

          log(
            `${label}   DIRECT ENTRY @ ${entryPrice} | ${rejectionReason} | zone ${intradayDayHigh.toFixed(1)} | SL ${stopLoss.toFixed(1)}`,
          );

          // Score refinement: body-only rejection in an A session demotes to score=6.
          const directScore: 10 | 6 =
            sessionScore === 10 && !hasSignificantUpperWick ? 6 : sessionScore;
          const directGrade: 'A' | 'B' = directScore === 10 ? 'A' : 'B';

          const directRisk = stopLoss - entryPrice;
          const directSig: DhrSignal = {
            strategyName: 'Day High Rejection Only',
            signal: true,
            setupType: 'DAY_HIGH_REJECTION',
            entryPrice,
            stopLoss,
            t1: entryPrice - directRisk,
            t2: entryPrice - directRisk * 2,
            t3: entryPrice - directRisk * 3,
            zoneReference: intradayDayHigh,
            setupIndex: i,
            confirmIndex: null,
            reason: `Direct: zone ${intradayDayHigh.toFixed(1)} | ${rejectionReason}`,
            score: directScore,
            setupGrade: directGrade,
          };
          const directPassesRtm =
            !enableRoomToMoveFilter ||
            passesRoomToMove(
              entryPrice,
              stopLoss,
              sessionLow,
              adaptiveMinRoomToMovePts,
              minRoomToMoveRiskRatio,
            );
          const directPassesComp = passesCompressionFilter(
            candles,
            i,
            signals.length,
            {
              enableSessionCompressionFilter,
              compressionFirstHourCandles,
              compressionFirstHourAtrRatio,
              compressionRecentWindow,
              compressionOverlapThreshold,
              blockRepeatedSignalsWhenCompressed,
            },
          );
          if (!directPassesRtm) {
            log(
              `${label}  \u2717 DIRECT SKIPPED: not enough room to move (entry=${entryPrice.toFixed(1)}, SL=${stopLoss.toFixed(1)}, sessionLow=${sessionLow.toFixed(1)})`,
            );
            dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
              candleTime: label,
              skipReason: 'room-to-move',
              path: 'DIRECT',
              zone: intradayDayHigh,
              entryPrice,
              stopLoss,
              sessionLow: +sessionLow.toFixed(1),
              score: directScore,
              setupGrade: directGrade,
              volume: candle.volume,
            });
          } else if (!directPassesComp) {
            log(
              `${label}  \u2717 DIRECT SKIPPED: session compressed and prior signal exists`,
            );
            dhrFileLog('[DHR-SIGNAL-SKIPPED]', {
              candleTime: label,
              skipReason: 'session-compressed',
              path: 'DIRECT',
              zone: intradayDayHigh,
              score: directScore,
              setupGrade: directGrade,
              volume: candle.volume,
            });
          } else {
            const sigD = new Date(candle.date as any);
            const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
            if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
              signals.push(directSig);
              cooldownZone = intradayDayHigh;
              cooldownFromIdx = i;
              dhrFileLog('[DHR-SIGNAL-DIRECT]', {
                candleTime: label,
                entryPrice,
                stopLoss,
                zone: intradayDayHigh,
                rejection: rejectionReason,
                setupIndex: i,
                score: directScore,
                setupGrade: directGrade,
                volume: candle.volume,
              });
            }
          }
        }
      }
    } else {
      log(
        `${label}  \u23F3 PENDING confirmation: zone ${intradayDayHigh.toFixed(1)} | ${rejectionReason} | setup-low=${candle.low} mid=${setupCandleMid.toFixed(1)}`,
      );
      pendingSetup = {
        setupIndex: i,
        zoneReference: intradayDayHigh,
        setupCandleLow: candle.low,
        setupCandleMid,
        setupType: 'DAY_HIGH_REJECTION',
        adaptiveStopLossBuffer,
      };
    }
    // â”€â”€ Step 7: Update rolling high AFTER evaluation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (candle.high > rollingHigh) { rollingHigh = candle.high; rollingHighLastSetAtIdx = i; }
    if (candle.low < sessionLow) sessionLow = candle.low;
  }

  log(`Scan complete. ${signals.length} signal(s) found.`);
  dhrFileLog('[DHR-SCAN-COMPLETE]', {
    totalCandles: candles.length,
    totalSignals: signals.length,
  });
  return signals;
}

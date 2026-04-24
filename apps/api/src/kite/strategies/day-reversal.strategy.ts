/**
 * Day Reversal Strategy (v1)
 *
 * Detects the "Day Peak Reversal" sell signal on 5-minute intraday candles.
 *
 * Signal logic (all conditions must be satisfied):
 *   1. An uptrend is established from the session open — the current candle's
 *      high must be a NEW session high (higher than every prior intraday high).
 *   2. That "Peak candle" (c1) may be bullish or bearish; what matters is that
 *      it prints the highest point of the day up to that moment.
 *   3. The VERY NEXT candle (c2) is a strong bearish reversal:
 *        a. Type: BEAR  (close < open).
 *        b. Bearish body ≥ minReversalBodyRatio × total range  (default 50%).
 *        c. Upper wick ≤ maxUpperWickRatio × total range       (default 30%) —
 *           price opens at/near the top and is immediately rejected downward.
 *        d. c2 close falls into the lower portion of c1's range:
 *             c2.close < (c1.open + c1.close) / 2
 *           (confirms meaningful give-back, not just a small dip).
 *   4. Optional rally gate: c1.high must be at least minRallyPoints above the
 *      first 5-minute candle's open. Disabled by default (0) — use minDayLowRR
 *      for quality filtering on options charts.
 *   5. One signal per session — after the first valid signal no further signals
 *      are generated.
 *   6. Optional time gate: only signals between tradeStartMins and tradeEndMins.
 *
 * Entry  : c2 close
 * SL     : c1.high + stopLossBuffer
 * Targets: T1 = entry − risk × 1
 *          T2 = entry − risk × 2
 *          T3 = entry − risk × 3
 *
 * Real-world basis (NIFTY 26APR 24400 PE, 2026-04-22):
 *   09:15 open ≈ 206 → rallied steadily to 10:20 session high 280.00.
 *   10:20 candle (c1): BULL, body 60.9%, new session high 280.00.
 *   10:25 candle (c2): BEAR, body 79.4%, upper wick 0.25 pts (≈0% of range),
 *                      close 264.10 (well below c1 midpoint 268.22).
 *   Entry 264.10 | SL 283.00 (280 + 3) | T1 245 | T2 226 | T3 207.
 *   PE fell from 273 → 220 in the next 90 minutes → T2 hit.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import fs from 'fs';
import path from 'path';

// ─── Candle ───────────────────────────────────────────────────────────────────

export interface DrCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** Date/time of the candle. Used for time-gate checks and labels only. */
  date: Date | string | number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface DrConfig {
  /**
   * Minimum points the session must have rallied (c1.high vs first-candle open)
   * before a reversal signal is considered.
   *
   * NOTE: This filter is designed for spot/index charts (e.g. NIFTY 50) where
   * a meaningful rally is tens of points.  On options charts the absolute
   * point scale is completely different, so this filter is disabled by default
   * (0 = off).  Use minDayLowRR to enforce trade quality instead.
   *
   * Set > 0 only when running against spot/index candles.
   * Default: 0  (disabled)
   */
  minRallyPoints?: number;

  /**
   * Minimum bearish body / total-range ratio for the reversal candle (c2).
   * Ensures c2 is a genuinely strong bear bar — not an indecisive doji.
   * Default: 0.50
   */
  minReversalBodyRatio?: number;

  /**
   * Maximum upper-wick / total-range ratio for the reversal candle (c2).
   * A tiny upper wick means price was immediately rejected from the session
   * peak — no attempt at continuation was made.
   * Default: 0.30
   */
  maxUpperWickRatio?: number;

  /**
   * Require c2 close to fall below the midpoint of c1's open-close range.
   * When true (default), the reversal must give back a meaningful portion of
   * c1's body, filtering out shallow dips.
   * Default: true
   */
  requireCloseBelow5mMidpoint?: boolean;

  /**
   * Points added above c1.high for stop-loss placement.
   * Default: 3
   */
  stopLossBuffer?: number;

  /**
   * Minimum stop-loss distance (points) from entry to the SL.
   * Prevents overly tight SLs on low-range candles.
   * Default: 10
   */
  minStopLossPoints?: number;

  /**
   * Minimum Risk:Reward ratio (target1 / risk).
   * If the nearest support below entry is closer than risk × minRRRatio,
   * the signal is skipped.  Set to 0 to disable the RR filter.
   * Default: 1.5
   */
  minRRRatio?: number;

  /**
   * Number of recent 5m candles to scan for nearest support when applying
   * the RR filter.
   * Default: 15
   */
  rrLookbackCandles?: number;

  /**
   * Pre-calculated 20-EMA value at the session open (seeded from yesterday).
   * Used for session confidence scoring only — NOT as a signal gate.
   * Score 10 (Grade A) when firstOpen ≤ EMA20  → clean bearish session.
   * Score  6 (Grade B) when firstOpen > EMA20   → more cautious.
   * Default: undefined (Grade A always)
   */
  ema20?: number;

  /**
   * Earliest signal time in minutes from midnight.
   * Signals whose c2 candle falls before this time are skipped.
   * Default: 570  (09:30 AM)
   */
  tradeStartMins?: number;

  /**
   * Latest signal time in minutes from midnight.
   * Signals whose c2 candle falls after this time are skipped.
   * Default: 810  (01:30 PM)
   */
  tradeEndMins?: number;

  /**
   * Skip the reversal signal if the reversal candle (c2) lower wick is this
   * many times larger than its upper wick.  A big lower wick on c2 means
   * buyers pushed price well back up from the lows — weakening bearish
   * conviction even though the candle closed below its open.
   *
   * Rule: if c2LowerWick ≥ c2LowerWickMaxMultiple × c2UpperWick → skip.
   * Only evaluated when c2UpperWick > 0 (if upper wick is zero the candle is
   * already a strong bear bar, so the filter is bypassed).
   * Exception: bypassed entirely when c1 has a long upper wick
   * (see c1UpperWickBypassRatio).
   * Set to 0 to disable.
   * Default: 2
   */
  c2LowerWickMaxMultiple?: number;

  /**
   * Minimum upper-wick / total-range ratio for the PEAK candle (c1) that
   * causes the c2 lower-wick filter to be bypassed.
   *
   * When c1's upper wick is large it already signals strong supply/rejection
   * at the session high.  In that context a c2 candle with a bigger lower
   * wick is still bearishly valid because the sellers already showed their
   * hand on c1 (see: NIFTY 50 Mar 20 11:15-11:20 AM setup).
   *
   * Rule: if c1UpperWick / c1Range ≥ c1UpperWickBypassRatio → skip the
   *       c2 lower-wick check entirely and allow the signal.
   * Set to 1 (100%) to effectively disable the bypass.
   * Default: 0.30  (30% — c1's upper wick covers ≥ 30% of its range)
   */
  c1UpperWickBypassRatio?: number;

  /**
   * Minimum Risk:Reward ratio measured against the current session's low.
   *
   * Before taking the trade we check whether there is physically enough room
   * between the entry price and the day's low to reach T2 (1:2).  If the day
   * low is too close to entry the T2 target is blocked and the trade is not
   * worth taking.
   *
   * Rule: (entryPrice − sessionLow) ≥ risk × minDayLowRR  → allow.
   *       Otherwise → skip.
   *
   * sessionLow = lowest low of all candles from 9:15 up to and including c2.
   * If fewer than 2 candles exist before c2 the filter is skipped (not enough
   * session data to determine a reliable day low).
   *
   * Example:
   *   Entry 24250, SL 24300 → risk 50 pts.
   *   Day low 24000 → room = 250 pts.
   *   250 ≥ 50 × 2 (100) ✓  → trade allowed.
   *
   *   Entry 24250, SL 24300 → risk 50 pts.
   *   Day low 24180 → room = 70 pts.
   *   70 < 100 ✗  → trade skipped.
   *
   * Set to 0 to disable.
   * Default: 2
   */
  minDayLowRR?: number;

  /**
   * If the first candle's lower wick is this many times larger than its upper
   * wick, the session is skipped.  A first candle with a huge lower wick
   * (e.g. lower wick = 78%, upper wick = 11% → ratio 7x) opened with a
   * panic sell / flash-drop.  Such sessions are typically volatile intraday
   * with random direction — the Day Reversal thesis does not apply cleanly.
   *
   * Rule: if fcLowerWick ≥ firstCandleLowerWickMaxMultiple × fcUpperWick → skip.
   * Set to 0 to disable this filter.
   * Default: 2  (lower wick must be < 2× the upper wick)
   */
  firstCandleLowerWickMaxMultiple?: number;

  /** When true, prints debug lines to console. Default: false */
  debug?: boolean;
}

// ─── Signal ───────────────────────────────────────────────────────────────────

export interface DrSignal {
  strategyName: 'Day Reversal';
  signal: true;
  setupType: 'DAY_REVERSAL';
  /** Close of the reversal candle (c2) — this is the entry price. */
  entryPrice: number;
  /** c1.high + stopLossBuffer */
  stopLoss: number;
  /** Session peak (c1.high) — raw SL reference. */
  sessionHigh: number;
  /** Index of the peak candle (c1) in `candles`. */
  peakCandleIndex: number;
  /** Index of the reversal candle (c2) in `candles`. */
  setupIndex: number;
  reason: string;
  /**
   * Confidence score:
   *  10 = Grade A — firstOpen at or below EMA20 (clean bearish session).
   *   6 = Grade B — firstOpen above EMA20 (less certain).
   */
  score: 10 | 6;
  /** A = full qty  |  B = half qty */
  setupGrade: 'A' | 'B';
  /** Target 1 — 1:1 RR */
  t1: number;
  /** Target 2 — 1:2 RR */
  t2: number;
  /** Target 3 — 1:3 RR */
  t3: number;
}

// ─── File logger ──────────────────────────────────────────────────────────────

let _drTargetDate = '';

function drRunTimestamp(): string {
  const d = new Date();
  const date = _drTargetDate || d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5).replace(/:/g, '-');
  return `${date}_${time}`;
}

function drFileLog(tag: string, data: object): void {
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
    `dr-strategy-diag-${drRunTimestamp()}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function drCandleLabel(candle: DrCandle, index: number): string {
  try {
    const d = new Date(candle.date as any);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `[${index}] ${hh}:${mm}`;
  } catch {
    return `[${index}]`;
  }
}

function candleTimeMins(candle: DrCandle): number {
  try {
    const d = new Date(candle.date as any);
    return d.getHours() * 60 + d.getMinutes();
  } catch {
    return 0;
  }
}

/**
 * Finds the highest candle low that is strictly BELOW `referencePrice`
 * in the `lookback` candles immediately before `currentIdx`.
 * Returns null if none found (infinite room below).
 */
function findNearestSupportBelow(
  candles: DrCandle[],
  currentIdx: number,
  referencePrice: number,
  lookback: number,
): number | null {
  const start = Math.max(0, currentIdx - lookback);
  let nearest: number | null = null;
  for (let i = start; i < currentIdx; i++) {
    const low = candles[i].low;
    if (low < referencePrice) {
      if (nearest === null || low > nearest) nearest = low;
    }
  }
  return nearest;
}

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * Scan `candles` (5-minute) for Day Reversal sell setups.
 *
 * @param candles  Ordered intraday 5m candles, earliest first. Needs ≥ 2.
 * @param config   Optional tuning parameters (see DrConfig).
 * @returns        Array of DrSignal (at most one per day by design).
 */
export function detectDayReversalOnly(
  candles: DrCandle[],
  config: DrConfig = {},
): DrSignal[] {
  const {
    minRallyPoints = 0,
    minReversalBodyRatio = 0.5,
    maxUpperWickRatio = 0.3,
    requireCloseBelow5mMidpoint = true,
    stopLossBuffer = 3,
    minStopLossPoints = 10,
    minRRRatio = 1.5,
    rrLookbackCandles = 15,
    ema20,
    tradeStartMins = 9 * 60 + 30,
    tradeEndMins = 13 * 60 + 30,
    firstCandleLowerWickMaxMultiple = 2,
    c2LowerWickMaxMultiple = 2,
    c1UpperWickBypassRatio = 0.3,
    minDayLowRR = 2,
    debug = false,
  } = config;

  const log = debug
    ? (...args: unknown[]) => console.log('[DR]', ...args)
    : () => {};

  const signals: DrSignal[] = [];

  if (candles.length < 2) {
    log('Not enough candles (need ≥ 2). Skipping.');
    return signals;
  }

  // Seed log filename with target session date
  try {
    _drTargetDate = new Date(candles[0].date as any).toISOString().slice(0, 10);
  } catch {
    /* ignore */
  }

  // ── Session confidence score ────────────────────────────────────────────────
  const firstOpen = candles[0].open;
  const sessionScore: 10 | 6 =
    ema20 == null || ema20 <= 0 || firstOpen <= ema20 ? 10 : 6;
  const sessionGrade: 'A' | 'B' = sessionScore === 10 ? 'A' : 'B';

  log(
    `DR: Session score=${sessionScore} (${sessionGrade}) — firstOpen=${firstOpen} vs EMA20=${ema20 ?? 'n/a'}`,
  );
  drFileLog('[DR-SESSION]', {
    firstOpen,
    ema20: ema20 ?? null,
    score: sessionScore,
    grade: sessionGrade,
    totalCandles: candles.length,
  });

  // ── First candle diagnostics + wick-ratio filter ─────────────────────────────
  {
    const fc = candles[0];
    const fcRange = fc.high - fc.low;
    if (fcRange > 0) {
      const fcBody = Math.abs(fc.close - fc.open);
      const fcUpperWick = fc.high - Math.max(fc.open, fc.close);
      const fcLowerWick = Math.min(fc.open, fc.close) - fc.low;
      const lowerToUpperRatio =
        fcUpperWick > 0
          ? fcLowerWick / fcUpperWick
          : fcLowerWick > 0
            ? Infinity
            : 0;
      drFileLog('[DR-FIRST-CANDLE]', {
        open: fc.open,
        high: fc.high,
        low: fc.low,
        close: fc.close,
        isRed: fc.close < fc.open,
        bodyRatio: +(fcBody / fcRange).toFixed(3),
        upperWickRatio: +(fcUpperWick / fcRange).toFixed(3),
        lowerWickRatio: +(fcLowerWick / fcRange).toFixed(3),
        lowerToUpperRatio: isFinite(lowerToUpperRatio)
          ? +lowerToUpperRatio.toFixed(2)
          : null,
        ema20: ema20 ?? null,
        // Relationship: is first-candle open above or below EMA20?
        ema20Relation:
          ema20 == null
            ? 'unknown'
            : fc.open > ema20
              ? 'above-ema'
              : 'below-ema',
      });

      // ── Lower wick dominance filter ──────────────────────────────────────────
      // A first candle whose lower wick is ≥ N× the upper wick indicates the
      // session opened with a downside flush.  The subsequent rally is often a
      // recovery bounce rather than a genuine directional move, making the
      // Day Reversal sell signal unreliable.
      if (
        firstCandleLowerWickMaxMultiple > 0 &&
        fcUpperWick > 0 &&
        fcLowerWick >= firstCandleLowerWickMaxMultiple * fcUpperWick
      ) {
        log(
          `First candle (9:15): Lower wick (${((fcLowerWick / fcRange) * 100).toFixed(1)}%) ` +
            `is ${lowerToUpperRatio.toFixed(1)}× the upper wick (${((fcUpperWick / fcRange) * 100).toFixed(1)}%) ` +
            `— dominance threshold ${firstCandleLowerWickMaxMultiple}×. Skip session.`,
        );
        drFileLog('[DR-SKIP-FIRST-CANDLE]', {
          reason: 'lower-wick-dominance',
          fcUpperWickRatio: +(fcUpperWick / fcRange).toFixed(3),
          fcLowerWickRatio: +(fcLowerWick / fcRange).toFixed(3),
          lowerToUpperRatio: +lowerToUpperRatio.toFixed(2),
          firstCandleLowerWickMaxMultiple,
        });
        return signals;
      }
    }
  }

  // ── Rolling session-high tracker + session-low-after-first tracker ────────────
  let sessionHigh = candles[0].high;
  // Tracks the lowest intraday low from candle[1] onward.
  // Tells us whether the market ever undercut the first-candle low before
  // reaching the peak (clean uptrend vs impure rally).
  let sessionLowAfterFirst = candles[0].low;

  // Scan from candle index 1 — we need at least c1 (i) and c2 (i+1)
  for (let i = 1; i < candles.length - 1; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c1Lbl = drCandleLabel(c1, i);
    const c2Lbl = drCandleLabel(c2, i + 1);

    // Update session low tracker on every candle
    if (c1.low < sessionLowAfterFirst) sessionLowAfterFirst = c1.low;

    // ── 1. Does c1 make a new session high? ──────────────────────────────────
    const isNewSessionHigh = c1.high > sessionHigh;

    // Update rolling session high regardless
    if (c1.high > sessionHigh) sessionHigh = c1.high;

    if (!isNewSessionHigh) {
      log(
        `${c1Lbl}: Not a new session high (c1.high=${c1.high} ≤ sessionHigh=${sessionHigh}). Skip.`,
      );
      continue;
    }

    log(`${c1Lbl}: *** NEW SESSION HIGH ${c1.high} ***`);

    // ── 1b. Log peak context (first candle low vs session low at this point) ───
    //  This is purely diagnostic — no filtering happens here.
    //  After backtest you can look at these lines to decide whether to add a
    //  "no new low after first candle" filter.
    {
      const firstCandleLow = candles[0].low;
      const didBreakLow = sessionLowAfterFirst < firstCandleLow;
      drFileLog('[DR-PEAK-INFO]', {
        candleLabel: c1Lbl,
        c1High: c1.high,
        firstCandleLow,
        sessionLowAtPeak: sessionLowAfterFirst,
        didBreakFirstCandleLow: didBreakLow,
        // How far below first-candle low did price dip (0 = clean uptrend)
        breakLowBy: didBreakLow
          ? +(firstCandleLow - sessionLowAfterFirst).toFixed(2)
          : 0,
        ema20: ema20 ?? null,
        // Is the current high above/below EMA20?
        ema20Relation:
          ema20 == null
            ? 'unknown'
            : c1.high > ema20
              ? 'above-ema'
              : 'below-ema',
      });
    }
    const rally = c1.high - firstOpen;
    if (rally < minRallyPoints) {
      log(
        `${c1Lbl}: Rally ${rally.toFixed(1)} pts < minRallyPoints ${minRallyPoints}. Skip.`,
      );
      drFileLog('[DR-SKIP-RALLY]', {
        candleLabel: c1Lbl,
        rally,
        minRallyPoints,
      });
      continue;
    }

    // ── 3. Time gate for c2 ──────────────────────────────────────────────────
    const c2TimeMins = candleTimeMins(c2);
    if (c2TimeMins < tradeStartMins || c2TimeMins > tradeEndMins) {
      log(
        `${c2Lbl}: Outside trade window (${c2TimeMins} not in [${tradeStartMins}, ${tradeEndMins}]). Skip.`,
      );
      continue;
    }

    // ── 4. c2 must be BEAR ───────────────────────────────────────────────────
    if (c2.close >= c2.open) {
      log(
        `${c2Lbl}: c2 not bearish (close=${c2.close} ≥ open=${c2.open}). Skip.`,
      );
      continue;
    }

    const c2Range = c2.high - c2.low;
    if (c2Range <= 0) {
      log(`${c2Lbl}: c2 zero-range candle. Skip.`);
      continue;
    }

    const c2Body = c2.open - c2.close; // positive (bearish)
    const c2UpperWick = c2.high - c2.open;
    const c2BodyRatio = c2Body / c2Range;
    const c2UpperWickRatio = c2UpperWick / c2Range;

    // ── 5. Strong bearish body ───────────────────────────────────────────────
    if (c2BodyRatio < minReversalBodyRatio) {
      log(
        `${c2Lbl}: c2 body ratio ${(c2BodyRatio * 100).toFixed(1)}% < ${(minReversalBodyRatio * 100).toFixed(1)}%. Skip.`,
      );
      drFileLog('[DR-SKIP-BODY]', {
        candleLabel: c2Lbl,
        c2BodyRatio: +c2BodyRatio.toFixed(3),
        minReversalBodyRatio,
      });
      continue;
    }

    // ── 6. Tiny upper wick (immediate rejection from the open) ───────────────
    if (c2UpperWickRatio > maxUpperWickRatio) {
      log(
        `${c2Lbl}: c2 upper wick ratio ${(c2UpperWickRatio * 100).toFixed(1)}% > ${(maxUpperWickRatio * 100).toFixed(1)}%. Skip.`,
      );
      drFileLog('[DR-SKIP-UPPER-WICK]', {
        candleLabel: c2Lbl,
        c2UpperWickRatio: +c2UpperWickRatio.toFixed(3),
        maxUpperWickRatio,
      });
      continue;
    }

    // ── 6b. c2 lower wick must not dominate upper wick ───────────────────────
    // A large lower wick on c2 means buyers stepped in below the close and
    // pushed price back up — the bearish momentum is not clean.  Skip when
    // lowerWick ≥ c2LowerWickMaxMultiple × upperWick.
    //
    // Exception: if c1 itself has a long upper wick (≥ c1UpperWickBypassRatio
    // of c1's range) the top rejection is already confirmed by c1 — the
    // c2 lower-wick filter is bypassed in that case.
    const c2LowerWick = c2.close - c2.low; // bearish: close < open, lowerWick ≥ 0
    const c1Range = c1.high - c1.low;
    const c1UpperWick = c1.high - Math.max(c1.open, c1.close);
    const c1UpperWickRatio = c1Range > 0 ? c1UpperWick / c1Range : 0;
    const c1HasLongUpperWick =
      c1UpperWickBypassRatio > 0 && c1UpperWickRatio >= c1UpperWickBypassRatio;
    if (
      c2LowerWickMaxMultiple > 0 &&
      c2UpperWick > 0 &&
      c2LowerWick >= c2LowerWickMaxMultiple * c2UpperWick
    ) {
      const lwr = c2LowerWick / c2UpperWick;
      if (c1HasLongUpperWick) {
        // c1 upper wick confirms the top rejection — allow signal despite c2 lower wick
        log(
          `${c2Lbl}: c2 lower wick ${lwr.toFixed(1)}× upper wick BUT c1 upper wick ` +
            `${(c1UpperWickRatio * 100).toFixed(1)}% ≥ bypass threshold ` +
            `${(c1UpperWickBypassRatio * 100).toFixed(0)}%. Lower-wick filter bypassed.`,
        );
        drFileLog('[DR-BYPASS-C2-LOWER-WICK]', {
          candleLabel: c2Lbl,
          c2LowerWick: +c2LowerWick.toFixed(2),
          c2UpperWick: +c2UpperWick.toFixed(2),
          c2LowerToUpperRatio: +lwr.toFixed(2),
          c1UpperWickRatio: +c1UpperWickRatio.toFixed(3),
          c1UpperWickBypassRatio,
        });
      } else {
        log(
          `${c2Lbl}: c2 lower wick (${c2LowerWick.toFixed(2)}) is ${lwr.toFixed(1)}× ` +
            `upper wick (${c2UpperWick.toFixed(2)}) — threshold ${c2LowerWickMaxMultiple}×. Skip.`,
        );
        drFileLog('[DR-SKIP-C2-LOWER-WICK]', {
          candleLabel: c2Lbl,
          c2LowerWick: +c2LowerWick.toFixed(2),
          c2UpperWick: +c2UpperWick.toFixed(2),
          ratio: +lwr.toFixed(2),
          c2LowerWickMaxMultiple,
          c1UpperWickRatio: +c1UpperWickRatio.toFixed(3),
        });
        continue;
      }
    }

    // ── 7. c2 close must fall into lower half of c1's OHLC range ─────────────
    if (requireCloseBelow5mMidpoint) {
      const c1Midpoint = (c1.open + c1.close) / 2;
      if (c2.close >= c1Midpoint) {
        log(
          `${c2Lbl}: c2 close ${c2.close} ≥ c1 midpoint ${c1Midpoint.toFixed(2)}. Not deep enough reversal. Skip.`,
        );
        drFileLog('[DR-SKIP-MIDPOINT]', {
          candleLabel: c2Lbl,
          c2Close: c2.close,
          c1Midpoint: +c1Midpoint.toFixed(2),
        });
        continue;
      }
    }

    // ── 8. Compute entry / SL / targets ──────────────────────────────────────
    const entryPrice = c2.close;
    const naturalSl = c1.high + stopLossBuffer;
    const stopLoss = Math.max(naturalSl, entryPrice + minStopLossPoints);
    const risk = stopLoss - entryPrice;

    if (risk <= 0) {
      log(`${c2Lbl}: Risk ≤ 0. Skip.`);
      continue;
    }

    const t1 = entryPrice - risk * 1;
    const t2 = entryPrice - risk * 2;
    const t3 = entryPrice - risk * 3;

    // ── 9. Day-low room-to-move gate (minimum 1:2 to session low) ─────────────
    // We need (entryPrice − sessionLow) ≥ risk × minDayLowRR so that T2
    // has unobstructed room to the current day's low.
    if (minDayLowRR > 0) {
      // sessionLow = lowest low from candle[0] up to and including c2 (index i+1)
      let sessionLow = candles[0].low;
      for (let k = 1; k <= i + 1; k++) {
        if (candles[k].low < sessionLow) sessionLow = candles[k].low;
      }
      const roomToDayLow = entryPrice - sessionLow;
      const requiredRoom = risk * minDayLowRR;
      if (roomToDayLow < requiredRoom) {
        log(
          `${c2Lbl}: Room to day low ${roomToDayLow.toFixed(1)} pts < required ` +
            `${requiredRoom.toFixed(1)} pts (risk=${risk.toFixed(1)} × ${minDayLowRR}). Skip.`,
        );
        drFileLog('[DR-SKIP-DAY-LOW-ROOM]', {
          candleLabel: c2Lbl,
          entryPrice,
          sessionLow: +sessionLow.toFixed(2),
          roomToDayLow: +roomToDayLow.toFixed(1),
          requiredRoom: +requiredRoom.toFixed(1),
          risk: +risk.toFixed(1),
          minDayLowRR,
        });
        continue;
      }
      log(
        `${c2Lbl}: Day-low room OK — ${roomToDayLow.toFixed(1)} pts ≥ ${requiredRoom.toFixed(1)} pts ` +
          `(dayLow=${sessionLow.toFixed(2)}).`,
      );
    }

    // ── 10. RR filter: enough room below entry ────────────────────────────────
    if (minRRRatio > 0) {
      const nearestSupport = findNearestSupportBelow(
        candles,
        i + 1,
        entryPrice,
        rrLookbackCandles,
      );
      if (nearestSupport !== null) {
        const room = entryPrice - nearestSupport;
        const rr = room / risk;
        if (rr < minRRRatio) {
          log(
            `${c2Lbl}: RR ${rr.toFixed(2)} < minRRRatio ${minRRRatio} (room=${room.toFixed(1)}, risk=${risk.toFixed(1)}). Skip.`,
          );
          drFileLog('[DR-SKIP-RR]', {
            candleLabel: c2Lbl,
            rr: +rr.toFixed(2),
            minRRRatio,
            room: +room.toFixed(1),
            risk: +risk.toFixed(1),
            nearestSupport,
          });
          continue;
        }
      }
    }

    // ── 10. Build signal ──────────────────────────────────────────────────────
    const reason =
      `DAY_REVERSAL: Peak at ${c1.high.toFixed(2)} (${c1Lbl}), ` +
      `reversal candle body=${(c2BodyRatio * 100).toFixed(0)}% ` +
      `upperWick=${(c2UpperWickRatio * 100).toFixed(0)}% (${c2Lbl}) ` +
      `rally=${rally.toFixed(1)}pts`;

    const sig: DrSignal = {
      strategyName: 'Day Reversal',
      signal: true,
      setupType: 'DAY_REVERSAL',
      entryPrice,
      stopLoss,
      sessionHigh: c1.high,
      peakCandleIndex: i,
      setupIndex: i + 1,
      reason,
      score: sessionScore,
      setupGrade: sessionGrade,
      t1,
      t2,
      t3,
    };

    log(`${c2Lbl}: SIGNAL FIRED — ${reason}`);
    log(
      `  Entry=${entryPrice.toFixed(2)} SL=${stopLoss.toFixed(2)} Risk=${risk.toFixed(2)} T1=${t1.toFixed(2)} T2=${t2.toFixed(2)} T3=${t3.toFixed(2)}`,
    );
    // Compute first-candle snapshot for the signal log
    const _fc = candles[0];
    const _fcRange = _fc.high - _fc.low;
    const _fcBody =
      _fcRange > 0 ? Math.abs(_fc.close - _fc.open) / _fcRange : 0;
    const _fcUWick =
      _fcRange > 0 ? (_fc.high - Math.max(_fc.open, _fc.close)) / _fcRange : 0;
    const _fcLWick =
      _fcRange > 0 ? (Math.min(_fc.open, _fc.close) - _fc.low) / _fcRange : 0;

    drFileLog('[DR-SIGNAL]', {
      ...sig,
      c1Label: c1Lbl,
      c2Label: c2Lbl,
      risk: +risk.toFixed(2),
      c2BodyRatio: +c2BodyRatio.toFixed(3),
      c2UpperWickRatio: +c2UpperWickRatio.toFixed(3),
      rally: +rally.toFixed(1),
      // First candle context
      firstCandle: {
        open: _fc.open,
        high: _fc.high,
        low: _fc.low,
        close: _fc.close,
        isRed: _fc.close < _fc.open,
        bodyRatio: +_fcBody.toFixed(3),
        upperWickRatio: +_fcUWick.toFixed(3),
        lowerWickRatio: +_fcLWick.toFixed(3),
      },
      // Session low behavior at peak
      firstCandleLow: candles[0].low,
      sessionLowAtPeak: sessionLowAfterFirst,
      didBreakFirstCandleLow: sessionLowAfterFirst < candles[0].low,
      breakLowBy:
        sessionLowAfterFirst < candles[0].low
          ? +(candles[0].low - sessionLowAfterFirst).toFixed(2)
          : 0,
      // EMA context
      ema20: ema20 ?? null,
      ema20Relation:
        ema20 == null
          ? 'unknown'
          : _fc.open > ema20
            ? 'above-ema'
            : 'below-ema',
    });

    signals.push(sig);

    // One signal per session — stop scanning after first valid setup
    break;
  }

  return signals;
}

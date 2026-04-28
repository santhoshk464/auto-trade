/**
 * Day Low Break Selling Strategy (v2)
 *
 * State-machine version with failed-breakdown detection and RR filter.
 *
 * Signal logic:
 *   CLEAN BREAK path:
 *     1. Mark `dayFirst5mLow` = first 5-minute candle's low.
 *     2. A later 5m candle CLOSES below `dayFirst5mLow` → check 1m confirmation.
 *     3. First 1m candle that also closes below `dayFirst5mLow` triggers entry.
 *     4. Filters: body ratio, 1m wick, EMA gate, RR >= minRRRatio.
 *
 *   FAILED BREAK path:
 *     1. A 5m candle breaks below `dayFirst5mLow` (wick) but closes BACK ABOVE it.
 *     2. Store `failedBreakLow` (candle low) and `failedBreakHigh` (candle high).
 *     3. Ignore fresh sells from re-breaks of `dayFirst5mLow`.
 *     4. Wait for a later 5m candle to close below `failedBreakLow`.
 *     5. Then require 1m confirmation close below `failedBreakLow`.
 *     6. SL = failedBreakHigh + buffer. Filters: body ratio, 1m wick, EMA, RR.
 *
 * States:
 *   WAITING_FOR_DAY_LOW_BREAK
 *     → WAITING_FOR_FAILED_BREAK_LOW_REBREAK  (failed break)
 *     → TRADE_TRIGGERED                       (clean break confirmed)
 *   WAITING_FOR_FAILED_BREAK_LOW_REBREAK
 *     → SETUP_INVALIDATED  (price closes above failedBreakHigh)
 *     → TRADE_TRIGGERED    (rebreak confirmed)
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import fs from 'fs';
import path from 'path';

// ─── State ───────────────────────────────────────────────────────────────────

type DlbState =
  | 'WAITING_FOR_DAY_LOW_BREAK'
  | 'WAITING_FOR_FAILED_BREAK_LOW_REBREAK'
  | 'TRADE_TRIGGERED'
  | 'SETUP_INVALIDATED';

// ─── Candle ──────────────────────────────────────────────────────────────────

export interface DlbCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  /** Date/time of the candle. Used only for labelling in logs. */
  date: Date | string | number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DlbConfig {
  /**
   * Entry price mode after 1-minute confirmation.
   * - 'conservative': entry at the 1-minute confirmation candle's close.
   * - 'aggressive':   entry at the 1-minute confirmation candle's low.
   * Default: 'conservative'
   */
  entryMode?: 'conservative' | 'aggressive';

  /**
   * Stop-loss placement mode for CLEAN BREAK signals.
   * - 'safe':       SL above the 5-minute breakdown candle high + buffer.
   * - 'aggressive': SL above the 1-minute confirmation candle high + buffer.
   * For FAILED-BREAK RE-BREAK signals, failedBreakHigh is always the SL reference.
   * Default: 'safe'
   */
  stopLossMode?: 'safe' | 'aggressive';

  /**
   * Pre-calculated 20-EMA value at the session open (seeded from yesterday).
   * Used for session-level confidence scoring (firstOpen vs EMA20).
   * Gate disabled when omitted.
   * Default: undefined (disabled)
   */
  ema20?: number;

  /**
   * Per-candle EMA20 values aligned 1-to-1 with the `candles` (5m) array.
   * When provided, `ema20Series[setup5mIdx]` is used for the EMA proximity
   * check at signal time so the distance is evaluated against the EMA that
   * was actually in effect when the signal fired, not a stale session value.
   * Default: undefined (falls back to `ema20`)
   */
  ema20Series?: (number | null)[];

  /**
   * Maximum lower-wick / total-range ratio allowed for the 1-minute confirmation candle.
   * A large lower wick signals counter-pressure — skip.
   * Default: 0.40
   */
  maxConfirmWickPct?: number;

  /**
   * Minimum bearish-body / total-range ratio for the 5-minute breakdown candle.
   * Weak, indecisive candles are skipped.
   * Default: 0.30
   */
  min5mBreakdownBodyRatio?: number;

  /**
   * How many 1-minute candles to scan for confirmation.
   * Set to 0 for no limit.
   * Default: 10
   */
  oneMinuteConfirmationWindow?: number;

  /**
   * Buffer (points) added above the SL reference swing high.
   * Default: 5
   */
  stopLossBuffer?: number;

  /**
   * Minimum stop-loss distance in points from entry.
   * Ensures the SL is never too tight regardless of the natural swing high.
   * Default: 16
   */
  minStopLossPoints?: number;

  /**
   * Minimum Risk:Reward ratio required before triggering entry.
   * Reward = distance from entry to nearest support below.
   * If no prior support found below entry, the RR check is skipped (infinite room).
   * Default: 1.5
   */
  minRRRatio?: number;

  /**
   * Number of recent 5m candles to look back when searching for the nearest support.
   * Default: 15
   */
  rrLookbackCandles?: number;

  /** When true, prints debug lines to console. Default: false */
  debug?: boolean;

  /**
   * When true, allows entry when a 1-minute candle's LOW breaks below the breakdown
   * level even if its close is still above it.
   * Entry price is set to `breakLevel` (as if entering on the level break).
   * This catches fast moves where 1m candles don't get a chance to close below.
   * Only triggers if the candle's close is still relatively close to the low
   * (i.e. lowerWick / range <= maxConfirmWickPct, same filter applies).
   * Default: true
   */
  allow1mLowBreak?: boolean;

  /**
   * Maximum distance (points) that the 5m breakdown candle close can be
   * below `dayFirst5mLow` before the setup is rejected.
   * When a candle crashes 50+ points through the level in a single bar, the
   * resulting SL (anchored to that candle's high) becomes enormous and the
   * setup is untradeable. Skipping such candles avoids massive-risk signals.
   * Set to 0 or omit to disable.
   * Default: 50
   */
  maxBreakdownDepthPts?: number;

  /**
   * Earliest signal candle time allowed, in minutes from midnight.
   * Signals whose 5m trigger candle falls before this time are discarded.
   * Default: 570 (09:30 AM)
   */
  tradeStartMins?: number;

  /**
   * Latest signal candle time allowed, in minutes from midnight.
   * Signals whose 5m trigger candle falls after this time are discarded.
   * Default: 870 (02:30 PM)
   */
  tradeEndMins?: number;

  /**
   * Maximum distance (points) the 20-EMA is allowed to be above the entry
   * price before the signal is skipped.
   * When running the strategy on option candles (not index), the EMA seeded
   * from the previous session can be far above current price after large moves
   * (e.g. crash-day options). Pass `Infinity` to disable the gate entirely.
   * Default: 200
   */
  maxEmaDistancePts?: number;
}

// ─── Signal ──────────────────────────────────────────────────────────────────

export interface DlbSignal {
  strategyName: 'Day Low Break';
  signal: true;
  setupType: 'DAY_LOW_BREAK';
  entryPrice: number;
  stopLoss: number;
  /** Level that was broken to trigger the signal. */
  breakdownLevel: number;
  /** Index of the 5m triggering candle in `candles`. */
  setupIndex: number;
  /** Index of the 1m confirmation candle in `candles1m`. */
  confirmIndex: number;
  entryMode: 'conservative' | 'aggressive';
  stopLossMode: 'safe' | 'aggressive';
  reason: string;
  /**
   * Confidence score for position sizing.
   * 10 = high-confidence: first candle opened at or below EMA20 → full qty.
   *  6 = lower-confidence: first candle opened above EMA20 → half qty.
   *  4 = entry is within 50 pts below EMA20 at signal time → quarter qty.
   */
  score: 10 | 6 | 4;
  /** Setup grade derived from score: A (score=10) full qty, B (score=6 or 4) half/quarter qty. */
  setupGrade: 'A' | 'B';
  /** True when signal came from the failed-break re-break path. */
  isRebreakSetup?: boolean;
  /** Low of the failed-break candle (re-break path only). */
  failedBreakLow?: number;
  /** High of the failed-break candle (re-break path only). */
  failedBreakHigh?: number;
  /** Target 1 — 1:1 RR (entry − risk × 1) */
  t1: number;
  /** Target 2 — 1:2 RR (entry − risk × 2) */
  t2: number;
  /** Target 3 — 1:3 RR (entry − risk × 3) */
  t3: number;
}

// ─── File logger ─────────────────────────────────────────────────────────────

/** Target date (YYYY-MM-DD) used in log filenames. Set from candles[0] each run. */
let _dlbTargetDate = '';

function dlbRunTimestamp(): string {
  const d = new Date();
  const date = _dlbTargetDate || d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5).replace(/:/g, '-');
  return `${date}_${time}`;
}

function dlbFileLog(tag: string, data: object): void {
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
    `dlb-strategy-diag-${dlbRunTimestamp()}.log`,
  );
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    /* ignore */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function candleLabel(candle: DlbCandle, index: number): string {
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
 * up to `windowSize` candles.
 */
function getOneMinuteWindow(
  candles1m: DlbCandle[],
  setup5mCandle: DlbCandle,
  windowSize: number,
): { candles: DlbCandle[]; startIdx: number } {
  const setupTime = new Date(setup5mCandle.date as any).getTime();
  if (!isNaN(setupTime)) {
    const found = candles1m.findIndex(
      (c) => new Date(c.date as any).getTime() >= setupTime,
    );
    // No 1m candle exists at or after the setup candle. Return empty window —
    // do NOT fall back to index 0 (which would use early-morning candles).
    if (found === -1) return { candles: [], startIdx: candles1m.length };
    const end =
      windowSize > 0
        ? Math.min(found + windowSize, candles1m.length)
        : candles1m.length;
    return { candles: candles1m.slice(found, end), startIdx: found };
  }
  // No valid date on the setup candle — return full array as before
  const end =
    windowSize > 0 ? Math.min(windowSize, candles1m.length) : candles1m.length;
  return { candles: candles1m.slice(0, end), startIdx: 0 };
}

/**
 * Finds the highest candle low that is BELOW `referencePrice` within the
 * last `lookback` 5m candles before `currentIdx`.
 * Returns null if no candle low below referencePrice is found (infinite room).
 */
function findNearestSupportBelow(
  candles: DlbCandle[],
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

// ─── Main detector ───────────────────────────────────────────────────────────

/**
 * Scan `candles` (5-minute) for Day Low Break sell setups using a state machine.
 *
 * @param candles    Ordered intraday 5m candles, earliest first. Needs ≥ 2.
 * @param config     Optional tuning parameters (see DlbConfig).
 * @param candles1m  Intraday 1m candles for confirmation (required).
 * @returns          Array of DlbSignal (at most one signal per day by design).
 */
export function detectDayLowBreakOnly(
  candles: DlbCandle[],
  config: DlbConfig = {},
  candles1m?: DlbCandle[],
): DlbSignal[] {
  const {
    entryMode = 'conservative',
    stopLossMode = 'safe',
    ema20,
    ema20Series,
    maxConfirmWickPct = 0.4,
    min5mBreakdownBodyRatio = 0.3,
    oneMinuteConfirmationWindow = 10,
    stopLossBuffer = 5,
    minStopLossPoints = 16,
    minRRRatio = 1.5,
    rrLookbackCandles = 15,
    allow1mLowBreak = true,
    maxBreakdownDepthPts = 50,
    debug = false,
    tradeStartMins = 9 * 60 + 30,
    tradeEndMins = 14 * 60 + 30,
    maxEmaDistancePts = 200,
  } = config;

  const log = debug
    ? (...args: unknown[]) => console.log('[DLB]', ...args)
    : () => {};

  const signals: DlbSignal[] = [];

  if (candles.length < 2) {
    log('Not enough candles (need ≥ 2). Skipping.');
    return signals;
  }
  if (!candles1m || candles1m.length === 0) {
    log('No 1-minute candles provided. Skipping.');
    return signals;
  }
  // Seed log filename with target date (candle date, not today's date)
  try {
    _dlbTargetDate = new Date(candles[0].date as any)
      .toISOString()
      .slice(0, 10);
  } catch {
    /* ignore */
  }
  // ── Mark breakdown level ─────────────────────────────────────────────────
  const dayFirst5mLow = candles[0].low;
  log(
    `DLB: First 5-minute day low marked: ${dayFirst5mLow} (${candleLabel(candles[0], 0)})`,
  );
  dlbFileLog('[DLB-LEVEL-MARKED]', {
    dayFirst5mLow,
    candleLabel: candleLabel(candles[0], 0),
    ema20: ema20 ?? null,
    firstOpen: candles[0].open,
  });

  // ── Session EMA gate ──────────────────────────────────────────────────────
  // Both the first candle's open AND close must be below EMA20 for the market
  // to be in selling territory. If either is above EMA20 the option is in
  // buying mode and DLB signals are suppressed for the entire session.
  const firstOpen0 = candles[0].open;
  const firstClose0 = candles[0].close;
  if (
    ema20 != null &&
    ema20 > 0 &&
    (firstOpen0 > ema20 || firstClose0 > ema20)
  ) {
    log(
      `DLB: Session skipped — first candle open=${firstOpen0} / close=${firstClose0}` +
        ` is above EMA20 ${ema20.toFixed(2)}. Market not in selling mode.`,
    );
    dlbFileLog('[DLB-SESSION-SKIPPED-EMA]', {
      firstOpen: firstOpen0,
      firstClose: firstClose0,
      ema20,
      reason: 'first candle open/close above EMA20',
    });
    return signals;
  }
  const sessionScore: 10 = 10;
  const sessionGrade = 'A';
  log(
    `DLB: Session gate passed — firstOpen=${firstOpen0} / firstClose=${firstClose0}` +
      ` both below EMA20=${ema20 ?? 'n/a'}. Score=10 (A).`,
  );

  // ── State ────────────────────────────────────────────────────────────────
  let state: DlbState = 'WAITING_FOR_DAY_LOW_BREAK';
  let failedBreakLow = 0;
  let failedBreakHigh = 0;
  // After a signal fires, require price to recover above dayFirst5mLow before
  // allowing another setup — prevents cascade signals on continuous downtrends.
  let requiresRecovery = false;

  // ── Helper: attempt 1m confirmation and return signal if all filters pass ─
  function attempt1mConfirmation(
    breakLevel: number,
    setup5mIdx: number,
    slHighForSafe: number, // used when stopLossMode === 'safe'
    isRebreak: boolean,
    signalEma20: number | undefined,
  ): DlbSignal | null {
    const setup5mCandle = candles[setup5mIdx];
    const lbl = candleLabel(setup5mCandle, setup5mIdx);

    log(`DLB: Waiting for 1-minute confirmation close below ${breakLevel}`);
    dlbFileLog(
      isRebreak
        ? '[DLB-WAITING-REBREAK-1M-CONFIRM]'
        : '[DLB-WAITING-1M-CONFIRM]',
      { candleLabel: lbl, breakLevel },
    );

    const { candles: win, startIdx: winStart } = getOneMinuteWindow(
      candles1m!,
      setup5mCandle,
      oneMinuteConfirmationWindow,
    );
    log(`[1m] Window: ${win.length} candle(s) from idx ${winStart}`);

    for (let j = 0; j < win.length; j++) {
      const c1m = win[j];
      const c1mLbl = candleLabel(c1m, winStart + j);

      // ── Check: does 1m close below level, or does 1m LOW break the level? ─
      const closedBelow = c1m.close < breakLevel;
      const lowBreak =
        allow1mLowBreak && c1m.low < breakLevel && c1m.close >= breakLevel;

      if (!closedBelow && !lowBreak) continue;

      if (lowBreak) {
        log(
          `[1m] Low-break entry: ${c1mLbl} low=${c1m.low} < ${breakLevel}` +
            ` (close=${c1m.close} still above level — entering at level)`,
        );
        dlbFileLog('[DLB-1M-LOW-BREAK]', {
          candleLabel: c1mLbl,
          low: c1m.low,
          close: c1m.close,
          breakLevel,
          volume: c1m.volume,
        });
      }

      // ── 1m wick rejection ──────────────────────────────────────────────
      const range1m = c1m.high - c1m.low;
      const lowerWick = Math.min(c1m.open, c1m.close) - c1m.low;
      const wickPct = range1m > 0 ? lowerWick / range1m : 0;
      if (wickPct > maxConfirmWickPct) {
        log(
          `DLB: Skipped due to lower wick rejection` +
            ` ${c1mLbl} wickPct=${(wickPct * 100).toFixed(0)}%`,
        );
        dlbFileLog('[DLB-SKIPPED-LOWER-WICK]', {
          candleLabel: c1mLbl,
          wickPct,
          maxConfirmWickPct,
          volume: c1m.volume,
        });
        continue;
      }

      // ── Entry price ────────────────────────────────────────────────────
      // Low-break path: price only poked below the level, close is above.
      // Enter at breakLevel itself (limit/stop-entry at the level).
      // Normal close-below path: use configured entryMode.
      const rawEntry = lowBreak
        ? breakLevel
        : entryMode === 'aggressive'
          ? c1m.low
          : c1m.close;

      // ── EMA gate ───────────────────────────────────────────────────────
      // Use the per-setup-candle EMA (signalEma20) so we compare against the
      // EMA that was actually in effect at signal time, not the session open EMA.
      if (signalEma20 != null && signalEma20 > 0 && rawEntry >= signalEma20) {
        log(`DLB: Skipped — entry ${rawEntry} >= EMA20 ${signalEma20}`);
        dlbFileLog('[DLB-SKIPPED-EMA]', {
          candleLabel: c1mLbl,
          rawEntry,
          ema20: signalEma20,
        });
        continue;
      }

      // ── EMA distance gate ──────────────────────────────────────────────
      // >50 pts above entry → skip (too far, high reversal risk at EMA).
      // 0–50 pts above entry → cap score to 4 (quarter qty, grade B).
      let finalScore: 10 | 6 | 4 = sessionScore;
      if (signalEma20 != null && signalEma20 > rawEntry) {
        const emaDistance = signalEma20 - rawEntry;
        if (emaDistance > maxEmaDistancePts) {
          log(
            `DLB: Skipped — EMA20 ${signalEma20} is ${emaDistance.toFixed(1)} pts above entry ${rawEntry} (> maxEmaDistancePts ${maxEmaDistancePts})`,
          );
          dlbFileLog('[DLB-SKIPPED-EMA-FAR]', {
            candleLabel: c1mLbl,
            rawEntry,
            ema20: signalEma20,
            distance: +emaDistance.toFixed(1),
            maxEmaDistancePts,
          });
          continue;
        }
        // Within threshold — valid but reduced confidence: cap to score 4.
        finalScore = 4;
      }

      // ── Stop loss ──────────────────────────────────────────────────────
      // SL is placed above the setup 5m candle's high (slHighForSafe) OR the
      // 1m confirmation candle's high — whichever is higher.
      // For re-breaks, slHighForSafe = rebreak 5m candle high (NOT failedBreakHigh
      // which can be from a stale early-morning candle and produces excessive risk).
      const slHighRef =
        stopLossMode === 'aggressive'
          ? c1m.high
          : Math.max(slHighForSafe, c1m.high);
      const naturalSl = slHighRef + stopLossBuffer;
      const stopLoss = Math.max(naturalSl, rawEntry + minStopLossPoints);
      const risk = stopLoss - rawEntry;
      if (risk <= 0) continue;

      // ── RR filter ──────────────────────────────────────────────────────
      const nearestSupport = findNearestSupportBelow(
        candles,
        setup5mIdx,
        rawEntry,
        rrLookbackCandles,
      );
      if (nearestSupport !== null) {
        const reward = rawEntry - nearestSupport;
        const rr = reward / risk;
        if (rr < minRRRatio) {
          log(
            `DLB: Skipped due to insufficient RR (< ${minRRRatio})` +
              ` — rr=${rr.toFixed(2)} reward=${reward.toFixed(1)} risk=${risk.toFixed(1)}`,
          );
          dlbFileLog('[DLB-SKIPPED-RR]', {
            candleLabel: c1mLbl,
            rr,
            minRRRatio,
            reward,
            risk,
            nearestSupport,
            volume: c1m.volume,
          });
          continue;
        }
      }

      // ── Signal ────────────────────────────────────────────────────────
      const confirmDesc = lowBreak
        ? `1m low ${c1m.low.toFixed(2)} broke level (close ${c1m.close.toFixed(2)} above)`
        : `1m close ${c1m.close.toFixed(2)}`;
      const reason = isRebreak
        ? `DLB: Failed-break low ${failedBreakLow.toFixed(2)} re-broken` +
          ` | ${confirmDesc} | SL=rebreak5mHigh ${slHighForSafe.toFixed(2)}`
        : `DLB: 5m close ${setup5mCandle.close.toFixed(2)} broke dayFirst5mLow ${dayFirst5mLow}` +
          ` | ${confirmDesc} | entry=${entryMode} SL=${stopLossMode}`;

      log(`DLB: Sell triggered @ ${rawEntry} | SL ${stopLoss} | ${reason}`);

      const t1 = rawEntry - risk;
      const t2 = rawEntry - risk * 2;
      const t3 = rawEntry - risk * 3;

      dlbFileLog('[DLB-SIGNAL]', {
        candleLabel: c1mLbl,
        entry: rawEntry,
        stopLoss,
        t1,
        t2,
        t3,
        breakdownLevel: breakLevel,
        setupIndex: setup5mIdx,
        confirmIndex: winStart + j,
        isRebreak,
        setupVolume: setup5mCandle.volume,
        confirmVolume: c1m.volume,
      });

      const sig: DlbSignal = {
        strategyName: 'Day Low Break',
        signal: true,
        setupType: 'DAY_LOW_BREAK',
        entryPrice: rawEntry,
        stopLoss,
        t1,
        t2,
        t3,
        breakdownLevel: breakLevel,
        setupIndex: setup5mIdx,
        confirmIndex: winStart + j,
        entryMode,
        stopLossMode,
        reason,
        score: finalScore,
        setupGrade: finalScore === 10 ? 'A' : 'B',
      };
      if (isRebreak) {
        sig.isRebreakSetup = true;
        sig.failedBreakLow = failedBreakLow;
        sig.failedBreakHigh = failedBreakHigh;
      }
      return sig;
    }

    log(
      isRebreak
        ? `[1m] Re-break confirmation window expired — back to watching failedBreakLow`
        : `[1m] Confirmation window expired — no valid 1m close below ${breakLevel}`,
    );
    dlbFileLog(isRebreak ? '[DLB-REBREAK-1M-EXPIRED]' : '[DLB-1M-EXPIRED]', {
      breakLevel,
      windowSize: win.length,
    });
    return null;
  }

  // ── Main state-machine loop ──────────────────────────────────────────────
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const label = candleLabel(candle, i);

    if (state === 'TRADE_TRIGGERED' || state === 'SETUP_INVALIDATED') {
      // Reset so we keep scanning for additional setups later in the day.
      const prevState = state;
      log(
        `DLB: State reset to WAITING_FOR_DAY_LOW_BREAK after ${state} — continuing scan`,
      );
      dlbFileLog('[DLB-STATE-RESET]', { from: state, candleLabel: label });
      state = 'WAITING_FOR_DAY_LOW_BREAK';
      failedBreakLow = 0;
      failedBreakHigh = 0;
      // After a trade, wait for recovery above dayFirst5mLow before new setups.
      // SETUP_INVALIDATED already means price is above dayFirst5mLow, no wait needed.
      if (prevState === 'TRADE_TRIGGERED') {
        requiresRecovery = true;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATE: WAITING_FOR_DAY_LOW_BREAK
    // ══════════════════════════════════════════════════════════════════════
    if (state === 'WAITING_FOR_DAY_LOW_BREAK') {
      // Wait for price to recover above dayFirst5mLow after a previous signal.
      if (requiresRecovery) {
        if (candle.close >= dayFirst5mLow) {
          requiresRecovery = false;
          log(
            `DLB: Recovery — price closed above dayFirst5mLow ${dayFirst5mLow} at ${label}. Ready for new setups.`,
          );
          dlbFileLog('[DLB-RECOVERY]', {
            candleLabel: label,
            close: candle.close,
            dayFirst5mLow,
            volume: candle.volume,
          });
        } else {
          continue; // Still below level, not ready for new setups yet
        }
      }

      if (candle.close < dayFirst5mLow) {
        // ── Clean breakdown ───────────────────────────────────────────────
        log(
          `DLB: Clean day-low breakdown detected ${label}: close ${candle.close} < ${dayFirst5mLow}`,
        );
        dlbFileLog('[DLB-CLEAN-BREAKDOWN]', {
          candleLabel: label,
          close: candle.close,
          dayFirst5mLow,
          volume: candle.volume,
        });

        const range = candle.high - candle.low;
        const body = Math.abs(candle.close - candle.open);
        const bodyRatio = range > 0 ? body / range : 0;
        if (bodyRatio < min5mBreakdownBodyRatio) {
          log(
            `DLB: Skipped — 5m body too weak (${(bodyRatio * 100).toFixed(0)}%` +
              ` < ${(min5mBreakdownBodyRatio * 100).toFixed(0)}%)`,
          );
          dlbFileLog('[DLB-SKIPPED-WEAK-5M]', {
            candleLabel: label,
            bodyRatio,
            min5mBreakdownBodyRatio,
            volume: candle.volume,
          });
          continue;
        }

        // ── Max breakdown depth ────────────────────────────────────────────
        // Skip candles that crash too far through the level in a single bar.
        // Such candles anchor the SL high above entry producing enormous risk.
        const breakDepth = dayFirst5mLow - candle.close;
        if (maxBreakdownDepthPts > 0 && breakDepth > maxBreakdownDepthPts) {
          log(
            `DLB: Skipped — 5m close ${candle.close} is ${breakDepth.toFixed(1)} pts below dayFirst5mLow ${dayFirst5mLow}` +
              ` (> maxBreakdownDepthPts ${maxBreakdownDepthPts})`,
          );
          dlbFileLog('[DLB-SKIPPED-DEPTH]', {
            candleLabel: label,
            close: candle.close,
            dayFirst5mLow,
            breakDepth: +breakDepth.toFixed(1),
            maxBreakdownDepthPts,
            volume: candle.volume,
          });
          continue;
        }

        const sig = attempt1mConfirmation(
          dayFirst5mLow,
          i,
          candle.high,
          false,
          ema20Series ? (ema20Series[i] ?? ema20) : ema20,
        );
        if (sig) {
          const sigD = new Date(candle.date as any);
          const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
          if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
            signals.push(sig);
            state = 'TRADE_TRIGGERED';
          }
          // Don't return — let the loop top reset state and continue scanning
        }
      } else if (candle.low < dayFirst5mLow && candle.close >= dayFirst5mLow) {
        // ── Failed breakdown ──────────────────────────────────────────────
        log(
          `DLB: Failed breakdown detected — ${label}: low ${candle.low} < ${dayFirst5mLow} but closed above at ${candle.close}`,
        );
        log(
          `DLB: Failed-break low stored: ${candle.low}, high: ${candle.high}`,
        );
        dlbFileLog('[DLB-FAILED-BREAKDOWN]', {
          candleLabel: label,
          low: candle.low,
          close: candle.close,
          dayFirst5mLow,
          failedBreakLow: candle.low,
          failedBreakHigh: candle.high,
          volume: candle.volume,
        });

        failedBreakLow = candle.low;
        failedBreakHigh = candle.high;
        state = 'WAITING_FOR_FAILED_BREAK_LOW_REBREAK';
        log(
          `DLB: Waiting for failed-break low re-break below ${failedBreakLow}`,
        );
      }
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATE: WAITING_FOR_FAILED_BREAK_LOW_REBREAK
    // ══════════════════════════════════════════════════════════════════════
    if (state === 'WAITING_FOR_FAILED_BREAK_LOW_REBREAK') {
      // ── Invalidation: price reclaims above failedBreakHigh ───────────────
      if (candle.close > failedBreakHigh) {
        log(
          `DLB: Setup invalidated — ${label} close ${candle.close} > failedBreakHigh ${failedBreakHigh}`,
        );
        dlbFileLog('[DLB-SETUP-INVALIDATED]', {
          candleLabel: label,
          close: candle.close,
          failedBreakHigh,
          volume: candle.volume,
        });
        state = 'SETUP_INVALIDATED';
        // Skip the rest of this candle's processing immediately.  The loop top
        // on the NEXT iteration will reset state → WAITING_FOR_DAY_LOW_BREAK and
        // clear failedBreakLow/High.  Without this continue, the "another failed
        // break" and "strong re-break" blocks below could run on the same candle
        // that just invalidated the setup, producing confusing state transitions.
        continue;
      }

      // ── Another failed break → update levels (take lower low, higher high) ─
      if (candle.low < dayFirst5mLow && candle.close >= dayFirst5mLow) {
        if (candle.low < failedBreakLow) {
          failedBreakLow = candle.low;
          log(`DLB: Failed-break low updated to ${failedBreakLow}`);
        }
        if (candle.high > failedBreakHigh) {
          failedBreakHigh = candle.high;
          log(`DLB: Failed-break high updated to ${failedBreakHigh}`);
        }
        dlbFileLog('[DLB-FAILED-BREAK-UPDATED]', {
          candleLabel: label,
          failedBreakLow,
          failedBreakHigh,
          volume: candle.volume,
        });
        continue;
      }

      // ── Strong re-break: 5m close below failedBreakLow ───────────────────
      if (candle.close < failedBreakLow) {
        log(
          `DLB: Failed-break low re-broken ${label}: close ${candle.close} < failedBreakLow ${failedBreakLow}`,
        );
        dlbFileLog('[DLB-REBREAK-DETECTED]', {
          candleLabel: label,
          close: candle.close,
          failedBreakLow,
          failedBreakHigh,
          volume: candle.volume,
        });

        const range = candle.high - candle.low;
        const body = Math.abs(candle.close - candle.open);
        const bodyRatio = range > 0 ? body / range : 0;
        if (bodyRatio < min5mBreakdownBodyRatio) {
          log(
            `DLB: Skipped — re-break candle too weak (${(bodyRatio * 100).toFixed(0)}%)`,
          );
          dlbFileLog('[DLB-SKIPPED-WEAK-REBREAK]', {
            candleLabel: label,
            bodyRatio,
            min5mBreakdownBodyRatio,
          });
          continue;
        }

        // ── Max breakdown depth (re-break path) ───────────────────────────
        const rebreakDepth = failedBreakLow - candle.close;
        if (maxBreakdownDepthPts > 0 && rebreakDepth > maxBreakdownDepthPts) {
          log(
            `DLB: Skipped — re-break candle close ${candle.close} is ${rebreakDepth.toFixed(1)} pts below failedBreakLow ${failedBreakLow}` +
              ` (> maxBreakdownDepthPts ${maxBreakdownDepthPts})`,
          );
          dlbFileLog('[DLB-SKIPPED-REBREAK-DEPTH]', {
            candleLabel: label,
            close: candle.close,
            failedBreakLow,
            rebreakDepth: +rebreakDepth.toFixed(1),
            maxBreakdownDepthPts,
          });
          continue;
        }

        log(
          `DLB: Waiting for 1-minute confirmation below failed-break low ${failedBreakLow}`,
        );
        const sig = attempt1mConfirmation(
          failedBreakLow,
          i,
          candle.high,
          true,
          ema20Series ? (ema20Series[i] ?? ema20) : ema20,
        );
        if (sig) {
          const sigD = new Date(candle.date as any);
          const sigMins = sigD.getHours() * 60 + sigD.getMinutes();
          if (sigMins >= tradeStartMins && sigMins <= tradeEndMins) {
            signals.push(sig);
            state = 'TRADE_TRIGGERED';
          }
          // Don't return — let the loop top reset state and continue scanning
        }
        // If 1m expired, stay in WAITING_FOR_FAILED_BREAK_LOW_REBREAK for next candle
      }
      continue;
    }
  }

  log(`DLB: Scan complete. State=${state}. ${signals.length} signal(s) found.`);
  dlbFileLog('[DLB-SCAN-COMPLETE]', {
    totalCandles: candles.length,
    finalState: state,
    totalSignals: signals.length,
  });
  return signals;
}

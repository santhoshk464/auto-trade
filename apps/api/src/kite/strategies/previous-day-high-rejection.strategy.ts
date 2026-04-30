/**
 * Previous Day High Rejection Strategy (PDHR)
 *
 * Monitors NIFTY SPOT 5-minute candles for bearish rejections of the
 * Previous Day High (PDH) level.
 *
 * Signal logic:
 *   1. Price must first TOUCH or EXCEED PDH (candle.high >= pdh − touchTolerance,
 *      OR first candle opens above PDH = gap-up open).
 *   2. Any subsequent 5-minute candle that CLOSES BELOW PDH triggers entry.
 *   3. After a signal, price must RECOVER (close >= pdh) before re-entry.
 *   4. Maximum 2 signals per session.
 *
 * Entry  : close of the triggering 5-minute candle
 * SL     : triggering candle's high + slBuffer
 *          (natural SL distance < minStopLossPoints → use minStopLossPoints)
 * T1     : entry − risk × 1  (1:1 RR)
 * T2     : entry − risk × 2  (1:2 RR, primary — capped at PDL when provided)
 * T3     : entry − risk × 3  (1:3 RR, capped at PDL when provided)
 *
 * A++ Setup: signal grade is 'A++' when the rejection candle (or the
 * sequence ending with it) matches one of these bearish reversal patterns
 * near PDH: Shooting Star, Evening Star, Bearish Engulfing, Bearish Kicker.
 * All other signals are grade 'A'.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

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
   * Default: undefined (no cap on targets)
   */
  previousDayLow?: number;

  /**
   * Points below PDH within which a candle high counts as "touching PDH".
   * Also used to identify whether the rejection candle formed near PDH for
   * pattern detection.
   * Default: 5
   */
  touchTolerance?: number;

  /**
   * Buffer (points) added above the entry candle's high for the stop-loss.
   * Default: 3
   */
  stopLossBuffer?: number;

  /**
   * Minimum stop-loss distance (points) from entry.
   * If the natural SL distance (candle high + buffer − entry) is smaller than
   * this, the SL is extended to entry + minStopLossPoints.
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

export interface PdhrSignal {
  strategyName: 'Prev Day High Rejection';
  signal: true;
  setupType: 'PREV_DAY_HIGH_REJECTION';

  /** 5-minute candle close price — used as the short-entry price. */
  entryPrice: number;

  /** Stop-loss level (in SPOT points). */
  stopLoss: number;

  /** PDH level that was rejected. */
  previousDayHigh: number;

  /** PDL level — max target cap (when provided). */
  previousDayLow?: number;

  /** Index of the triggering 5m candle in the input `candles` array. */
  setupIndex: number;

  /** Human-readable signal description. */
  reason: string;

  /** 1 = first entry of the day, 2 = re-entry after first SL hit. */
  signalNumber: 1 | 2;

  /** True when a recognised bearish reversal pattern was detected. */
  isAplusPlus: boolean;

  /** Name of the A++ pattern, or null if none detected. */
  pattern: string | null;

  /** Grade derived from pattern presence. */
  setupGrade: 'A++' | 'A';

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
 * Detect whether the candle at `idx` (or the 2-3 candle sequence ending at it)
 * forms a recognised A++ bearish reversal pattern near PDH.
 *
 * Checks (in order):
 *   1. Shooting Star  — single candle, long upper wick, closes near low
 *   2. Evening Star   — 3-candle sequence: strong bull → small doji near PDH → strong bear
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
  // Long upper wick (≥ 55 % range), small body (≤ 35 % range), candle high
  // near or above PDH. Works for both bearish and doji-type shooting stars.
  if (
    upperWick / range >= 0.55 &&
    body / range <= 0.35 &&
    c.high >= pdh - touchTol
  ) {
    return { isAplusPlus: true, pattern: 'Shooting Star' };
  }

  // ── 2. Evening Star ───────────────────────────────────────────────────────
  // prev2: strong bullish candle; prev: small body (indecision) near PDH;
  // c (current): strong bearish close.
  if (prev && prev2) {
    const prevRange = prev.high - prev.low;
    const prevBody = Math.abs(prev.close - prev.open);
    const prev2Range = prev2.high - prev2.low;
    const prev2Body = Math.abs(prev2.close - prev2.open);

    if (
      prev2.close > prev2.open && // prev2 is bullish
      prev2Body / (prev2Range || 1) >= 0.5 && // prev2 has solid bullish body
      prevBody / (prevRange || 1) <= 0.3 && // prev is doji / small body
      prev.high >= pdh - touchTol && // doji formed near PDH
      isBearish && // current candle is bearish
      body / range >= 0.45 // current has meaningful bearish body
    ) {
      return { isAplusPlus: true, pattern: 'Evening Star' };
    }
  }

  // ── 3. Bearish Engulfing ──────────────────────────────────────────────────
  // Current bearish candle's body fully engulfs the prior bullish candle's body.
  if (prev && isBearish) {
    const isBullishPrev = prev.close > prev.open;
    if (
      isBullishPrev &&
      c.open >= prev.close && // opens at or above prior close
      c.close <= prev.open // closes at or below prior open
    ) {
      return { isAplusPlus: true, pattern: 'Bearish Engulfing' };
    }
  }

  // ── 4. Bearish Kicker ─────────────────────────────────────────────────────
  // Strong gap-reversal: bearish candle opens BELOW prior bullish candle's open.
  if (prev && isBearish) {
    const isBullishPrev = prev.close > prev.open;
    const prevRange = prev.high - prev.low;
    const prevBody = Math.abs(prev.close - prev.open);
    if (
      isBullishPrev &&
      prevBody / (prevRange || 1) >= 0.5 && // prior was a strong bullish bar
      c.open < prev.open && // current opens below prior open (gap / sharp reversal)
      body / range >= 0.55 // current has a strong bearish body
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

  log(
    `PDHR scan: PDH=${pdh}, PDL=${pdl ?? 'none'}, candles=${candles.length}`,
  );

  // ── State ────────────────────────────────────────────────────────────────
  // requiresRecovery — after a signal fires, wait for close ≥ PDH before
  //                    the next entry is allowed (prevents cascade signals on
  //                    continuous downtrends far below PDH).
  //
  // pendingBeCandle — when a Bearish Engulfing candle closes less than 50%
  //                   of its body below PDH, entry is deferred. We store the
  //                   original BE candle so we can use its high for the SL
  //                   if the NEXT candle confirms (is red).
  let requiresRecovery = false;
  let signalCount = 0;
  let pendingBeCandle: PdhrCandle | null = null; // deferred Bearish Engulfing

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const label = candleLabel(candle, i);

    // Max signals reached — done for the day
    if (signalCount >= maxSignals) break;

    // ── Time gate ──────────────────────────────────────────────────────────
    const d = new Date(candle.date as any);
    const mins = d.getHours() * 60 + d.getMinutes();

    // ── Recovery: wait for close ≥ PDH after previous signal ──────────────
    if (requiresRecovery) {
      pendingBeCandle = null; // cancel any deferred BE waiting
      if (candle.close >= pdh) {
        requiresRecovery = false;
        log(`Recovery complete at ${label}: close=${candle.close} >= PDH ${pdh}`);
        // Recovery candle itself is at/above PDH — skip it as entry.
      }
      continue;
    }

    // ── Bearish Engulfing confirmation candle ─────────────────────────────
    // If the previous candle was a weak BE (< 50% body below PDH), check
    // whether this candle is red (close < open). If yes → confirmed entry.
    if (pendingBeCandle !== null) {
      const beCandle = pendingBeCandle;
      pendingBeCandle = null; // consume the pending state

      if (candle.close < candle.open) {
        // Red confirmation candle → entry at this candle's close
        const entryPrice = candle.close;
        // SL: use the higher of the two candle highs (the BE candle reached PDH,
        // the confirmation candle may be lower — use whichever is higher + buffer).
        const slHigh = Math.max(beCandle.high, candle.high);
        const naturalSlDist = slHigh + stopLossBuffer - entryPrice;
        const risk = Math.max(naturalSlDist, minStopLossPoints);
        const stopLoss = entryPrice + risk;

        const t1 = entryPrice - risk;
        const t2Raw = entryPrice - risk * 2;
        const t3Raw = entryPrice - risk * 3;
        const t2 = pdl != null ? Math.max(t2Raw, pdl) : t2Raw;
        const t3 = pdl != null ? Math.max(t3Raw, pdl) : t3Raw;

        const reason =
          `PDHR #${signalCount + 1}: ${label} BE confirmation (red candle) close ${entryPrice.toFixed(2)} below PDH ${pdh}` +
          ` | SL ${stopLoss.toFixed(2)} | T1 ${t1.toFixed(2)} | T2 ${t2.toFixed(2)}` +
          ` | A++ Pattern: Bearish Engulfing`;

        log(reason);

        signals.push({
          strategyName: 'Prev Day High Rejection',
          signal: true,
          setupType: 'PREV_DAY_HIGH_REJECTION',
          entryPrice,
          stopLoss,
          previousDayHigh: pdh,
          previousDayLow: pdl,
          setupIndex: i,
          reason,
          signalNumber: (signalCount + 1) as 1 | 2,
          isAplusPlus: true,
          pattern: 'Bearish Engulfing',
          setupGrade: 'A++',
          t1,
          t2,
          t3,
        });

        signalCount++;
        requiresRecovery = true;
      } else {
        log(`${label}: BE confirmation candle is not red (close=${candle.close} >= open=${candle.open}) — signal cancelled`);
      }
      continue; // whether confirmed or not, don't re-evaluate this candle as a fresh trigger
    }

    // ── Time gate ─────────────────────────────────────────────────────────
    if (mins < tradeStartMins || mins > tradeEndMins) {
      log(`Outside trade window at ${label} (${mins} mins) — skipping`);
      continue;
    }

    // ── Entry trigger ─────────────────────────────────────────────────────
    // The triggering candle ITSELF must satisfy ALL three conditions:
    //   1. Be a RED/bearish candle  (close < open)
    //   2. Have high >= PDH         (candle touched or pierced PDH)
    //   3. Have close < PDH         (closed below PDH — rejection confirmed)
    //
    // A GREEN candle that touched PDH but closed above its open is NOT a
    // rejection signal — it shows buyers are still in control.
    if (candle.close >= candle.open) {
      log(`${label}: green candle (close=${candle.close} >= open=${candle.open}) — not bearish, skip`);
      continue;
    }
    if (candle.high < pdh) {
      log(`${label}: high=${candle.high} < PDH ${pdh} — never touched, skip`);
      continue;
    }
    if (candle.close >= pdh) {
      log(`${label}: high=${candle.high} >= PDH but close=${candle.close} >= PDH — no rejection yet`);
      continue;
    }

    // ── A++ pattern detection ─────────────────────────────────────────────
    const { isAplusPlus, pattern } = detectBearishPattern(
      candles,
      i,
      pdh,
      touchTolerance,
    );

    // ── Bearish Engulfing: 50% body rule ──────────────────────────────────
    // A Bearish Engulfing candle that closes only slightly below PDH (less
    // than 50% of its bearish body is below PDH) is a weak signal on its own.
    // Defer entry to the NEXT candle: if the next candle is red → entry then.
    if (pattern === 'Bearish Engulfing') {
      const body = candle.open - candle.close; // positive (bearish: open > close)
      const bodyBelowPdh = pdh - candle.close; // portion of body that is below PDH
      if (body > 0 && bodyBelowPdh / body < 0.5) {
        log(
          `${label}: Bearish Engulfing but only ${(bodyBelowPdh / body * 100).toFixed(0)}% of body below PDH — waiting for next red candle`,
        );
        pendingBeCandle = candle;
        continue;
      }
    }

    // ── Compute SL and targets ─────────────────────────────────────────────
    const entryPrice = candle.close;
    const naturalSlDist = candle.high + stopLossBuffer - entryPrice;
    const risk = Math.max(naturalSlDist, minStopLossPoints);
    const stopLoss = entryPrice + risk;

    const t1 = entryPrice - risk; // 1:1
    const t2Raw = entryPrice - risk * 2; // 1:2
    const t3Raw = entryPrice - risk * 3; // 1:3

    // Cap at PDL (lowest allowed target)
    const t2 = pdl != null ? Math.max(t2Raw, pdl) : t2Raw;
    const t3 = pdl != null ? Math.max(t3Raw, pdl) : t3Raw;

    const reason =
      `PDHR #${signalCount + 1}: ${label} close ${entryPrice.toFixed(2)} below PDH ${pdh}` +
      ` | SL ${stopLoss.toFixed(2)} | T1 ${t1.toFixed(2)} | T2 ${t2.toFixed(2)}` +
      (pattern ? ` | A++ Pattern: ${pattern}` : '');

    log(reason);

    signals.push({
      strategyName: 'Prev Day High Rejection',
      signal: true,
      setupType: 'PREV_DAY_HIGH_REJECTION',
      entryPrice,
      stopLoss,
      previousDayHigh: pdh,
      previousDayLow: pdl,
      setupIndex: i,
      reason,
      signalNumber: (signalCount + 1) as 1 | 2,
      isAplusPlus,
      pattern,
      setupGrade: isAplusPlus ? 'A++' : 'A',
      t1,
      t2,
      t3,
    });

    signalCount++;
    // Require price to recover above PDH before re-entry
    requiresRecovery = true;
  }

  log(`PDHR scan complete: ${signals.length} signal(s) found.`);
  return signals;
}

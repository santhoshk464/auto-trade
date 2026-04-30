/**
 * Super Power Pack Selling Strategy — Combined
 *
 * SUPER_POWER_PACK — Runs five orthogonal bearish-sell setups on identical data:
 *   1. DHR          — Day High Rejection       (price rejects rolling session high)
 *   2. PDHR         — Previous Day High Rejection (price rejects yesterday's high)
 *   3. DAY_REVERSAL — Day Reversal Sell        (new session high then strong bear candle)
 *   4. DLB          — Day Low Break            (price breaks below first 5m candle low)
 *   5. EMA_REJ      — 20 EMA Rejection         (pullback to 20 EMA fails, resumes downside)
 *
 * Priority / deduplication:
 *   A given 5-minute setup-candle index can only produce ONE signal.
 *   If two or more engines detect a setup on the same candle, the highest-priority
 *   engine wins: DHR > PDHR > DAY_REVERSAL > DLB > EMA_REJ.
 *
 * All five engines receive IDENTICAL candle data (5m + 1m) and the same
 * pre-seeded EMA context.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond debug logs.
 */

import {
  detectDayHighRejectionOnly,
  type DhrCandle,
  type DhrConfig,
  type DhrSignal,
} from './day-high-rejection.strategy';
import {
  detectDayLowBreakOnly,
  type DlbConfig,
  type DlbSignal,
} from './day-low-break.strategy';
import {
  detectEmaRejectionOnly,
  type EmaRejConfig,
  type EmaRejSignal,
} from './ema-rejection.strategy';
import {
  detectDayReversalOnly,
  type DrConfig,
  type DrSignal,
} from './day-reversal.strategy';
import {
  detectPreviousDayHighRejectionOnly,
  type PdhrConfig,
  type PdhrSignal,
} from './previous-day-high-rejection.strategy';

// ─── Signal type ──────────────────────────────────────────────────────────────

/**
 * A signal emitted by the Super Power Pack engine.
 * Discriminate by `source` to determine which sub-strategy fired:
 *   'DHR'          → Day High Rejection
 *   'DLB'          → Day Low Break
 *   'EMA_REJ'      → 20 EMA Rejection
 *   'DAY_REVERSAL' → Day Reversal (Sell)
 *   'PDHR'         → Previous Day High Rejection
 */
export type SuperPowerPackSignal =
  | (DhrSignal & { source: 'DHR' })
  | (DlbSignal & { source: 'DLB' })
  | (EmaRejSignal & { source: 'EMA_REJ' })
  | (DrSignal & { source: 'DAY_REVERSAL' })
  | (PdhrSignal & { source: 'PDHR' });

// ─── Params ───────────────────────────────────────────────────────────────────

export interface SuperPowerPackParams {
  /** 5-minute option/spot candles (same array fed to all engines). */
  candles: DhrCandle[];
  /** 1-minute candles for entry confirmation (shared). */
  candles1m?: DhrCandle[];
  /**
   * 20-EMA value at the last yesterday candle (session-open gate).
   * Used by DHR for the bearish-session filter and by DLB for first-candle
   * opened-below-EMA session scoring.
   */
  ema20?: number;
  /**
   * Per-candle 20-EMA series aligned to `candles` (seeded with yesterday data).
   * Used by DLB for the at-signal EMA gate and by EMA_REJ for all EMA math.
   * When absent or mismatched in length, EMA_REJ silently produces no signals.
   */
  ema20Series?: (number | null)[];
  /**
   * Points per ATM premium unit used to scale DHR's touchTolerance / SL buffer.
   * Defaults to 20.
   */
  marginPoints?: number;
  /** Override DHR-specific configuration. */
  dhrConfig?: DhrConfig;
  /** Override DLB-specific configuration. */
  dlbConfig?: DlbConfig;
  /** Override EMA-REJ-specific configuration. */
  emaRejConfig?: EmaRejConfig;
  /** Override DAY_REVERSAL-specific configuration. */
  drConfig?: DrConfig;
  /**
   * Previous Day High of the SPOT index.
   * When provided (> 0), PDHR detection is enabled on `candles`.
   * Only meaningful when `candles` are SPOT index candles.
   */
  previousDayHigh?: number;
  /** Previous Day Low — used as PDHR target cap and range quality calculation. */
  previousDayLow?: number;
  /**
   * Previous Day Close — used by PDHR to compute range quality.
   * A close in the top third of the previous day range skips PDHR entirely.
   */
  previousDayClose?: number;
  /** Previous Day Open — echoed on PDHR signals for context. */
  previousDayOpen?: number;
  /** Override PDHR-specific configuration. */
  pdhrConfig?: PdhrConfig;
  debug?: boolean;
}

// ─── Combined detector ────────────────────────────────────────────────────────

export function detectSuperPowerPackSignals(
  params: SuperPowerPackParams,
): SuperPowerPackSignal[] {
  const {
    candles,
    candles1m,
    ema20,
    ema20Series,
    marginPoints = 20,
    dhrConfig,
    dlbConfig,
    emaRejConfig,
    drConfig,
    previousDayHigh = 0,
    previousDayLow,
    previousDayClose,
    previousDayOpen,
    pdhrConfig,
    debug = false,
  } = params;

  const touchTol = Math.max(5, Math.round(marginPoints * 1.5));
  const slBuf = Math.max(3, Math.round(marginPoints / 4));

  // ── DHR ────────────────────────────────────────────────────────────────────
  const dhrSignals = detectDayHighRejectionOnly(
    candles,
    {
      touchTolerance: touchTol,
      stopLossBuffer: slBuf,
      requireNextCandleConfirmation: false,
      ema20,
      useOneMinuteEntryConfirmation: true,
      oneMinuteConfirmationWindow: 10,
      enableTwoCandleConfirm: false,
      enableLowBreakConfirm: false,
      enableFiveMinuteSignalLowBreakConfirm: true,
      // Require the rolling high zone to have held for ≥ 3 five-minute candles
      // (15 minutes) before DHR can fire.  Without this gate the live scheduler
      // (which evaluates candles only up to currentTime) can mistake a transient
      // morning peak for the "day high" and place a SELL order that hits SL when
      // the market later surpasses that level.  Trade Finder evaluates the full
      // day (specificTime = 15:30) and naturally avoids this — this gate makes
      // the live scheduler consistent with Trade Finder.
      minZoneAgeCandles: 3,
      debug,
      ...dhrConfig,
    },
    candles1m,
  );

  // ── DLB ────────────────────────────────────────────────────────────────────
  const dlbSignals = detectDayLowBreakOnly(
    candles,
    {
      stopLossBuffer: slBuf,
      min5mBreakdownBodyRatio: 0.3,
      oneMinuteConfirmationWindow: 10,
      minRRRatio: 1.5,
      ema20,
      ema20Series,
      debug,
      ...dlbConfig,
    },
    candles1m,
  );

  // ── Day Reversal ───────────────────────────────────────────────────────────
  const drSignals = detectDayReversalOnly(candles as any, {
    stopLossBuffer: slBuf,
    minRallyPoints: Math.max(15, marginPoints),
    minRRRatio: 0,
    ema20,
    debug,
    ...drConfig,
  });

  // ── EMA Rejection ──────────────────────────────────────────────────────────
  const emaRejSignals = detectEmaRejectionOnly(
    candles,
    ema20Series ?? [],
    {
      emaTouchBufferPts: Math.max(3, Math.round(marginPoints * 0.5)),
      emaBreakTolerancePts: Math.max(5, Math.round(marginPoints)),
      stopLossBuffer: slBuf,
      minRiskRewardReference: 1.5,
      // Caller controls the SL-width gate (e.g. Infinity for paper sizing mode).
      maxAllowedSLReference: Infinity,
      oneMinuteConfirmationWindow: 10,
      debug,
      ...emaRejConfig,
    },
    candles1m,
  );

  // ── PDHR (Previous Day High Rejection) ────────────────────────────────────
  // Only runs when `previousDayHigh` is provided — meaningful only on SPOT candles.
  const pdhrSignals =
    previousDayHigh > 0
      ? detectPreviousDayHighRejectionOnly(candles as any, {
          previousDayHigh,
          previousDayLow,
          previousDayClose,
          previousDayOpen,
          stopLossBuffer: slBuf,
          debug,
          ...pdhrConfig,
        })
      : [];

  // ── Tag with source ─────────────────────────────────────────────────────────
  const dhrTagged: SuperPowerPackSignal[] = dhrSignals.map((s) => ({
    ...s,
    source: 'DHR' as const,
  }));
  const dlbTagged: SuperPowerPackSignal[] = dlbSignals.map((s) => ({
    ...s,
    source: 'DLB' as const,
  }));
  const emaTagged: SuperPowerPackSignal[] = emaRejSignals.map((s) => ({
    ...s,
    source: 'EMA_REJ' as const,
  }));
  const drTagged: SuperPowerPackSignal[] = drSignals.map((s) => ({
    ...s,
    source: 'DAY_REVERSAL' as const,
  }));
  const pdhrTagged: SuperPowerPackSignal[] = pdhrSignals.map((s) => ({
    ...s,
    source: 'PDHR' as const,
  }));

  // ── Deduplicate by setupIndex (DHR > PDHR > DAY_REVERSAL > DLB > EMA_REJ) ──
  const usedSetupIndices = new Set<number>();
  const combined: SuperPowerPackSignal[] = [];

  for (const sig of dhrTagged) {
    usedSetupIndices.add(sig.setupIndex);
    combined.push(sig);
  }
  for (const sig of pdhrTagged) {
    if (!usedSetupIndices.has(sig.setupIndex)) {
      usedSetupIndices.add(sig.setupIndex);
      combined.push(sig);
    }
  }
  for (const sig of drTagged) {
    if (!usedSetupIndices.has(sig.setupIndex)) {
      usedSetupIndices.add(sig.setupIndex);
      combined.push(sig);
    }
  }
  for (const sig of dlbTagged) {
    if (!usedSetupIndices.has(sig.setupIndex)) {
      usedSetupIndices.add(sig.setupIndex);
      combined.push(sig);
    }
  }
  for (const sig of emaTagged) {
    if (!usedSetupIndices.has(sig.setupIndex)) {
      usedSetupIndices.add(sig.setupIndex);
      combined.push(sig);
    }
  }

  combined.sort((a, b) => a.setupIndex - b.setupIndex);
  return combined;
}

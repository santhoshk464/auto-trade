/**
 * Day Selling V1+V2 Combined Strategy — Standalone
 *
 * DAY_SELLING_V1V2 — Combined fallback engine.
 * Runs V1 first on every candle. If V1 produces no signal for that candle,
 * V2 is tried as a fallback. Both engines receive IDENTICAL data.
 * A candle can only produce one signal (V1 takes priority).
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import {
  detectDaySellSignals,
  type DaySellSignal,
} from './day-selling-v1.strategy';
import { detectDaySellSignalsV2 } from './day-selling-v2.strategy';

export function detectDaySellSignalsCombined(
  params: Parameters<typeof detectDaySellSignals>[0],
): DaySellSignal[] {
  const v1Signals = detectDaySellSignals(params);
  const v2Signals = detectDaySellSignalsV2(params);

  const v1Indices = new Set(v1Signals.map((s) => s.actualCandleIndex));

  const v2Fallback = v2Signals.filter(
    (s) => !v1Indices.has(s.actualCandleIndex),
  );

  const combined = [...v1Signals, ...v2Fallback];
  combined.sort((a, b) => a.actualCandleIndex - b.actualCandleIndex);
  return combined;
}

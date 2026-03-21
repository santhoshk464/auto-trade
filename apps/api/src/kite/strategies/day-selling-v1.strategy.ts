/**
 * Day Selling V1 Strategy — Standalone
 *
 * Detects bearish sell signals using the original V1 engine.
 * Extracted from KiteService for maintainability.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import { diagLog } from './diag-log';

export type DaySellSignal = {
  candleIndex: number;
  actualCandleIndex: number;
  candleTime: string;
  candleDate: Date;
  unixTimestamp: number;
  reason: string;
  entryPrice: number;
  stopLoss: number;
  risk: number;
  candleRSI: number | null;
  isDayHighZoneRejection: boolean;
  nearDayHighZone: boolean;
  isNearDailyHigh: boolean;
};

export function detectDaySellSignals(params: {
  candles: any[];
  emaValues: (number | null)[];
  rsiValues: (number | null)[];
  swingHighs: Array<{ price: number; index: number }>;
  yesterdayHigh: number;
  prevDayLow?: number;
  prevDayClose?: number;
  marginPoints: number;
  minSellRsi?: number;
  maxSellRiskPts?: number;
  realtimeMode?: boolean;
  instrumentName?: string;
  superTrendData?: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
}): DaySellSignal[] {
  const {
    candles,
    emaValues,
    rsiValues,
    swingHighs,
    yesterdayHigh,
    prevDayLow = 0,
    prevDayClose = 0,
    marginPoints,
    minSellRsi = 45,
    maxSellRiskPts = 25,
    realtimeMode = false,
    instrumentName = '',
    superTrendData,
  } = params;

  const results: DaySellSignal[] = [];

  // ── Diagnostic file logger ────────────────────────────────────────────
  // --- Day-high zone state ---
  let rollingHigh = 0;
  let confirmedResZone = 0;
  let confirmedResZoneIndex = -1;
  let pulledBackFromResZone = false;
  let dayHighZoneTestCount = 0;

  // In realtimeMode only scan the last 2 candles, but we still need zone state
  // from all earlier candles — process them first in a pre-pass.
  const scanStartIndex = realtimeMode ? Math.max(1, candles.length - 2) : 1;

  const updateZone = (c: any, idx: number) => {
    const h = c.high;
    const l = c.low;
    const body = Math.abs(c.close - c.open);
    const wick = h - Math.max(c.open, c.close);
    const range = h - l;
    if (h > rollingHigh) {
      rollingHigh = h;
      const wr = range > 0 ? wick / range : 0;
      const br = range > 0 ? body / range : 0;
      if (
        br < 0.1 ||
        (wr > 0.35 && wick > body * 1.5) ||
        (c.close < c.open && body > range * 0.35)
      ) {
        confirmedResZone = h;
        confirmedResZoneIndex = idx;
        pulledBackFromResZone = false;
        dayHighZoneTestCount = 0;
      }
    }
    if (
      confirmedResZone > 0 &&
      !pulledBackFromResZone &&
      l < confirmedResZone - marginPoints * 2
    ) {
      pulledBackFromResZone = true;
    }
    if (
      pulledBackFromResZone &&
      confirmedResZone > 0 &&
      Math.abs(h - confirmedResZone) <= marginPoints * 1.5
    ) {
      dayHighZoneTestCount++;
    }
  };

  // First candle of the day (9:15 candle) — used for 1st-candle-low-break and retest patterns
  const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
  const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;
  const firstCandleLowBreakLevel = firstCandleLow;
  let firstCandleLowBreakFired = false;
  if (firstCandleLow > 0 && realtimeMode) {
    for (let pi = 1; pi < candles.length - 1; pi++) {
      if (candles[pi]?.close < firstCandleLowBreakLevel) {
        firstCandleLowBreakFired = true;
        break;
      }
    }
  }

  for (let pi = 0; pi < scanStartIndex; pi++) updateZone(candles[pi], pi);

  for (let i = scanStartIndex; i < candles.length; i++) {
    const candle = candles[i];
    const candleEMA = emaValues[i];

    const candleHigh = candle.high;
    const candleLow = candle.low;
    const candleOpen = candle.open;
    const candleClose = candle.close;
    const candleBody = Math.abs(candleClose - candleOpen);
    const upperWick = candleHigh - Math.max(candleOpen, candleClose);
    const lowerWick = Math.min(candleOpen, candleClose) - candleLow;
    const totalRange = candleHigh - candleLow;
    const isRedCandle = candleClose < candleOpen;
    const isGreenCandle = candleClose > candleOpen;

    // Update zone BEFORE time filter so state is always current
    updateZone(candle, i);

    // Time — needed for break check and other patterns
    const candleDate =
      candle.date instanceof Date ? candle.date : new Date(candle.date);
    const mins = candleDate.getHours() * 60 + candleDate.getMinutes();

    // ── Day 1st Candle Low Break ───────────────────────────────────────────
    if (
      i > 0 &&
      !firstCandleLowBreakFired &&
      firstCandleLow > 0 &&
      isRedCandle &&
      candleClose < firstCandleLowBreakLevel
    ) {
      // ── Condition 1: Valid breakdown candle ──
      const brkPrev1 = i >= 1 ? candles[i - 1] : null;
      const brkLargeBearishBody = candleBody > totalRange * 0.4;
      const brkBearishEngulfing =
        !!brkPrev1 &&
        brkPrev1.close > brkPrev1.open && // prev candle was green
        candleOpen >= brkPrev1.close && // opened at or above prev close
        candleClose < brkPrev1.open; // closed below prev open
      const brkStrongCloseNearLow =
        totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2; // close in bottom 20%

      const brkValidCandle =
        brkLargeBearishBody || brkBearishEngulfing || brkStrongCloseNearLow;
      if (!brkValidCandle) {
        diagLog('v1', '[V1-FCL-SKIP]', {
          instrument: instrumentName,
          candleTime: candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
          reason: 'weak-pattern',
          candleClose,
          candleHigh,
          firstCandleLow,
          brkLargeBearishBody,
          brkBearishEngulfing,
          brkStrongCloseNearLow,
        });
        continue;
      }

      if (candleEMA != null && candleEMA < candleClose) {
        firstCandleLowBreakFired = true;
        diagLog('v1', '[V1-FCL-SKIP]', {
          instrument: instrumentName,
          candleTime: candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
          reason: 'ema-below-close',
          candleClose,
          candleEMA,
        });
        continue;
      }

      firstCandleLowBreakFired = true;

      const breakSL = firstCandleLow + 2;
      const breakRisk = breakSL - candleClose;

      if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
        const brkEMASupport =
          candleEMA != null &&
          candleEMA < candleClose &&
          candleClose - candleEMA < breakRisk;

        const brkPrevDayLowSupport =
          prevDayLow > 0 &&
          prevDayLow < candleClose &&
          candleClose - prevDayLow < breakRisk;

        let brkIntradaySupport = false;
        for (let k = 1; k < i; k++) {
          const kLow = candles[k].low;
          if (kLow < candleClose && candleClose - kLow < breakRisk) {
            brkIntradaySupport = true;
            break;
          }
        }

        const brkHasNearbySupportBelow =
          brkEMASupport || brkPrevDayLowSupport || brkIntradaySupport;

        if (!brkHasNearbySupportBelow) {
          const brkPattern = brkBearishEngulfing
            ? 'Bearish Engulfing'
            : brkStrongCloseNearLow
              ? 'Strong Close Near Low'
              : 'Large Bearish Body';
          const breakRSI = rsiValues[i];
          const breakUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
          const breakTime = candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
          results.push({
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: breakTime,
            candleDate,
            unixTimestamp: breakUnixTs,
            reason: `Day 1st Candle Low Break (${brkPattern})`,
            entryPrice: candleClose,
            stopLoss: breakSL,
            risk: breakRisk,
            candleRSI: breakRSI,
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: false,
          });
        } else {
          diagLog('v1', '[V1-FCL-SKIP]', {
            instrument: instrumentName,
            candleTime: candleDate.toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            }),
            reason: 'nearby-support',
            candleClose,
            breakRisk,
            brkPrevDayLowSupport,
            brkIntradaySupport,
          });
        }
      } else if (breakRisk > 0) {
        diagLog('v1', '[V1-FCL-SKIP]', {
          instrument: instrumentName,
          candleTime: candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }),
          reason: 'risk-too-wide',
          breakRisk,
          maxAllowed: maxSellRiskPts * 2,
          candleClose,
          firstCandleLow,
        });
      }
      continue; // candle fully handled — skip remaining pattern checks
    }
    if (!candleEMA || mins < 9 * 60 + 30 || mins > 14 * 60 + 30) continue;

    // Day-high zone proximity (computed before EMA filter so it can bypass it)
    const nearDayHighZone =
      pulledBackFromResZone &&
      confirmedResZone > 0 &&
      i > confirmedResZoneIndex + 1 &&
      Math.abs(candleHigh - confirmedResZone) <= marginPoints * 1.5;

    // EMA trend filter — bypass for day-high zone candles
    const priceAboveEMA = candleClose > candleEMA;
    const gapFromEMA = Math.abs(candleClose - candleEMA);
    const highTouchesEMA =
      Math.abs(candleHigh - candleEMA) <= marginPoints * 1.5;
    if (
      priceAboveEMA &&
      !highTouchesEMA &&
      gapFromEMA < marginPoints * 1.5 &&
      !nearDayHighZone
    )
      continue;

    // Uptrend guard
    {
      let aboveEMA = 0;
      let counted = 0;
      for (let k = 0; k <= i; k++) {
        const ema = emaValues[k];
        if (ema == null) continue;
        counted++;
        if (candles[k].close > ema) aboveEMA++;
      }
      if (counted >= 3 && aboveEMA / counted > 0.6 && !nearDayHighZone) {
        continue;
      }
    }

    // Resistance level proximity
    const nearEMA = Math.abs(candleHigh - candleEMA) <= marginPoints;
    const nearYesterdayHigh =
      yesterdayHigh > 0 && Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
    const nearPrevDayClose =
      prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= marginPoints;
    const nearFirstCandleHigh =
      firstCandleHigh > 0 &&
      i > 3 &&
      Math.abs(candleHigh - firstCandleHigh) <= marginPoints;
    let nearSwingHigh = false;
    for (const swing of swingHighs) {
      if (
        swing.index < i - 3 &&
        Math.abs(candleHigh - swing.price) <= marginPoints
      ) {
        nearSwingHigh = true;
        break;
      }
    }
    if (
      !nearEMA &&
      !nearYesterdayHigh &&
      !nearPrevDayClose &&
      !nearFirstCandleHigh &&
      !nearSwingHigh &&
      !nearDayHighZone
    )
      continue;

    const emaTouchRejection =
      nearEMA &&
      isRedCandle &&
      candleHigh >= candleEMA - marginPoints * 0.5 &&
      candleClose < candleEMA;

    // Candle type check
    const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
    const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
    const nextIsRed = nextCandle ? nextCandle.close < nextCandle.open : false;
    const isGreenShootingStar =
      isGreenCandle &&
      nearEMA &&
      upperWick > candleBody * 2 &&
      upperWick > totalRange * 0.5 &&
      nextIsRed;
    if (
      !isRedCandle &&
      !(isDoji && nextIsRed) &&
      !isGreenShootingStar &&
      !nearDayHighZone &&
      !emaTouchRejection
    )
      continue;

    // Actual entry candle (DOJI / GreenSS → use next red candle)
    const useNextAsEntry =
      (isDoji || isGreenShootingStar) && nextIsRed && nextCandle;
    const actualEntry = useNextAsEntry ? nextCandle! : candle;
    const actualCandleIndex = useNextAsEntry ? i + 1 : i;
    const actualHigh = actualEntry.high;
    const actualClose = actualEntry.close;
    const actualOpen = actualEntry.open;
    const actualBody = Math.abs(actualClose - actualOpen);
    const actualUpperWick = actualHigh - Math.max(actualOpen, actualClose);
    const actualLowerWick = Math.min(actualOpen, actualClose) - actualEntry.low;
    const actualRange = actualHigh - actualEntry.low;
    const actualIsRed = actualClose < actualOpen;
    const actualIsGreen = actualClose > actualOpen;
    const actualDate =
      actualEntry.date instanceof Date
        ? actualEntry.date
        : new Date(actualEntry.date);
    const unixTimestamp = Math.floor(actualDate.getTime() / 1000) + 19800;

    // Context candles
    const prev1 = i >= 1 ? candles[i - 1] : null;
    const prev2 = i >= 2 ? candles[i - 2] : null;
    const prev3 = i >= 3 ? candles[i - 3] : null;

    // Resistance level (for pattern context)
    let resistanceTests = 0;
    const resistanceLevel = nearYesterdayHigh
      ? yesterdayHigh
      : nearSwingHigh
        ? swingHighs.find((s) => Math.abs(candleHigh - s.price) <= marginPoints)
            ?.price
        : candleEMA;
    if (resistanceLevel) {
      [prev3, prev2, prev1, candle].forEach((c) => {
        if (c && Math.abs(c.high - resistanceLevel) <= marginPoints * 1.5)
          resistanceTests++;
      });
    }

    // --- Pattern detection ---
    const weakCloseAtResistance =
      (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
      candleHigh >= (resistanceLevel || candleEMA) * 0.99 &&
      candleClose < candleHigh * 0.995 &&
      (isGreenCandle ? candleClose < candleOpen + candleBody * 0.5 : true) &&
      resistanceTests >= 2;

    const earlyRejection =
      (nearEMA || nearYesterdayHigh || nearSwingHigh) &&
      upperWick > candleBody * 1.2 &&
      upperWick > totalRange * 0.4 &&
      candleClose < candleHigh * 0.99 &&
      (!nearEMA || candleHigh >= candleEMA - marginPoints * 0.5);

    let momentumSlowing = false;
    if (prev2 && prev1) {
      const b2 = Math.abs(prev2.close - prev2.open);
      const b1 = Math.abs(prev1.close - prev1.open);
      momentumSlowing =
        isRedCandle && candleBody < b1 && b1 < b2 && resistanceTests >= 2;
    }

    const isShootingStar =
      upperWick > candleBody * 2 &&
      lowerWick < candleBody * 0.5 &&
      upperWick > totalRange * 0.6;

    const isBearishEngulfing =
      !!prev1 &&
      prev1.close > prev1.open &&
      candleOpen > prev1.close &&
      candleClose < prev1.open &&
      isRedCandle;

    const hasStrongRejection =
      isRedCandle &&
      upperWick > candleBody * 2 &&
      upperWick > totalRange * 0.5 &&
      candleClose < candleOpen * 0.98;

    let emaActsAsSupport = false;
    if (emaTouchRejection) {
      let emaBounceCount = 0;
      const emaSupportLookback = Math.min(10, i - 1);
      for (let k = Math.max(0, i - emaSupportLookback); k < i; k++) {
        const kc = candles[k];
        const ke = emaValues[k];
        if (ke == null) continue;
        const touchedEMA =
          Math.abs(kc.low - ke) <= marginPoints ||
          Math.abs(kc.close - ke) <= marginPoints;
        if (touchedEMA) {
          const nextKC = k + 1 < candles.length ? candles[k + 1] : null;
          if (nextKC && nextKC.close > nextKC.open) {
            emaBounceCount++;
          }
        }
      }
      if (emaBounceCount >= 2) emaActsAsSupport = true;
    }

    let emaBearishBelowCount = 0;
    const emaBearLookback = Math.min(6, i);
    for (let k = i - emaBearLookback; k < i; k++) {
      const kEMA = emaValues[k];
      if (kEMA != null && candles[k].close < kEMA) emaBearishBelowCount++;
    }
    const emaBearishStructure = emaBearishBelowCount >= 3;

    const emaRecentAboveCount = [i - 1, i - 2].reduce((cnt, k) => {
      if (k < 0) return cnt;
      const kEMA = emaValues[k];
      return kEMA != null && candles[k].close > kEMA ? cnt + 1 : cnt;
    }, 0);
    const emaIsFirstCrossBelow = emaRecentAboveCount >= 2;

    const emaLowerHighsForming =
      i >= 3 &&
      (candles[i - 1].high < candles[i - 2].high ||
        candles[i - 2].high < candles[i - 3].high);

    const bearishOpenAtEMA =
      emaTouchRejection &&
      !emaActsAsSupport &&
      emaBearishStructure &&
      !emaIsFirstCrossBelow &&
      emaLowerHighsForming;

    // Day-high zone rejection
    const emaForDHR = emaValues[i];
    const dhrResistanceLevel = nearDayHighZone
      ? confirmedResZone
      : nearYesterdayHigh
        ? yesterdayHigh
        : prevDayClose;
    const emaFarBelowZone =
      emaForDHR != null && dhrResistanceLevel - emaForDHR > marginPoints * 2;
    const rsiForDHR = rsiValues[i];
    const rsiNotOversold = rsiForDHR == null || rsiForDHR > 35;
    const dhrLongUpperWick =
      upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
    const dhrBearishEngulfing =
      !!prev1 &&
      prev1.close > prev1.open &&
      candleOpen >= prev1.close &&
      candleClose < prev1.open &&
      isRedCandle;
    const dhrStrongBearishClose = isRedCandle && candleBody > totalRange * 0.5;
    const dhrRejectionCandle =
      dhrLongUpperWick ||
      dhrBearishEngulfing ||
      dhrStrongBearishClose ||
      isDoji;

    const nearAnyDayHighResistance =
      nearDayHighZone || nearYesterdayHigh || nearPrevDayClose;

    const emaNotSupportAtEntry =
      emaForDHR == null ||
      emaForDHR >= candleClose ||
      candleClose - emaForDHR >= marginPoints;

    // ── New engine helpers ─────────────────────────────────────────────────────
    const emaFakeBreakAbove =
      candleEMA != null &&
      candleHigh > (candleEMA as number) &&
      candleClose < (candleEMA as number);
    const emaFakeBreakRejection =
      nearEMA &&
      emaFakeBreakAbove &&
      !emaActsAsSupport &&
      emaBearishStructure &&
      (isRedCandle || upperWick > candleBody);

    const firstCandleLowBrokenEarlier =
      firstCandleLow > 0 &&
      i > 1 &&
      candles.slice(1, i).some((c: any) => c.close < firstCandleLow);
    const nearBrokenFirstCandleLow =
      firstCandleLow > 0 &&
      Math.abs(candleHigh - firstCandleLow) <= marginPoints;
    const failedRetestOfFirstCandleLow =
      firstCandleLow > 0 &&
      candleHigh >= firstCandleLow - marginPoints * 0.5 &&
      candleClose < firstCandleLow;
    const brokenFirstCandleLowRetest =
      firstCandleLowBrokenEarlier &&
      nearBrokenFirstCandleLow &&
      failedRetestOfFirstCandleLow &&
      isRedCandle &&
      (upperWick > candleBody * 1.2 || candleBody > totalRange * 0.4);

    const lowerHighsForming =
      i >= 3 &&
      candles[i - 1].high < candles[i - 2].high &&
      candles[i - 2].high < candles[i - 3].high;
    const lowerHighBreakdown =
      lowerHighsForming &&
      isRedCandle &&
      nearEMA &&
      emaBearishStructure &&
      candleEMA != null &&
      candleClose < (candleEMA as number);

    // ── Shared rejection pattern label ─────────────────────────────────────
    const rejPatternLabel =
      dhrBearishEngulfing || isBearishEngulfing
        ? 'Bearish Engulfing'
        : isShootingStar
          ? 'Shooting Star'
          : hasStrongRejection || dhrStrongBearishClose
            ? 'Strong Bearish'
            : dhrLongUpperWick || earlyRejection
              ? 'Long Upper Wick'
              : weakCloseAtResistance
                ? 'Weak Close'
                : momentumSlowing
                  ? 'Momentum Slowing'
                  : isDoji
                    ? 'Doji'
                    : 'Rejection';

    const anyP1RejectionCandle =
      dhrRejectionCandle ||
      weakCloseAtResistance ||
      earlyRejection ||
      isShootingStar ||
      isBearishEngulfing ||
      hasStrongRejection ||
      momentumSlowing;

    // ══════════════════════════════════════════════════════════════════════
    // Signal engine evaluation (first valid pattern wins — if/else-if)
    // ══════════════════════════════════════════════════════════════════════
    let isDayHighZoneRejection = false;
    let signalReason = '';
    let useRetestSL = false;

    // ── PRIORITY 1: Key Resistance Rejection Family ───────────────────────
    if (
      nearDayHighZone &&
      (isRedCandle || isDoji || isGreenShootingStar) &&
      anyP1RejectionCandle &&
      emaFarBelowZone &&
      emaNotSupportAtEntry &&
      rsiNotOversold
    ) {
      signalReason = `Day High Rejection (${rejPatternLabel})`;
      isDayHighZoneRejection = true;
    } else if (
      nearYesterdayHigh &&
      (isRedCandle || isDoji || isGreenShootingStar) &&
      anyP1RejectionCandle &&
      emaFarBelowZone &&
      emaNotSupportAtEntry &&
      rsiNotOversold
    ) {
      signalReason = `Yesterday High Rejection (${rejPatternLabel})`;
      isDayHighZoneRejection = true;
    } else if (
      nearPrevDayClose &&
      (isRedCandle || isDoji || isGreenShootingStar) &&
      anyP1RejectionCandle &&
      emaFarBelowZone &&
      emaNotSupportAtEntry &&
      rsiNotOversold
    ) {
      signalReason = `Prev Day Close Rejection (${rejPatternLabel})`;
      isDayHighZoneRejection = true;
    } else if (nearFirstCandleHigh && anyP1RejectionCandle) {
      signalReason = `Opening Range Rejection (${rejPatternLabel})`;
    } else if (nearSwingHigh && anyP1RejectionCandle) {
      signalReason = `Swing High Rejection (${rejPatternLabel})`;
    }
    // ── PRIORITY 2: EMA Rejection Family ──────────────────────────────────
    else if (bearishOpenAtEMA) {
      signalReason = 'EMA Rejection';
    } else if (emaFakeBreakRejection) {
      signalReason = 'EMA Fake Break Rejection';
    }
    // ── PRIORITY 3: Broken Support Retest Family ───────────────────────────
    else if (brokenFirstCandleLowRetest) {
      signalReason = 'Broken First Candle Low Retest Rejection';
      useRetestSL = true;
    }
    // ── PRIORITY 4: Lower High Breakdown ──────────────────────────────────
    else if (lowerHighBreakdown) {
      signalReason = 'Lower High Breakdown';
    }
    // ── Fallback: general EMA-proximity resistance patterns ───────────────
    else if (weakCloseAtResistance && resistanceTests >= 2)
      signalReason = `Weak Close @ Resistance (${resistanceTests} tests)`;
    else if (earlyRejection) signalReason = 'Early Rejection @ Resistance';
    else if (momentumSlowing) signalReason = 'Momentum Slowing @ Resistance';
    else if (isShootingStar) signalReason = 'Shooting Star @ Resistance';
    else if (isBearishEngulfing)
      signalReason = 'Bearish Engulfing @ Resistance';
    else if (hasStrongRejection) signalReason = 'Strong Rejection @ Resistance';

    if (!signalReason) {
      diagLog('v1', '[V1-SKIP]', {
        instrument: instrumentName,
        candleTime: candleDate.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
        candleClose,
        candleEMA,
        nearDayHighZone,
        nearYesterdayHigh,
        nearPrevDayClose,
        nearFirstCandleHigh,
        nearSwingHigh,
        nearEMA,
        anyP1RejectionCandle,
        bearishOpenAtEMA,
        emaFakeBreakRejection,
        brokenFirstCandleLowRetest,
        lowerHighBreakdown,
        dhrRejectionCandle,
        emaFarBelowZone,
        emaNotSupportAtEntry,
        rsiNotOversold,
      });
      continue;
    }

    const candleRSI = rsiValues[i];
    if (
      actualClose > candles[0].high &&
      !(candleRSI != null && candleRSI > 60) &&
      !emaTouchRejection
    )
      continue;

    if (
      !isDayHighZoneRejection &&
      !bearishOpenAtEMA &&
      candleRSI != null &&
      candleRSI < minSellRsi
    )
      continue;

    const MIN_RISK_PTS = 8;
    const FALLBACK_SL_PTS = 30;
    const SL_LOOKBACK = 10;

    const candidateSwings = swingHighs.filter(
      (s) =>
        s.index < actualCandleIndex &&
        s.index >= actualCandleIndex - SL_LOOKBACK &&
        s.price > actualClose &&
        s.price < actualClose + FALLBACK_SL_PTS &&
        s.price + 2 - actualClose >= MIN_RISK_PTS,
    );

    let stopLoss: number;
    let risk: number;

    if (useRetestSL) {
      stopLoss = Math.max(candleHigh, firstCandleLow) + 2;
      risk = stopLoss - actualClose;
    } else if (candidateSwings.length > 0) {
      const nearestSwing = candidateSwings.reduce((a, b) =>
        a.index > b.index ? a : b,
      );
      stopLoss = nearestSwing.price + 2;
      risk = stopLoss - actualClose;
    } else {
      stopLoss = actualClose + FALLBACK_SL_PTS;
      risk = FALLBACK_SL_PTS;
    }
    if (risk > (isDayHighZoneRejection ? 40 : maxSellRiskPts)) continue;

    if (superTrendData) {
      const st = superTrendData[i];
      if (
        st &&
        st.trend === 'up' &&
        !isDayHighZoneRejection &&
        !bearishOpenAtEMA
      )
        continue;
    }

    if (!bearishOpenAtEMA) {
      if (
        candleEMA != null &&
        candleEMA < actualClose &&
        actualClose - candleEMA < risk
      )
        continue;
    }

    const candleTime = candleDate.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    results.push({
      candleIndex: i,
      actualCandleIndex,
      candleTime,
      candleDate,
      unixTimestamp,
      reason: signalReason,
      entryPrice: actualClose,
      stopLoss,
      risk,
      candleRSI,
      isDayHighZoneRejection,
      nearDayHighZone,
      isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
    });
  }

  return results;
}

/**
 * Day Selling V3 Strategy — Standalone
 *
 * DAY_SELLING_V3 — 4-Engine sell signal detection.
 * Engines: First Candle Breakdown | Resistance Rejection | EMA Rejection | Lower High Breakdown
 * Completely independent from V1 and V2.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import { diagLog } from './diag-log';
import type { DaySellSignal } from './day-selling-v1.strategy';

export function detectDaySellSignalsV3(params: {
  candles: any[];
  emaValues: (number | null)[];
  rsiValues: (number | null)[];
  swingHighs: Array<{ price: number; index: number }>;
  yesterdayHigh: number;
  prevDayLow?: number;
  prevDayClose?: number;
  marginPoints: number;
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
    maxSellRiskPts = 35,
    realtimeMode = false,
    superTrendData,
  } = params;

  const results: DaySellSignal[] = [];
  const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

  const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
  const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;

  let rollingHigh = 0;
  for (let pi = 0; pi < scanStartIndex; pi++) {
    if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
  }

  let firstCandleLowBreakCount = 0;
  const maxBreakdownAttempts = 3;

  let lastSignalIndex = -999;
  let lastSignalPrice = 0;

  const zoneMargin = marginPoints;

  const usedZones = {
    intradayHigh: false,
    prevDayHigh: false,
    prevDayClose: false,
    firstCandleHigh: false,
  };
  const usedSwingHighLevels = new Set<number>();

  const isSwingBroken = (
    sh: { price: number; index: number },
    upToIndex: number,
  ): boolean => {
    const breakBuffer = zoneMargin * 0.5;
    for (let k = sh.index + 1; k < upToIndex; k++) {
      if (candles[k].close > sh.price + breakBuffer) return true;
    }
    return false;
  };

  const isSwingRelevant = (
    sh: { price: number; index: number },
    currentIndex: number,
  ): boolean => {
    const maxBarsAge = 40;
    if (currentIndex - sh.index > maxBarsAge) return false;
    const leftOk = sh.index >= 1 && candles[sh.index - 1].high < sh.price;
    const rightOk =
      sh.index + 1 < currentIndex && candles[sh.index + 1].high < sh.price;
    return leftOk && rightOk;
  };

  const findMatchedSwingHigh = (
    candleHighValue: number,
    currentIndex: number,
  ): { price: number; index: number } | null => {
    const minBarsAfterSwing = 3;
    const swingZoneMargin = zoneMargin * 0.75;
    const candidates = swingHighs
      .filter((sh) => sh.index < currentIndex - minBarsAfterSwing)
      .filter((sh) => isSwingRelevant(sh, currentIndex))
      .filter((sh) => Math.abs(candleHighValue - sh.price) <= swingZoneMargin)
      .filter((sh) => !isSwingBroken(sh, currentIndex));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) =>
      b.index !== a.index ? b.index - a.index : b.price - a.price,
    );
    return candidates[0];
  };

  for (let i = scanStartIndex; i < candles.length; i++) {
    const candle = candles[i];
    const candleEMA = emaValues[i];
    if (!candleEMA) continue;

    const prevRollingHigh = rollingHigh;
    const intradayDayHigh = prevRollingHigh;

    const candleHigh = candle.high;
    const candleLow = candle.low;
    const candleOpen = candle.open;
    const candleClose = candle.close;
    const candleBody = Math.abs(candleClose - candleOpen);
    const upperWick = candleHigh - Math.max(candleOpen, candleClose);
    const totalRange = candleHigh - candleLow;
    const isRedCandle = candleClose < candleOpen;
    const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;

    const candleDate =
      candle.date instanceof Date ? candle.date : new Date(candle.date);
    const hrs = candleDate.getHours();
    const mins = candleDate.getMinutes();
    const minsOfDay = hrs * 60 + mins;
    if (minsOfDay < 9 * 60 + 25 || minsOfDay > 14 * 60 + 45) continue;

    const prev1 = i >= 1 ? candles[i - 1] : null;
    const prev2 = i >= 2 ? candles[i - 2] : null;
    const candleRSI = rsiValues[i];

    if (i - lastSignalIndex < 5) continue;

    if (
      lastSignalPrice > 0 &&
      Math.abs(candleHigh - lastSignalPrice) <= zoneMargin
    )
      continue;

    const lookback20 = Math.min(20, i);
    let aboveEMACount = 0;
    for (let k = i - lookback20; k < i; k++) {
      const ke = emaValues[k];
      if (ke != null && candles[k].close > ke) aboveEMACount++;
    }
    const isUptrend = lookback20 > 0 && aboveEMACount / lookback20 > 0.6;

    const stEntry = superTrendData ? superTrendData[i] : null;
    const isSuperTrendUp = stEntry ? stEntry.trend === 'up' : false;

    const strongTrend =
      i >= 6 &&
      emaValues[i] != null &&
      emaValues[i - 3] != null &&
      emaValues[i - 6] != null &&
      (emaValues[i] as number) > (emaValues[i - 3] as number) &&
      (emaValues[i - 3] as number) > (emaValues[i - 6] as number);

    if (strongTrend && candleClose > candleEMA) continue;

    const nearIntradayHigh =
      intradayDayHigh > 0 &&
      Math.abs(candleHigh - intradayDayHigh) <= zoneMargin;
    const nearPrevDayHigh =
      yesterdayHigh > 0 && Math.abs(candleHigh - yesterdayHigh) <= zoneMargin;
    const nearPrevDayClose =
      prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= zoneMargin;
    const nearFirstCandleHigh =
      firstCandleHigh > 0 &&
      i > 3 &&
      Math.abs(candleHigh - firstCandleHigh) <= zoneMargin;
    const matchedSwingHigh = findMatchedSwingHigh(candleHigh, i);
    const nearSwingHigh = !!matchedSwingHigh;
    const nearAnyResistance =
      nearIntradayHigh ||
      nearPrevDayHigh ||
      nearPrevDayClose ||
      nearFirstCandleHigh ||
      nearSwingHigh;

    const makeTs = () => Math.floor(candleDate.getTime() / 1000) + 19800;
    const makeTime = () =>
      candleDate.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

    const strongBullRun =
      i >= 4 &&
      candles[i - 1].close > candles[i - 1].open &&
      candles[i - 2].close > candles[i - 2].open &&
      candles[i - 3].close > candles[i - 3].open &&
      candles[i - 1].high > candles[i - 2].high &&
      candles[i - 2].high > candles[i - 3].high;

    if (strongBullRun && candleClose > candleEMA) continue;

    const emaDown =
      i >= 3 &&
      emaValues[i] != null &&
      emaValues[i - 1] != null &&
      emaValues[i - 2] != null &&
      emaValues[i - 3] != null &&
      emaValues[i]! < emaValues[i - 1]! &&
      emaValues[i - 1]! <= emaValues[i - 2]! &&
      emaValues[i - 2]! <= emaValues[i - 3]!;

    const emaUp =
      i >= 3 &&
      emaValues[i] != null &&
      emaValues[i - 1] != null &&
      emaValues[i - 2] != null &&
      emaValues[i - 3] != null &&
      emaValues[i]! > emaValues[i - 1]! &&
      emaValues[i - 1]! >= emaValues[i - 2]! &&
      emaValues[i - 2]! >= emaValues[i - 3]!;

    const lbRegime = Math.min(12, i);
    let aboveCount = 0;
    let belowCountRegime = 0;
    for (let k = i - lbRegime; k < i; k++) {
      const ke = emaValues[k];
      if (ke != null) {
        if (candles[k].close > ke) aboveCount++;
        if (candles[k].close < ke) belowCountRegime++;
      }
    }
    const priceMostlyAboveEMA = lbRegime > 0 && aboveCount / lbRegime >= 0.6;
    const priceMostlyBelowEMA =
      lbRegime > 0 && belowCountRegime / lbRegime >= 0.6;
    const bullishRegime = emaUp && priceMostlyAboveEMA;
    const bearishRegime = emaDown && priceMostlyBelowEMA;

    diagLog('v3', '[V3-REGIME-DIAG]', {
      instrument: params.instrumentName ?? 'unknown',
      candleTime: makeTime(),
      candleClose,
      candleEMA,
      emaNow: emaValues[i],
      emaPrev1: emaValues[i - 1],
      emaPrev2: emaValues[i - 2],
      emaPrev3: emaValues[i - 3],
      emaUp,
      emaDown,
      priceMostlyAboveEMA,
      priceMostlyBelowEMA,
      bullishRegime,
      bearishRegime,
      isUptrend,
      strongTrend,
      strongBullRun,
    });

    let bestSignal: DaySellSignal | null = null;
    let signalZoneRef = candleHigh;

    const rejUpperWick =
      upperWick > candleBody * 1.5 || upperWick > totalRange * 0.4;
    const rejBearishEngulf =
      !!prev1 &&
      prev1.close > prev1.open &&
      candleOpen >= prev1.close &&
      candleClose < prev1.open &&
      isRedCandle;
    const rejShootingStar =
      upperWick > totalRange * 0.5 &&
      upperWick > candleBody * 2 &&
      candleLow > candleOpen - totalRange * 0.1;
    const rejStrongBearish = isRedCandle && candleBody > totalRange * 0.5;
    const candleRejection =
      rejUpperWick ||
      rejBearishEngulf ||
      rejShootingStar ||
      rejStrongBearish ||
      isDoji;
    const lowerHighForming = !!prev1 && !!prev2 && prev1.high < prev2.high;
    const weakCloseFromHigh =
      totalRange > 0 && (candleHigh - candleClose) / totalRange >= 0.4;
    const noRecentBullRun = !(
      i >= 3 &&
      candles[i - 1].close > candles[i - 1].open &&
      candles[i - 2].close > candles[i - 2].open &&
      candles[i - 3].close > candles[i - 3].open
    );
    const inBullishContext = isUptrend || bullishRegime;
    const dhrBearishContext = bearishRegime || (emaDown && lowerHighForming);
    const candlePattern = rejBearishEngulf
      ? 'Bearish Engulfing'
      : rejShootingStar
        ? 'Shooting Star'
        : rejUpperWick
          ? 'Long Upper Wick'
          : rejStrongBearish
            ? 'Strong Bearish'
            : 'Doji';

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 1a: Intraday High Rejection
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      nearIntradayHigh &&
      !usedZones.intradayHigh &&
      candleRejection &&
      weakCloseFromHigh &&
      !inBullishContext &&
      dhrBearishContext
    ) {
      const sl = candleHigh + 2;
      const risk = sl - candleClose;
      if (risk > 0 && risk <= maxSellRiskPts) {
        let score = 4;
        if (nearPrevDayHigh) score += 1;
        if (lowerHighForming) score += 2;
        if (candleRSI != null && candleRSI > 50) score += 1;
        if (score >= 4) {
          signalZoneRef = intradayDayHigh;
          bestSignal = {
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: makeTime(),
            candleDate,
            unixTimestamp: makeTs(),
            reason: `V3: Day High Rejection (${candlePattern} @ intraday high ${intradayDayHigh.toFixed(0)})`,
            entryPrice: candleClose,
            stopLoss: sl,
            risk,
            candleRSI,
            isDayHighZoneRejection: true,
            nearDayHighZone: true,
            isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
          };
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 1b: Prev Day High Rejection
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      nearPrevDayHigh &&
      !usedZones.prevDayHigh &&
      candleRejection &&
      weakCloseFromHigh &&
      !inBullishContext &&
      dhrBearishContext
    ) {
      const sl = candleHigh + 2;
      const risk = sl - candleClose;
      if (risk > 0 && risk <= maxSellRiskPts) {
        let score = 4;
        if (lowerHighForming) score += 2;
        if (candleRSI != null && candleRSI > 50) score += 1;
        if (score >= 4) {
          signalZoneRef = yesterdayHigh;
          bestSignal = {
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: makeTime(),
            candleDate,
            unixTimestamp: makeTs(),
            reason: `V3: Prev Day High Rejection (${candlePattern} @ prev day high ${yesterdayHigh.toFixed(0)})`,
            entryPrice: candleClose,
            stopLoss: sl,
            risk,
            candleRSI,
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
          };
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 1c: Prev Day Close Rejection
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      nearPrevDayClose &&
      !usedZones.prevDayClose &&
      candleRejection &&
      !inBullishContext
    ) {
      const pdcBearishContext = bearishRegime || emaDown || lowerHighForming;
      if (pdcBearishContext) {
        const sl = candleHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 2;
          if (lowerHighForming) score += 2;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (rejUpperWick || rejBearishEngulf) score += 1;
          if (weakCloseFromHigh) score += 1;
          if (score >= 4) {
            signalZoneRef = prevDayClose;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Prev Day Close Rejection (${candlePattern} @ prev day close ${prevDayClose.toFixed(0)})`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh:
                Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 1d: First Candle High Rejection
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      nearFirstCandleHigh &&
      !usedZones.firstCandleHigh &&
      candleRejection &&
      !inBullishContext
    ) {
      const fchBearishContext = bearishRegime || emaDown || lowerHighForming;
      if (fchBearishContext) {
        const sl = candleHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 2;
          if (lowerHighForming) score += 2;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (rejUpperWick || rejBearishEngulf) score += 1;
          if (weakCloseFromHigh) score += 1;
          if (score >= 4) {
            signalZoneRef = firstCandleHigh;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Opening Range Rejection (${candlePattern} @ 1st candle high ${firstCandleHigh.toFixed(0)})`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh:
                Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 1e: Swing High Rejection
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      nearSwingHigh &&
      matchedSwingHigh != null &&
      !usedSwingHighLevels.has(matchedSwingHigh.price) &&
      candleRejection &&
      !inBullishContext &&
      dhrBearishContext
    ) {
      const sl = candleHigh + 2;
      const risk = sl - candleClose;
      if (risk > 0 && risk <= maxSellRiskPts) {
        let score = 2;
        if (lowerHighForming) score += 2;
        if (candleRSI != null && candleRSI > 50) score += 1;
        if (rejUpperWick || rejBearishEngulf) score += 1;
        if (weakCloseFromHigh) score += 1;
        if (score >= 4) {
          signalZoneRef = matchedSwingHigh.price;
          bestSignal = {
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: makeTime(),
            candleDate,
            unixTimestamp: makeTs(),
            reason: `V3: Swing High Rejection (${candlePattern} @ swing high ${matchedSwingHigh.price.toFixed(0)})`,
            entryPrice: candleClose,
            stopLoss: sl,
            risk,
            candleRSI,
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
          };
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 2: EMA Rejection
    // ════════════════════════════════════════════════════════════════════
    if (!bestSignal) {
      const nearEMA = Math.abs(candleHigh - candleEMA) <= zoneMargin;
      const emaTouchRejection =
        nearEMA &&
        isRedCandle &&
        candleHigh >= candleEMA - zoneMargin * 0.5 &&
        candleClose < candleEMA;

      if (emaTouchRejection && (candleRSI == null || candleRSI >= 40)) {
        const lb6 = Math.min(6, i);
        let belowCount = 0;
        for (let k = i - lb6; k < i; k++) {
          const ke = emaValues[k];
          if (ke != null && candles[k].close < ke) belowCount++;
        }
        const emaSlopingDown =
          i >= 3 &&
          emaValues[i] != null &&
          emaValues[i - 3] != null &&
          (emaValues[i] as number) < (emaValues[i - 3] as number);

        let emaBounces = 0;
        const lbSupp = Math.min(10, i - 1);
        for (let k = Math.max(0, i - lbSupp); k < i; k++) {
          const ke = emaValues[k];
          if (ke == null) continue;
          if (
            Math.abs(candles[k].low - ke) <= zoneMargin ||
            Math.abs(candles[k].close - ke) <= zoneMargin
          ) {
            const nk = k + 1 < candles.length ? candles[k + 1] : null;
            if (nk && nk.close > nk.open) emaBounces++;
          }
        }

        const bodyOk = candleBody >= totalRange * 0.3;

        if (nearEMA) {
          const score =
            1 +
            (lowerHighForming ? 2 : 0) +
            (candleRSI != null && candleRSI > 50 ? 1 : 0) +
            (nearAnyResistance ? 2 : 0);
          diagLog('v3', '[V3-EMA-DIAG]', {
            instrument: params.instrumentName ?? 'unknown',
            candleTime: makeTime(),
            candleHigh,
            candleClose,
            candleEMA,
            nearEMA,
            isRedCandle,
            closeBelowEMA: candleClose < candleEMA,
            candleRSI,
            candleBody: +candleBody.toFixed(2),
            totalRange: +totalRange.toFixed(2),
            bodyOk,
            lowerHighForming,
            noRecentBullRun,
            belowCount,
            emaSlopingDown,
            emaBounces,
            isUptrend,
            nearAnyResistance,
            score,
            passed:
              bodyOk &&
              lowerHighForming &&
              noRecentBullRun &&
              (bearishRegime || emaSlopingDown) &&
              belowCount >= 2 &&
              emaBounces < 2 &&
              score >= 3,
            failReasons: [
              !bodyOk && 'bodyOk=false',
              !lowerHighForming && 'lowerHighForming=false',
              !noRecentBullRun && 'noRecentBullRun=false',
              !(bearishRegime || emaSlopingDown) &&
                'bearishRegime=false AND !emaSlopingDown',
              belowCount < 2 && `belowCount=${belowCount}<2`,
              emaBounces >= 2 && `emaBounces=${emaBounces}>=2`,
              score < 3 && `score=${score}<3`,
            ].filter(Boolean),
          });
        }

        if (
          !bullishRegime &&
          (bearishRegime || emaSlopingDown) &&
          candleBody >= totalRange * 0.3 &&
          lowerHighForming &&
          noRecentBullRun &&
          belowCount >= 2 &&
          emaBounces < 2
        ) {
          const sl = candleHigh + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            let score = 0;
            score += 1;
            if (lowerHighForming) score += 2;
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (nearAnyResistance) score += 2;
            if (score >= 3) {
              const pattern =
                !!prev1 &&
                prev1.close > prev1.open &&
                candleOpen >= prev1.close &&
                candleClose < prev1.open
                  ? 'Bearish Engulfing'
                  : upperWick > candleBody * 2 && upperWick > totalRange * 0.5
                    ? 'Shooting Star'
                    : upperWick > candleBody * 1.2
                      ? 'Upper Wick'
                      : 'Strong Bearish';
              signalZoneRef = candleEMA;
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: EMA Rejection (${pattern})`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh:
                  Math.abs(rollingHigh - candleHigh) <= zoneMargin,
              };
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 2b: EMA Fake Break Rejection
    // ════════════════════════════════════════════════════════════════════
    if (!bestSignal) {
      const fakeBreakAboveEMA =
        candleHigh > candleEMA && candleClose < candleEMA;

      if (fakeBreakAboveEMA) {
        const lb6fb = Math.min(6, i);
        let belowCountFb = 0;
        for (let k = i - lb6fb; k < i; k++) {
          const ke = emaValues[k];
          if (ke != null && candles[k].close < ke) belowCountFb++;
        }

        const emaSlopingDownFb =
          i >= 3 &&
          emaValues[i] != null &&
          emaValues[i - 3] != null &&
          (emaValues[i] as number) < (emaValues[i - 3] as number);

        const wickAboveEMA = candleHigh - candleEMA;
        const rejectionWick =
          wickAboveEMA > 0 &&
          (upperWick > candleBody * 1.2 || upperWick > totalRange * 0.35);

        let emaBouncesFb = 0;
        const lbSuppFb = Math.min(10, i - 1);
        for (let k = Math.max(0, i - lbSuppFb); k < i; k++) {
          const ke = emaValues[k];
          if (ke == null) continue;
          if (
            Math.abs(candles[k].low - ke) <= zoneMargin ||
            Math.abs(candles[k].close - ke) <= zoneMargin
          ) {
            const nk = k + 1 < candles.length ? candles[k + 1] : null;
            if (nk && nk.close > nk.open) emaBouncesFb++;
          }
        }

        if (
          !bullishRegime &&
          (bearishRegime || emaSlopingDownFb) &&
          rejectionWick &&
          lowerHighForming &&
          noRecentBullRun &&
          belowCountFb >= 2 &&
          emaBouncesFb < 2 &&
          (candleRSI == null || candleRSI >= 35)
        ) {
          const sl = candleHigh + 2;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            let score = 0;
            score += 2;
            if (emaSlopingDownFb) score += 1;
            if (belowCountFb >= 3) score += 1;
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (nearAnyResistance) score += 1;
            if (lowerHighForming) score += 1;
            if (score >= 3) {
              const pattern = isRedCandle
                ? !!prev1 &&
                  prev1.close > prev1.open &&
                  candleOpen >= prev1.close &&
                  candleClose < prev1.open
                  ? 'Bearish Engulfing'
                  : 'Bearish Fake Break'
                : 'Bullish Fake Break (Green)';
              signalZoneRef = candleEMA;
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: EMA Fake Break Rejection (${pattern})`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh:
                  Math.abs(rollingHigh - candleHigh) <= zoneMargin,
              };
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 4: Broken First Candle Low Retest Rejection
    // ════════════════════════════════════════════════════════════════════
    if (!bestSignal && firstCandleLow > 0) {
      const firstCandleLowBrokenEarlier =
        i > 1 && candles.slice(1, i).some((c) => c.close < firstCandleLow);

      const nearBrokenFirstCandleLow =
        Math.abs(candleHigh - firstCandleLow) <= zoneMargin;

      const failedRetestOfFirstCandleLow =
        candleHigh >= firstCandleLow - zoneMargin * 0.5 &&
        candleClose < firstCandleLow;

      const retestRejection =
        isRedCandle &&
        (upperWick > candleBody * 1.2 || candleBody > totalRange * 0.4);

      const lowerHighFormingP4 =
        !!prev1 && !!prev2 && prev1.high < prev2.high;

      const bearishRetestContext =
        bearishRegime || emaDown || lowerHighFormingP4;

      if (
        firstCandleLowBrokenEarlier &&
        nearBrokenFirstCandleLow &&
        failedRetestOfFirstCandleLow &&
        retestRejection &&
        bearishRetestContext
      ) {
        const sl = Math.max(candleHigh, firstCandleLow) + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          signalZoneRef = firstCandleLow;
          bestSignal = {
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: makeTime(),
            candleDate,
            unixTimestamp: makeTs(),
            reason: `V3: Broken First Candle Low Retest Rejection`,
            entryPrice: candleClose,
            stopLoss: sl,
            risk,
            candleRSI,
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: Math.abs(rollingHigh - candleHigh) <= zoneMargin,
          };
        }
      }
    }

    // ── Early-skip block ─────────────────────────────────────────────────
    if (isUptrend || isSuperTrendUp) {
      if (bestSignal) results.push(bestSignal);
      continue;
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 3: Lower High Breakdown
    // ════════════════════════════════════════════════════════════════════
    if (!bestSignal && !!prev1 && !!prev2) {
      const lowerHighPattern =
        candle.high < prev1.high && prev1.high < prev2.high;
      const rejectEMA =
        Math.abs(candle.high - candleEMA) <= zoneMargin * 1.5 &&
        candleClose < candleEMA;

      if (
        !bullishRegime &&
        bearishRegime &&
        lowerHighPattern &&
        isRedCandle &&
        rejectEMA &&
        (candleRSI == null || candleRSI >= 40)
      ) {
        const pullbackHigh = Math.max(prev1.high, candle.high);
        const sl = pullbackHigh + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          let score = 0;
          score += 2;
          score += 1;
          if (candleRSI != null && candleRSI > 50) score += 1;
          if (nearAnyResistance) score += 2;
          if (score >= 3) {
            signalZoneRef = pullbackHigh;
            bestSignal = {
              candleIndex: i,
              actualCandleIndex: i,
              candleTime: makeTime(),
              candleDate,
              unixTimestamp: makeTs(),
              reason: `V3: Lower High Breakdown`,
              entryPrice: candleClose,
              stopLoss: sl,
              risk,
              candleRSI,
              isDayHighZoneRejection: false,
              nearDayHighZone: false,
              isNearDailyHigh:
                Math.abs(rollingHigh - candleHigh) <= zoneMargin,
            };
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITY 5: First Candle Breakdown (up to 3 attempts)
    // ════════════════════════════════════════════════════════════════════
    if (
      !bestSignal &&
      firstCandleLow > 0 &&
      firstCandleLowBreakCount < maxBreakdownAttempts &&
      isRedCandle &&
      candleClose < firstCandleLow
    ) {
      firstCandleLowBreakCount++;

      const brkLargeBearishBody = candleBody > totalRange * 0.4;
      const brkBearishEngulf =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open;
      const brkStrongCloseNearLow =
        totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2;
      const brkValidCandle =
        brkLargeBearishBody || brkBearishEngulf || brkStrongCloseNearLow;

      if (
        brkValidCandle &&
        (candleEMA == null || candleEMA >= candleClose) &&
        (candleRSI == null || candleRSI >= 40)
      ) {
        const sl = Math.max(candleHigh, firstCandleLow) + 2;
        const risk = sl - candleClose;
        if (risk > 0 && risk <= maxSellRiskPts) {
          const emaSupport =
            candleEMA != null &&
            candleEMA < candleClose &&
            candleClose - candleEMA < risk;
          const prevDayLowSupport =
            prevDayLow > 0 &&
            prevDayLow < candleClose &&
            candleClose - prevDayLow < risk;
          let intradaySupport = false;
          for (let k = 1; k < i; k++) {
            if (
              candles[k].low < candleClose &&
              candleClose - candles[k].low < risk
            ) {
              intradaySupport = true;
              break;
            }
          }

          if (!emaSupport && !prevDayLowSupport && !intradaySupport) {
            let score = 0;
            if (nearAnyResistance) score += 2;
            if (candleRSI != null && candleRSI > 50) score += 1;
            if (brkBearishEngulf) score += 2;
            else if (brkLargeBearishBody) score += 1;
            if (score >= 3) {
              const brkPattern = brkBearishEngulf
                ? 'Bearish Engulfing'
                : brkStrongCloseNearLow
                  ? 'Strong Close Near Low'
                  : 'Large Bearish Body';
              bestSignal = {
                candleIndex: i,
                actualCandleIndex: i,
                candleTime: makeTime(),
                candleDate,
                unixTimestamp: makeTs(),
                reason: `V3: 1st Candle Low Break (${brkPattern}, attempt ${firstCandleLowBreakCount})`,
                entryPrice: candleClose,
                stopLoss: sl,
                risk,
                candleRSI,
                isDayHighZoneRejection: false,
                nearDayHighZone: false,
                isNearDailyHigh: false,
              };
            }
          }
        }
      }
    }

    if (bestSignal) {
      results.push(bestSignal);
      lastSignalIndex = i;
      lastSignalPrice = signalZoneRef;
      if (nearIntradayHigh) usedZones.intradayHigh = true;
      if (nearPrevDayHigh) usedZones.prevDayHigh = true;
      if (nearPrevDayClose) usedZones.prevDayClose = true;
      if (nearFirstCandleHigh) usedZones.firstCandleHigh = true;
      if (nearSwingHigh && matchedSwingHigh) {
        usedSwingHighLevels.add(matchedSwingHigh.price);
      }
    }

    if (candle.high > rollingHigh) rollingHigh = candle.high;
  }

  return results;
}

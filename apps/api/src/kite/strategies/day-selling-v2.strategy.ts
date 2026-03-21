/**
 * Day Selling V2 Strategy — Standalone
 *
 * DAY_SELLING_V2 signal detection engine.
 * Three independent setups:
 *   1. Day High Zone Rejection — resistance zone + 20 EMA distance rule
 *   2. Day First Candle Low Break — breakdown below opening candle low
 *   3. 20 EMA Rejection — retrace-to-EMA in confirmed downtrend
 * Completely independent from V1. Do NOT modify V1.
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import { diagLog } from './diag-log';
import type { DaySellSignal } from './day-selling-v1.strategy';

export function detectDaySellSignalsV2(params: {
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
    maxSellRiskPts = 30,
    realtimeMode = false,
    superTrendData,
  } = params;

  const results: DaySellSignal[] = [];

  diagLog('v2', '[V2-CALL]', {
    instrument: params.instrumentName ?? '',
    candleCount: candles.length,
    realtimeMode,
    yesterdayHigh,
  });

  const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

  // ── Rolling session high tracker ──────────────────────────────────────
  let rollingHigh = 0;
  let intradayDayHigh = 0;

  // ── First candle (9:15) data ──────────────────────────────────────────
  const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
  const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;

  const firstCandleLowBreakLevel =
    prevDayLow > 0 &&
    firstCandleLow > 0 &&
    Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
      ? Math.min(firstCandleLow, prevDayLow) - 1
      : firstCandleLow;

  let firstCandleLowBreakFired = false;
  for (let pi = 1; pi < scanStartIndex; pi++) {
    if (candles[pi]?.close < firstCandleLowBreakLevel) {
      firstCandleLowBreakFired = true;
      break;
    }
  }

  for (let pi = 0; pi < scanStartIndex; pi++) {
    if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
  }

  for (let i = scanStartIndex; i < candles.length; i++) {
    const candle = candles[i];
    const candleEMA = emaValues[i];

    if (candle.high > rollingHigh) rollingHigh = candle.high;
    intradayDayHigh = rollingHigh;

    if (!candleEMA) continue;

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

    const candleDate =
      candle.date instanceof Date ? candle.date : new Date(candle.date);
    const hrs = candleDate.getHours();
    const mins = candleDate.getMinutes();
    const minsOfDay = hrs * 60 + mins;
    if (minsOfDay < 9 * 60 + 30 || minsOfDay > 14 * 60 + 30) continue;

    diagLog('v2', '[V2-CANDLE]', {
      instrument: params.instrumentName ?? '',
      candleTime: candleDate.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }),
      candleClose,
      candleEMA,
      intradayDayHigh,
      firstCandleLowBreakFired,
      nearFCLow:
        candleClose < firstCandleLowBreakLevel && !firstCandleLowBreakFired,
      isRedCandle,
      candleBody: +candleBody.toFixed(2),
      upperWick: +upperWick.toFixed(2),
      totalRange: +totalRange.toFixed(2),
    });

    const prev1 = i >= 1 ? candles[i - 1] : null;
    const prev2 = i >= 2 ? candles[i - 2] : null;
    const prev3 = i >= 3 ? candles[i - 3] : null;
    const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
    const nextCandle = i + 1 < candles.length ? candles[i + 1] : null;
    const nextIsRed = nextCandle ? nextCandle.close < nextCandle.open : false;

    // ══════════════════════════════════════════════════════════════════════
    // SETUP 2: Day First Candle Low Break
    // ══════════════════════════════════════════════════════════════════════
    if (
      !firstCandleLowBreakFired &&
      firstCandleLow > 0 &&
      isRedCandle &&
      candleClose < firstCandleLowBreakLevel
    ) {
      const brkLargeBearishBody = candleBody > totalRange * 0.4;
      const brkBearishEngulfing =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open;
      const brkStrongCloseNearLow =
        totalRange > 0 && (candleClose - candleLow) / totalRange < 0.2;
      const brkValidCandle =
        brkLargeBearishBody || brkBearishEngulfing || brkStrongCloseNearLow;

      if (!brkValidCandle) {
        continue;
      }
      if (candleEMA != null && candleEMA < candleClose) {
        firstCandleLowBreakFired = true;
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
          if (
            candles[k].low < candleClose &&
            candleClose - candles[k].low < breakRisk
          ) {
            brkIntradaySupport = true;
            break;
          }
        }

        if (!brkEMASupport && !brkPrevDayLowSupport && !brkIntradaySupport) {
          const brkPattern = brkBearishEngulfing
            ? 'Bearish Engulfing'
            : brkStrongCloseNearLow
              ? 'Strong Close Near Low'
              : 'Large Bearish Body';
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
            reason: `V2: 1st Candle Low Break (${brkPattern})`,
            entryPrice: candleClose,
            stopLoss: breakSL,
            risk: breakRisk,
            candleRSI: rsiValues[i],
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: false,
          });
        }
      }
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // SETUP 1: Day High Zone Rejection
    // ══════════════════════════════════════════════════════════════════════
    const nearIntradayHigh =
      intradayDayHigh > 0 &&
      Math.abs(candleHigh - intradayDayHigh) <= marginPoints * 1.5;
    const nearPrevDayHigh =
      yesterdayHigh > 0 && Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
    const nearPrevDayClose =
      prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= marginPoints;
    const nearFirstCandleHigh =
      firstCandleHigh > 0 &&
      i > 3 &&
      Math.abs(candleHigh - firstCandleHigh) <= marginPoints;

    const nearAnyResistance =
      nearIntradayHigh ||
      nearPrevDayHigh ||
      nearPrevDayClose ||
      nearFirstCandleHigh;

    const dhrUpperWick =
      upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
    const dhrBearishEngulfing =
      !!prev1 &&
      prev1.close > prev1.open &&
      candleOpen >= prev1.close &&
      candleClose < prev1.open &&
      isRedCandle;
    const dhrStrongBearishClose = isRedCandle && candleBody > totalRange * 0.5;
    const dhrRejectionCandle =
      dhrUpperWick || dhrBearishEngulfing || dhrStrongBearishClose || isDoji;

    if (nearAnyResistance && (isRedCandle || isDoji) && dhrRejectionCandle) {
      const dhrSL = candleHigh + 2;
      const dhrRisk = dhrSL - candleClose;

      if (dhrRisk > 0 && dhrRisk <= maxSellRiskPts) {
        const emaDistance = candleEMA != null ? candleClose - candleEMA : 0;
        const emaRuleOk = candleEMA != null && emaDistance >= dhrRisk;

        if (emaRuleOk) {
          const dhrZone = nearIntradayHigh
            ? `intraday high ${intradayDayHigh.toFixed(0)}`
            : nearPrevDayHigh
              ? `prev day high ${yesterdayHigh.toFixed(0)}`
              : nearPrevDayClose
                ? `prev day close ${prevDayClose.toFixed(0)}`
                : `1st candle high ${firstCandleHigh.toFixed(0)}`;
          const dhrPattern = dhrBearishEngulfing
            ? 'Bearish Engulfing'
            : dhrStrongBearishClose
              ? 'Strong Bearish Close'
              : dhrUpperWick
                ? 'Long Upper Wick'
                : 'Doji';
          const dhrUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
          const dhrTime = candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
          results.push({
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: dhrTime,
            candleDate,
            unixTimestamp: dhrUnixTs,
            reason: `V2: Day High Rejection (${dhrPattern} @ ${dhrZone})`,
            entryPrice: candleClose,
            stopLoss: dhrSL,
            risk: dhrRisk,
            candleRSI: rsiValues[i],
            isDayHighZoneRejection: true,
            nearDayHighZone: nearIntradayHigh,
            isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
          });
          continue;
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SETUP 3: 20 EMA Rejection
    // ══════════════════════════════════════════════════════════════════════
    const nearEMA = Math.abs(candleHigh - candleEMA) <= marginPoints;
    const emaTouchRejection =
      nearEMA &&
      isRedCandle &&
      candleHigh >= candleEMA - marginPoints * 0.5 &&
      candleClose < candleEMA;

    if (emaTouchRejection) {
      let belowCount = 0;
      const lookback = Math.min(6, i);
      for (let k = i - lookback; k < i; k++) {
        const ke = emaValues[k];
        if (ke != null && candles[k].close < ke) belowCount++;
      }
      const emaBearishStructure = belowCount >= 3;

      let aboveCount = 0;
      for (let k = i - lookback; k < i; k++) {
        const ke = emaValues[k];
        if (ke != null && candles[k].close > ke) aboveCount++;
      }
      const emaNotFirmlyAbove = aboveCount < 4;

      const emaSlopingDown =
        i >= 3 &&
        emaValues[i] != null &&
        emaValues[i - 3] != null &&
        (emaValues[i] as number) < (emaValues[i - 3] as number);

      let emaBounces = 0;
      const supportLookback = Math.min(10, i - 1);
      for (let k = Math.max(0, i - supportLookback); k < i; k++) {
        const ke = emaValues[k];
        if (ke == null) continue;
        const touched =
          Math.abs(candles[k].low - ke) <= marginPoints ||
          Math.abs(candles[k].close - ke) <= marginPoints;
        if (touched) {
          const nk = k + 1 < candles.length ? candles[k + 1] : null;
          if (nk && nk.close > nk.open) emaBounces++;
        }
      }
      const emaNotSupport = emaBounces < 2;

      if (
        emaBearishStructure &&
        emaNotFirmlyAbove &&
        emaSlopingDown &&
        emaNotSupport
      ) {
        const emaSL = candleHigh + 2;
        const emaRisk = emaSL - candleClose;

        if (emaRisk > 0 && emaRisk <= maxSellRiskPts) {
          const emaUnixTs = Math.floor(candleDate.getTime() / 1000) + 19800;
          const emaTime = candleDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
          const emaPattern =
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
          results.push({
            candleIndex: i,
            actualCandleIndex: i,
            candleTime: emaTime,
            candleDate,
            unixTimestamp: emaUnixTs,
            reason: `V2: 20 EMA Rejection (${emaPattern})`,
            entryPrice: candleClose,
            stopLoss: emaSL,
            risk: emaRisk,
            candleRSI: rsiValues[i],
            isDayHighZoneRejection: false,
            nearDayHighZone: false,
            isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
          });
        }
      }
    }
  }

  return results;
}

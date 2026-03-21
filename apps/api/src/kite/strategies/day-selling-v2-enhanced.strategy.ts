/**
 * Day Selling V2 Enhanced Strategy — Standalone
 *
 * DAY_SELLING_V2_ENHANCED — V2 upgraded with V4-quality filters.
 *
 * Setups:
 *   A. First Candle Low Break
 *   B. Day High Zone Rejection
 *   B2. Sweep / Transition Day High Rejection
 *   C. Multi-candle EMA Rejection
 *   D. Sideways Range Logic (D1/D2/D3)
 *   E. Liquidity Sweep / Failed Breakout Rejection
 *
 * Isolation contract:
 *   - No NestJS decorators, no Prisma, no imports from other modules.
 *   - Pure function: in → out, no side-effects beyond optional debug logs.
 */

import { diagLog } from './diag-log';
import type { DaySellSignal } from './day-selling-v1.strategy';

export function detectDaySellSignalsV2Enhanced(params: {
  candles: any[];
  ema20Values: (number | null)[];
  ema8Values: (number | null)[];
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
    ema20Values,
    ema8Values,
    rsiValues,
    yesterdayHigh,
    prevDayLow = 0,
    prevDayClose = 0,
    marginPoints,
    maxSellRiskPts = 30,
    realtimeMode = false,
  } = params;

  const results: DaySellSignal[] = [];
  if (candles.length < 3) return results;

  // ── Config ────────────────────────────────────────────────────────────────
  const cfg = {
    requireOpenBelow20Ema: true,
    allowDelayedActivation: true,
    delayedActivationLookback: 6,
    delayedActivationBelowCloseCount: 4,
    delayedActivationEmaSlopeThreshold: 0,
    lateBearishActivationEnabled: true,
    lateBearishActivationLookback: 5,
    lateBearishActivationBelowCloses: 3,
    emaResistanceLookback: 6,
    minBelowEmaCloses: 3,
    maxAllowedAboveEmaCloses: 3,
    emaSlopePeriod: 3,
    sidewaysEmaGapPct: 0.004,
    sidewaysLookback: 8,
    sidewaysCrossings: 2,
    firstHourCandles: 12,
    enableFirstHourLowBreakdown: false,
    sweepBufferPts: 2,
    sweepMaxAboveRefPts: 15,
    sweepMaxAboveRefAtrMult: 0.8,
    sweepReturnRequired: true,
    emaRejectionWindow: 3,
    minReversalScore: 4,
    dupSuppressZonePct: 0.0015,
    dupCooldownCandles: 5,
    zoneRearmPct: 0.003,
    zoneRearmCandles: 8,
    candleBodyRatio: 0.55,
    sidewaysBreakdownStrictMode: true,
    sweepDhrMinScore: 4,
    minEmaRejectionScore: 2,
    sidewaysAllowsRangeEdgeSells: true,
    sidewaysRangeEdgeTolMult: 2,
    triggerCandleBodyRatio: 0.32,
    triggerCandleCloseLowPct: 0.45,
    directEntryMinScore: 6,
    sweepDirectMinScore: 5,
    dhrUpperWickRatio: 0.28,
    dhrWeakCloseRatio: 0.52,
    dhrMinBodyRatioForDirect: 0.22,
    dhrIncludeFirstHourHigh: true,
    dhrIncludeSwingHighs: true,
    trendArmedMaxCandles: 4,
    transitionArmedMaxCandles: 6,
    sidewaysArmedMaxCandles: 5,
    neutralArmedMaxCandles: 3,
    b2ArmedExtraCandles: 0,
    cArmedExtraCandles: -1,
    dArmedExtraCandles: 1,
    eArmedExtraCandles: 0,
    armedInvalidateOnCloseAboveHigh: true,
    armedInvalidationBuffer: 1,
    armedInvalidateEmaReclaim: true,
    useAtrBasedStaleDetect: false,
    staleMoveThresholdAtr: 0.12,
    armedSetupTriggerBuffer: 1,
    armedSetupTriggerBufferAtrMult: 0.1,
    reversalSlFixedBuffer: 2,
    reversalSlAtrMult: 0.3,
    armedNearbyZonePct: 0.005,
    armedNearbyWindow: 6,
    armedTriggerNeedConfirm: true,
    b2TrendDirectMinScore: 4,
    b2TransitionDirectMinScore: 6,
    cTrendDirectMinScore: 4,
    cTransitionDirectMinScore: 5,
    cArmMinScore: 3,
    cRearmCooldownCandles: 8,
    cMoveAwayPct: 0.004,
    inheritedBiasEnabled: true,
    prevSessionBearishLookback: 15,
    prevSessionMinBelowEmaRatio: 0.55,
    prevSessionMinScore: 4,
    pullbackMaxAboveEmaPct: 0.006,
    pullbackMaxAtrMove: 1.5,
    setupBAllowInheritedContinuation: true,
    seqConfirmWindowCandles: 3,
    seqConfirmBelowMidpoint: true,
    seqConfirmBelowSetupLow: false,
    seqSetupMinUwickRatio: 0.18,
    seqDuplicateZonePts: 5,
  };

  // ── ATR ───────────────────────────────────────────────────────────────────
  const atrSlice = candles.slice(0, Math.min(10, candles.length));
  const atr =
    atrSlice.reduce((s: number, c: any) => s + (c.high - c.low), 0) /
    atrSlice.length;

  // ── First candle data ─────────────────────────────────────────────────────
  const firstCandle = candles[0];
  const firstCandleLow = firstCandle.low;
  const firstCandleHigh = firstCandle.high;
  const firstCandleLowBreakLevel =
    prevDayLow > 0 &&
    firstCandleLow > 0 &&
    Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
      ? Math.min(firstCandleLow, prevDayLow) - 1
      : firstCandleLow;

  // ── Session activation ────────────────────────────────────────────────────
  const firstEma20 = ema20Values[0];
  let sessionActive = false;
  if (firstEma20 != null) {
    if (!cfg.requireOpenBelow20Ema || firstCandle.open < firstEma20) {
      sessionActive = true;
    }
  }

  // ── First 1-hour range ────────────────────────────────────────────────────
  const fhSlice = candles.slice(
    0,
    Math.min(cfg.firstHourCandles, candles.length),
  );
  const firstHourHigh =
    fhSlice.length > 0 ? Math.max(...fhSlice.map((c: any) => c.high)) : 0;
  const firstHourLow =
    fhSlice.length > 0 ? Math.min(...fhSlice.map((c: any) => c.low)) : 0;

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getCandleTs = (c: any): number =>
    c.date instanceof Date
      ? Math.floor(c.date.getTime() / 1000) + 19800
      : Math.floor(new Date(c.date).getTime() / 1000) + 19800;

  const getCandleTimeStr = (c: any): string => {
    const d = c.date instanceof Date ? c.date : new Date(c.date);
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const isStrongBearish = (c: any): boolean => {
    if (c.close >= c.open) return false;
    const range = c.high - c.low;
    if (range < 0.5) return false;
    return (c.open - c.close) / range >= cfg.candleBodyRatio;
  };

  const isBearishRejection = (c: any): boolean => {
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const uw = c.high - Math.max(c.open, c.close);
    return uw / range >= 0.35 && c.close < c.open;
  };

  // ── Sideways detection ────────────────────────────────────────────────────
  const isSidewaysAt = (i: number): boolean => {
    if (i < cfg.sidewaysLookback) return false;
    const e8Slice = ema8Values.slice(i - cfg.sidewaysLookback, i + 1);
    const e20Slice = ema20Values.slice(i - cfg.sidewaysLookback, i + 1);
    const window = candles.slice(i - cfg.sidewaysLookback, i + 1);
    let narrowCount = 0;
    for (let k = 0; k < e8Slice.length; k++) {
      const e8 = e8Slice[k];
      const e20 = e20Slice[k];
      if (e8 == null || e20 == null) continue;
      const mid = (e8 + e20) / 2;
      if (mid > 0 && Math.abs(e8 - e20) / mid < cfg.sidewaysEmaGapPct)
        narrowCount++;
    }
    const narrowRatio = narrowCount / cfg.sidewaysLookback;
    let crossings = 0;
    for (let k = 1; k < window.length; k++) {
      const pe = e20Slice[k - 1];
      const ce = e20Slice[k];
      if (pe == null || ce == null) continue;
      if (window[k - 1].close > pe !== window[k].close > ce) crossings++;
    }
    return narrowRatio >= 0.6 && crossings >= cfg.sidewaysCrossings;
  };

  // ── Master EMA-resistance filter ──────────────────────────────────────────
  const isBearishEmaContext = (i: number, ema20: number): boolean => {
    const lookback = Math.min(cfg.emaResistanceLookback, i);
    let belowCount = 0;
    let aboveCount = 0;
    for (let k = i - lookback; k < i; k++) {
      const ke = ema20Values[k];
      if (ke == null) continue;
      if (candles[k].close < ke) belowCount++;
      else aboveCount++;
    }
    const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
    return (
      belowCount >= cfg.minBelowEmaCloses &&
      aboveCount < cfg.maxAllowedAboveEmaCloses &&
      (prevEma == null || ema20 <= prevEma)
    );
  };

  // ── Delayed activation ────────────────────────────────────────────────────
  const checkDelayedActivation = (i: number): boolean => {
    if (!cfg.allowDelayedActivation) return false;
    if (i < cfg.delayedActivationLookback) return false;
    const e20 = ema20Values[i];
    if (e20 == null) return false;
    const prevEma = ema20Values[i - cfg.delayedActivationLookback];
    if (
      prevEma != null &&
      e20 - prevEma > cfg.delayedActivationEmaSlopeThreshold
    )
      return false;
    let belowCount = 0;
    for (let k = i - cfg.delayedActivationLookback; k <= i; k++) {
      const ke = ema20Values[k];
      if (ke != null && candles[k].close < ke) belowCount++;
    }
    return belowCount >= cfg.delayedActivationBelowCloseCount;
  };

  // ── Late bearish activation ───────────────────────────────────────────────
  const checkLateBearishActivation = (i: number): boolean => {
    if (!cfg.lateBearishActivationEnabled) return false;
    const e20 = ema20Values[i];
    if (e20 == null) return false;
    const lb = Math.min(cfg.lateBearishActivationLookback, i);
    let belowCount = 0;
    for (let k = i - lb + 1; k <= i; k++) {
      const ke = ema20Values[k];
      if (ke != null && candles[k].close < ke) belowCount++;
    }
    if (belowCount < cfg.lateBearishActivationBelowCloses) return false;
    const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
    return prevEma == null || e20 <= prevEma * 1.001;
  };

  // ── Zone memory ───────────────────────────────────────────────────────────
  const zoneMemory = new Map<string, { lastUsed: number; level: number }>();
  const makeZoneKey = (type: string, level: number): string => {
    const snap =
      Math.round(level / Math.max(marginPoints, 1)) *
      Math.round(Math.max(marginPoints, 1));
    return `${type}_${snap}`;
  };
  const isZoneRecentlyUsed = (key: string, i: number): boolean => {
    const entry = zoneMemory.get(key);
    return !!entry && i - entry.lastUsed < cfg.zoneRearmCandles;
  };
  const markZoneUsed = (key: string, i: number, level: number): void => {
    zoneMemory.set(key, { lastUsed: i, level });
  };
  const canRearmZone = (key: string, currentPrice: number): boolean => {
    const entry = zoneMemory.get(key);
    if (!entry) return true;
    return (
      Math.abs(currentPrice - entry.level) / Math.max(currentPrice, 1) >
      cfg.zoneRearmPct
    );
  };

  // ── Market state ──────────────────────────────────────────────────────────
  type MarketState =
    | 'BEARISH_TREND'
    | 'SIDEWAYS_RANGE'
    | 'BEARISH_REVERSAL_TRANSITION'
    | 'BULLISH_OR_NEUTRAL';

  const getMarketState = (
    i: number,
    ema20: number,
    sideways: boolean,
    bearishEma: boolean,
  ): MarketState => {
    if (sideways) return 'SIDEWAYS_RANGE';
    if (bearishEma && candles[i].close < ema20) return 'BEARISH_TREND';
    const lb = Math.min(cfg.lateBearishActivationLookback, i);
    let belowCount = 0;
    for (let k = i - lb + 1; k <= i; k++) {
      const ke = ema20Values[k];
      if (ke != null && candles[k].close < ke) belowCount++;
    }
    if (belowCount >= cfg.lateBearishActivationBelowCloses) {
      const prevEma = ema20Values[Math.max(0, i - cfg.emaSlopePeriod)];
      if (prevEma == null || ema20 <= prevEma * 1.001)
        return 'BEARISH_REVERSAL_TRANSITION';
    }
    return 'BULLISH_OR_NEUTRAL';
  };

  // ── Duplicate suppression ─────────────────────────────────────────────────
  let lastSignalIndex = -999;
  let lastSignalPrice = 0;
  const isDuplicate = (price: number, i: number): boolean => {
    if (lastSignalIndex < 0) return false;
    const tooClose =
      Math.abs(price - lastSignalPrice) / Math.max(price, 1) <=
      cfg.dupSuppressZonePct;
    const tooSoon = i - lastSignalIndex < cfg.dupCooldownCandles;
    return tooClose && tooSoon;
  };

  const buildSignal = (
    i: number,
    reason: string,
    entryPrice: number,
    stopLoss: number,
    isDayHighZoneRejection = false,
    nearDayHighZone = false,
    isNearDailyHigh = false,
  ): DaySellSignal => {
    const c = candles[i];
    return {
      candleIndex: i,
      actualCandleIndex: i,
      candleTime: getCandleTimeStr(c),
      candleDate: c.date instanceof Date ? c.date : new Date(c.date),
      unixTimestamp: getCandleTs(c),
      reason,
      entryPrice,
      stopLoss,
      risk: stopLoss - entryPrice,
      candleRSI: (rsiValues[i] ?? null) as number | null,
      isDayHighZoneRejection,
      nearDayHighZone,
      isNearDailyHigh,
    };
  };

  const isStrongBearishTriggerCandle = (c: any): boolean => {
    if (c.close >= c.open) return false;
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const body = c.open - c.close;
    return (
      body / range >= cfg.triggerCandleBodyRatio &&
      (c.close - c.low) / range <= cfg.triggerCandleCloseLowPct
    );
  };

  // ── 2-candle sequence helpers ─────────────────────────────────────────────
  const isValidDhrSetupCandle = (c: any, zoneLevel: number): boolean => {
    const range = c.high - c.low;
    if (range < 0.5) return false;
    if (c.high < zoneLevel - marginPoints) return false;
    if (c.close >= zoneLevel) return false;
    const uw = c.high - Math.max(c.open, c.close);
    const hasWick = uw / range >= cfg.seqSetupMinUwickRatio;
    const hasWeakClose = (c.close - c.low) / range < 0.65;
    return hasWick || hasWeakClose;
  };

  const isValidDhrConfirmationCandle = (
    c: any,
    setupMidpoint: number,
    setupLow: number,
  ): boolean => {
    if (cfg.seqConfirmBelowSetupLow)
      return c.close < setupLow || c.low < setupLow;
    if (c.close < setupMidpoint) return true;
    if (c.low < setupLow) return true;
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const body = Math.abs(c.close - c.open);
    return (
      c.close < c.open &&
      body / range >= 0.5 &&
      (c.close - c.low) / range < 0.35
    );
  };

  const isValidSweepSetupCandle = (c: any, refLevel: number): boolean => {
    if (c.high <= refLevel + cfg.sweepBufferPts) return false;
    if (c.close >= refLevel) return false;
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const uw = c.high - Math.max(c.open, c.close);
    const hasWick = uw / range >= cfg.seqSetupMinUwickRatio;
    const hasWeakClose = (c.close - c.low) / range < 0.65;
    return hasWick || hasWeakClose;
  };

  const isValidSweepConfirmationCandle = (
    c: any,
    setupMidpoint: number,
    setupLow: number,
  ): boolean => {
    if (cfg.seqConfirmBelowSetupLow)
      return c.close < setupLow || c.low < setupLow;
    if (c.close < setupMidpoint) return true;
    if (c.low < setupLow) return true;
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const body = Math.abs(c.close - c.open);
    return (
      c.close < c.open &&
      body / range >= 0.5 &&
      (c.close - c.low) / range < 0.35
    );
  };

  const isValidDhrTriggerCandle = (c: any, zoneLevel: number): boolean => {
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const uw = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.open - c.close);
    const isCandleDoji = body < range * 0.12;
    const hasWeakClose = (c.close - c.low) / range < cfg.dhrWeakCloseRatio;
    if (c.close >= zoneLevel + marginPoints) return false;
    const hasUppWick = uw / range >= cfg.dhrUpperWickRatio;
    const hasBearishBody =
      c.close < c.open && body / range >= cfg.dhrMinBodyRatioForDirect;
    return hasWeakClose && (isCandleDoji || hasUppWick || hasBearishBody);
  };

  const isValidSweepTriggerCandle = (c: any): boolean => {
    const range = c.high - c.low;
    if (range < 0.5) return false;
    const uw = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.open - c.close);
    const hasUppWick = uw / range >= cfg.dhrUpperWickRatio;
    const hasBearishBody =
      c.close < c.open && body / range >= cfg.dhrMinBodyRatioForDirect;
    const hasWeakClose = (c.close - c.low) / range < cfg.dhrWeakCloseRatio;
    return (hasUppWick || hasBearishBody) && hasWeakClose;
  };

  const reversalSL = (refHigh: number): number =>
    refHigh + Math.max(cfg.reversalSlFixedBuffer, atr * cfg.reversalSlAtrMult);

  // ── Armed setup state ─────────────────────────────────────────────────────
  type ArmedSellSetup = {
    type: string;
    signalIndex: number;
    signalLow: number;
    signalHigh: number;
    zoneReference: number;
    expiryIndex: number;
    stopLoss: number;
    reason: string;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
    armMarketState: string;
  };
  const armedSellSetups: ArmedSellSetup[] = [];

  const getArmedExpiryWindow = (setupType: string, state: string): number => {
    const base =
      state === 'BEARISH_TREND'
        ? cfg.trendArmedMaxCandles
        : state === 'BEARISH_REVERSAL_TRANSITION'
          ? cfg.transitionArmedMaxCandles
          : state === 'SIDEWAYS_RANGE'
            ? cfg.sidewaysArmedMaxCandles
            : cfg.neutralArmedMaxCandles;
    const extra =
      setupType === 'B2'
        ? cfg.b2ArmedExtraCandles
        : setupType === 'C'
          ? cfg.cArmedExtraCandles
          : setupType.startsWith('D')
            ? cfg.dArmedExtraCandles
            : setupType === 'E'
              ? cfg.eArmedExtraCandles
              : 0;
    return Math.max(2, base + extra);
  };

  const armSetup = (
    type: string,
    i: number,
    signalHigh: number,
    signalLow: number,
    zoneReference: number,
    sl: number,
    reason: string,
    isDayHighZoneRej = false,
    nearDayHighZn = false,
    isNearDailyH = false,
    armMarketState = 'UNKNOWN',
  ): void => {
    const existingIdx = armedSellSetups.findIndex(
      (a) =>
        a.type === type &&
        Math.abs(a.zoneReference - zoneReference) <= Math.max(marginPoints, 1),
    );
    if (existingIdx >= 0) armedSellSetups.splice(existingIdx, 1);
    armedSellSetups.push({
      type,
      signalIndex: i,
      signalLow,
      signalHigh,
      zoneReference,
      expiryIndex: i + getArmedExpiryWindow(type, armMarketState),
      stopLoss: sl,
      reason,
      isDayHighZoneRejection: isDayHighZoneRej,
      nearDayHighZone: nearDayHighZn,
      isNearDailyHigh: isNearDailyH,
      armMarketState,
    });
  };

  const hasActiveArmedSetupOfTypeNearby = (
    type: string,
    zoneReference: number,
    currentIndex: number,
  ): boolean =>
    armedSellSetups.some(
      (a) =>
        a.type === type &&
        a.expiryIndex >= currentIndex &&
        currentIndex - a.signalIndex <= cfg.armedNearbyWindow &&
        Math.abs(a.zoneReference - zoneReference) /
          Math.max(Math.abs(zoneReference), 1) <=
          cfg.armedNearbyZonePct,
    );

  const expiredCSetups: Array<{ level: number; expiredAt: number }> = [];

  const recentlyExpiredNearbyCSetup = (
    zoneRef: number,
    currentIndex: number,
  ): boolean =>
    expiredCSetups.some(
      (e) =>
        currentIndex - e.expiredAt <= cfg.cRearmCooldownCandles &&
        Math.abs(e.level - zoneRef) / Math.max(Math.abs(zoneRef), 1) <=
          cfg.armedNearbyZonePct,
    );

  const hasMovedAwayEnoughFromCZone = (
    zoneRef: number,
    currentPrice: number,
  ): boolean =>
    Math.abs(currentPrice - zoneRef) / Math.max(Math.abs(zoneRef), 1) >
    cfg.cMoveAwayPct;

  const isArmedSetupInvalidated = (
    armed: ArmedSellSetup,
    candle: any,
    currentEma20: number,
  ): boolean => {
    if (cfg.armedInvalidateOnCloseAboveHigh) {
      if (candle.close > armed.signalHigh + cfg.armedInvalidationBuffer)
        return true;
    }
    if (cfg.armedInvalidateEmaReclaim && armed.type === 'C') {
      if (candle.close > currentEma20 + cfg.armedInvalidationBuffer)
        return true;
    }
    return false;
  };

  const hasArmedSetupGoneStale = (
    armed: ArmedSellSetup,
    currentIndex: number,
    currentLow: number,
  ): boolean => {
    if (!cfg.useAtrBasedStaleDetect) return false;
    const expiryWindow = armed.expiryIndex - armed.signalIndex;
    const elapsed = currentIndex - armed.signalIndex;
    if (elapsed < Math.ceil(expiryWindow / 2)) return false;
    const trigBuf = Math.max(
      cfg.armedSetupTriggerBuffer,
      atr * cfg.armedSetupTriggerBufferAtrMult,
    );
    const triggerLevel = armed.signalLow - trigBuf;
    return currentLow - triggerLevel > atr * cfg.staleMoveThresholdAtr;
  };

  const shouldExpireArmedSetup = (
    armed: ArmedSellSetup,
    currentIndex: number,
    candle: any,
    currentEma20: number,
  ): boolean => {
    if (currentIndex > armed.expiryIndex) return true;
    if (isArmedSetupInvalidated(armed, candle, currentEma20)) return true;
    if (hasArmedSetupGoneStale(armed, currentIndex, candle.low)) return true;
    return false;
  };

  // ── Inherited bearish bias ────────────────────────────────────────────────
  const scorePreviousSessionBearishness = (): number => {
    let score = 0;
    if (firstEma20 != null && prevDayClose > 0 && prevDayClose < firstEma20)
      score += 2;
    if (prevDayClose > 0 && yesterdayHigh > 0 && prevDayLow > 0) {
      const priorRange = yesterdayHigh - prevDayLow;
      if (priorRange > 0 && (prevDayClose - prevDayLow) / priorRange < 0.45)
        score += 1;
    }
    if (
      prevDayClose > 0 &&
      yesterdayHigh > 0 &&
      prevDayClose < yesterdayHigh * 0.997
    )
      score += 1;
    const earlyWindow = Math.min(
      cfg.prevSessionBearishLookback,
      candles.length,
    );
    let earlyBelowCount = 0;
    let earlyTotal = 0;
    for (let k = 0; k < earlyWindow; k++) {
      const ke = ema20Values[k];
      if (ke == null) continue;
      earlyTotal++;
      if (candles[k].close < ke) earlyBelowCount++;
    }
    if (
      earlyTotal > 0 &&
      earlyBelowCount / earlyTotal >= cfg.prevSessionMinBelowEmaRatio
    )
      score += 2;
    if (firstEma20 != null) {
      const laterEmaIdx = Math.min(cfg.emaSlopePeriod + 2, candles.length - 1);
      const laterEma = ema20Values[laterEmaIdx];
      if (laterEma != null && laterEma < firstEma20) score += 1;
    }
    return score;
  };

  const prevSessionBearishScore = scorePreviousSessionBearishness();
  const inheritedBearishBias =
    cfg.inheritedBiasEnabled &&
    prevSessionBearishScore >= cfg.prevSessionMinScore;

  const isCurrentMoveLikelyPullback = (
    i: number,
    currentEma20: number,
  ): boolean => {
    const close = candles[i].close;
    if (currentEma20 > 0) {
      const aboveEmaPct = (close - currentEma20) / Math.max(currentEma20, 1);
      if (aboveEmaPct > cfg.pullbackMaxAboveEmaPct) return false;
    }
    if (prevDayClose > 0 && atr > 0) {
      let sessionHighToNow = 0;
      for (let k = 0; k <= i; k++) {
        if (candles[k].high > sessionHighToNow)
          sessionHighToNow = candles[k].high;
      }
      const moveAbovePrevClose = sessionHighToNow - prevDayClose;
      if (moveAbovePrevClose > atr * cfg.pullbackMaxAtrMove) return false;
    }
    return true;
  };

  // ── 2-candle rejection sequence state ────────────────────────────────────
  type PendingRejectionSetup = {
    seqType: 'DHR' | 'SWEEP';
    setupIndex: number;
    zoneReference: number;
    zoneType?: string;
    setupHigh: number;
    setupLow: number;
    setupMidpoint: number;
    stopLoss: number;
    reason: string;
    isDayHighZoneRejection: boolean;
    nearDayHighZone: boolean;
    isNearDailyHigh: boolean;
    expiryIndex: number;
    marketStateAtSetup: string;
  };
  const pendingSeqs: PendingRejectionSetup[] = [];

  const hasSimilarPendingSequence = (
    seqType: 'DHR' | 'SWEEP',
    zoneRef: number,
  ): boolean => {
    const tol =
      cfg.seqDuplicateZonePts > 0 ? cfg.seqDuplicateZonePts : marginPoints * 2;
    return pendingSeqs.some(
      (s) =>
        s.seqType === seqType && Math.abs(s.zoneReference - zoneRef) <= tol,
    );
  };

  const addPendingSequence = (seq: PendingRejectionSetup): void => {
    if (hasSimilarPendingSequence(seq.seqType, seq.zoneReference)) {
      diagLog('v2e', '[V2E-SEQ-SKIP-DUPE]', {
        instrument: params.instrumentName ?? '',
        seqType: seq.seqType,
        zoneReference: seq.zoneReference,
        setupIndex: seq.setupIndex,
      });
      return;
    }
    pendingSeqs.push(seq);
    diagLog('v2e', '[V2E-SEQ-QUEUED]', {
      instrument: params.instrumentName ?? '',
      seqType: seq.seqType,
      zoneReference: seq.zoneReference,
      setupIndex: seq.setupIndex,
      reason: seq.reason,
      expiryIndex: seq.expiryIndex,
      queueLength: pendingSeqs.length,
    });
  };

  const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

  let firstCandleLowBreakFired = false;
  for (let pi = 1; pi < scanStartIndex; pi++) {
    if (candles[pi]?.close < firstCandleLowBreakLevel) {
      firstCandleLowBreakFired = true;
      break;
    }
  }

  let rollingHigh = 0;
  for (let pi = 0; pi < scanStartIndex; pi++) {
    if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
  }

  let firstHourHighZoneUsed = false;

  diagLog('v2e', '[V2E-CALL]', {
    instrument: params.instrumentName ?? '',
    candleCount: candles.length,
    realtimeMode,
    sessionActive,
    firstEma20: firstEma20 ?? null,
    firstCandleOpen: firstCandle.open,
    firstHourHigh,
    firstHourLow,
    inheritedBearishBias,
    prevSessionBearishScore,
  });

  // ── Main scan loop ────────────────────────────────────────────────────────
  for (let i = scanStartIndex; i < candles.length; i++) {
    const candle = candles[i];
    const ema20 = ema20Values[i];
    const ema8 = ema8Values[i];

    const prevRollingHigh = rollingHigh;
    const intradayDayHigh = prevRollingHigh;
    if (candle.high > rollingHigh) rollingHigh = candle.high;

    if (!ema20) continue;

    const candleDate =
      candle.date instanceof Date ? candle.date : new Date(candle.date);
    const hrs = candleDate.getHours();
    const mins = candleDate.getMinutes();
    const minsOfDay = hrs * 60 + mins;
    if (minsOfDay < 9 * 60 + 30 || minsOfDay > 14 * 60 + 30) continue;

    const isSessionActive =
      sessionActive ||
      checkDelayedActivation(i) ||
      checkLateBearishActivation(i);
    if (!isSessionActive) continue;

    const candleHigh = candle.high;
    const candleLow = candle.low;
    const candleOpen = candle.open;
    const candleClose = candle.close;
    const candleBody = Math.abs(candleClose - candleOpen);
    const upperWick = candleHigh - Math.max(candleOpen, candleClose);
    const totalRange = candleHigh - candleLow;
    const isRedCandle = candleClose < candleOpen;
    const isDoji = candleBody < totalRange * 0.1 && totalRange > 0;
    const prev1 = i >= 1 ? candles[i - 1] : null;

    const sideways = isSidewaysAt(i);
    const bearishEma = isBearishEmaContext(i, ema20);
    const marketState = getMarketState(i, ema20, sideways, bearishEma);

    diagLog('v2e', '[V2E-CANDLE]', {
      instrument: params.instrumentName ?? '',
      candleTime: getCandleTimeStr(candle),
      candleClose,
      ema20,
      ema8: ema8 ?? null,
      sideways,
      bearishEma,
      marketState,
      sessionActive: isSessionActive,
      firstCandleLowBreakFired,
    });

    // ── Armed setup trigger check ───────────────────────────────────────────
    for (let a = armedSellSetups.length - 1; a >= 0; a--) {
      const armed = armedSellSetups[a];
      if (shouldExpireArmedSetup(armed, i, candle, ema20)) {
        if (armed.type === 'C') {
          expiredCSetups.push({ level: armed.zoneReference, expiredAt: i });
        }
        const expireReason =
          i > armed.expiryIndex
            ? 'candle-count'
            : isArmedSetupInvalidated(armed, candle, ema20)
              ? 'structure-invalidated'
              : 'stale-no-progress';
        diagLog('v2e', '[V2E-EXPIRED-ARMED]', {
          instrument: params.instrumentName ?? '',
          armedType: armed.type,
          reason: armed.reason,
          expireReason,
          signalIndex: armed.signalIndex,
          expiryIndex: armed.expiryIndex,
          armMarketState: armed.armMarketState,
        });
        armedSellSetups.splice(a, 1);
        continue;
      }
      const trigBuf = Math.max(
        cfg.armedSetupTriggerBuffer,
        atr * cfg.armedSetupTriggerBufferAtrMult,
      );
      const triggerLevel = armed.signalLow - trigBuf;
      const triggerHit = candle.low <= triggerLevel;
      const signalMidpoint = (armed.signalLow + armed.signalHigh) / 2;
      const triggerConfirmed =
        !cfg.armedTriggerNeedConfirm ||
        isRedCandle ||
        candleClose < armed.signalLow ||
        candleClose < signalMidpoint;
      if (triggerHit && triggerConfirmed) {
        const armSL = Math.max(armed.stopLoss, reversalSL(armed.signalHigh));
        const armRisk = armSL - candleClose;
        if (
          armRisk > 0 &&
          armRisk <= maxSellRiskPts &&
          !isDuplicate(candleClose, i)
        ) {
          const triggerReason = isRedCandle
            ? 'red-candle'
            : candleClose < armed.signalLow
              ? 'close-below-signal-low'
              : 'close-below-midpoint';
          const sig = buildSignal(
            i,
            armed.reason + ' [Triggered]',
            candleClose,
            armSL,
            armed.isDayHighZoneRejection,
            armed.nearDayHighZone,
            armed.isNearDailyHigh,
          );
          results.push(sig);
          diagLog('v2e', '[V2E-SIGNAL-ARMED]', {
            instrument: params.instrumentName ?? '',
            candleTime: sig.candleTime,
            armedType: armed.type,
            reason: armed.reason,
            triggerLevel,
            triggerReason,
            entryPrice: sig.entryPrice,
            stopLoss: sig.stopLoss,
            risk: sig.risk,
          });
          lastSignalIndex = i;
          lastSignalPrice = candleClose;
          armedSellSetups.splice(a, 1);
          break;
        }
      }
    }

    // ── Pending 2-candle rejection sequence check ─────────────────────────
    if (pendingSeqs.length > 0) {
      let seqSignalFired = false;
      const stillActive: PendingRejectionSetup[] = [];
      for (const seq of pendingSeqs) {
        const seqExpired = i > seq.expiryIndex;
        const seqInvalidated =
          candleClose > seq.setupHigh + cfg.armedInvalidationBuffer;
        if (seqExpired || seqInvalidated) {
          diagLog('v2e', '[V2E-EXPIRED-SEQ]', {
            instrument: params.instrumentName ?? '',
            seqType: seq.seqType,
            reason: seq.reason,
            setupIndex: seq.setupIndex,
            invalidReason: seqExpired ? 'candle-count' : 'close-above-high',
          });
          continue;
        }
        const seqConfirmed =
          seq.seqType === 'DHR'
            ? isValidDhrConfirmationCandle(
                candle,
                seq.setupMidpoint,
                seq.setupLow,
              )
            : isValidSweepConfirmationCandle(
                candle,
                seq.setupMidpoint,
                seq.setupLow,
              );
        if (seqConfirmed) {
          const seqRisk = seq.stopLoss - candleClose;
          if (
            seqRisk > 0 &&
            seqRisk <= maxSellRiskPts &&
            !isDuplicate(candleClose, i)
          ) {
            const sig = buildSignal(
              i,
              seq.reason + ' [2-Candle Seq]',
              candleClose,
              seq.stopLoss,
              seq.isDayHighZoneRejection,
              seq.nearDayHighZone,
              seq.isNearDailyHigh,
            );
            results.push(sig);
            diagLog('v2e', '[V2E-SIGNAL-SEQ]', {
              instrument: params.instrumentName ?? '',
              candleTime: sig.candleTime,
              seqType: seq.seqType,
              setupIndex: seq.setupIndex,
              reason: seq.reason,
              entryPrice: sig.entryPrice,
              stopLoss: sig.stopLoss,
              risk: sig.risk,
              marketState,
            });
            lastSignalIndex = i;
            lastSignalPrice = candleClose;
            seqSignalFired = true;
          }
          continue;
        }
        stillActive.push(seq);
      }
      pendingSeqs.length = 0;
      pendingSeqs.push(...stillActive);
      if (seqSignalFired && lastSignalIndex === i) continue;
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP A: First Candle Low Break
    // ════════════════════════════════════════════════════════════════════════
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

      if (!brkValidCandle) continue;
      if (ema20 < candleClose) {
        firstCandleLowBreakFired = true;
        continue;
      }
      if (sideways && cfg.sidewaysBreakdownStrictMode && !bearishEma) {
        firstCandleLowBreakFired = true;
        continue;
      }

      firstCandleLowBreakFired = true;
      const breakSL = firstCandleLow + 2;
      const breakRisk = breakSL - candleClose;

      if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
        const brkEMASupport =
          ema20 < candleClose && candleClose - ema20 < breakRisk;
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
          if (!isDuplicate(candleClose, i)) {
            const brkPattern = brkBearishEngulfing
              ? 'Bearish Engulfing'
              : brkStrongCloseNearLow
                ? 'Strong Close Near Low'
                : 'Large Bearish Body';
            if (isStrongBearishTriggerCandle(candle)) {
              const sig = buildSignal(
                i,
                `V2E: 1st Candle Low Break (${brkPattern})`,
                candleClose,
                breakSL,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-A]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'A-FirstCandleLowBreak',
                pattern: brkPattern,
                entryMode: 'direct',
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                ema20,
                firstCandleLowBreakLevel,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
            }
          }
        }
      }
      continue;
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP B2: Sweep / Transition Day High Rejection
    // ════════════════════════════════════════════════════════════════════════
    const b2InheritedOk =
      inheritedBearishBias && isCurrentMoveLikelyPullback(i, ema20);
    if (
      marketState === 'BEARISH_REVERSAL_TRANSITION' ||
      marketState === 'BEARISH_TREND' ||
      b2InheritedOk
    ) {
      const b2Refs: Array<{
        level: number;
        label: string;
        zoneType: string;
      }> = [];
      if (intradayDayHigh > 0)
        b2Refs.push({
          level: intradayDayHigh,
          label: `intraday high ${intradayDayHigh.toFixed(0)}`,
          zoneType: 'B2_IH',
        });
      if (yesterdayHigh > 0)
        b2Refs.push({
          level: yesterdayHigh,
          label: `prev day high ${yesterdayHigh.toFixed(0)}`,
          zoneType: 'B2_PH',
        });
      if (firstHourHigh > 0 && i >= cfg.firstHourCandles)
        b2Refs.push({
          level: firstHourHigh,
          label: `1st hour high ${firstHourHigh.toFixed(0)}`,
          zoneType: 'B2_FHH',
        });

      let b2Fired = false;
      for (const ref of b2Refs) {
        if (ref.level <= 0) continue;
        const nearOrSwept =
          Math.abs(candleHigh - ref.level) <= marginPoints * 2 ||
          candleHigh > ref.level + cfg.sweepBufferPts;
        if (!nearOrSwept) continue;
        if (candleClose >= ref.level) continue;

        let b2Score = 2;
        if (candleHigh > ref.level + cfg.sweepBufferPts) b2Score += 1;
        if (isRedCandle) b2Score += 1;
        if (ema20 > candleClose) b2Score += 2;
        if (upperWick > totalRange * 0.4) b2Score += 1;
        if (candleBody > totalRange * 0.3 && isRedCandle) b2Score += 1;
        if (i + 1 < candles.length) {
          const nc = candles[i + 1];
          if (nc && nc.close < nc.open && nc.close < candleClose) b2Score += 2;
        }

        const zk = makeZoneKey(ref.zoneType, ref.level);
        if (isZoneRecentlyUsed(zk, i) && !canRearmZone(zk, candleClose))
          continue;

        if (b2Score >= cfg.sweepDhrMinScore && !isDuplicate(candleClose, i)) {
          const b2SL = reversalSL(candleHigh);
          markZoneUsed(zk, i, ref.level);
          const b2DirectThreshold =
            marketState === 'BEARISH_TREND'
              ? cfg.b2TrendDirectMinScore
              : cfg.b2TransitionDirectMinScore;
          const b2DirectOk =
            marketState === 'BEARISH_TREND'
              ? isRedCandle && b2Score >= b2DirectThreshold
              : isValidSweepTriggerCandle(candle) &&
                b2Score >= b2DirectThreshold;
          if (b2DirectOk) {
            const b2Risk = b2SL - candleClose;
            if (b2Risk > 0 && b2Risk <= maxSellRiskPts) {
              const sig = buildSignal(
                i,
                `V2E: Sweep Day High Rejection (${ref.label})`,
                candleClose,
                b2SL,
                true,
                ref.zoneType === 'B2_IH',
                intradayDayHigh - candleHigh <= marginPoints * 3,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-B2]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'B2-SweepDHR',
                zone: ref.label,
                b2Score,
                entryMode: 'direct',
                marketState,
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                ema20,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
            }
          } else {
            armSetup(
              'B2',
              i,
              candleHigh,
              candleLow,
              ref.level,
              b2SL,
              `V2E: Sweep Day High Rejection (${ref.label})`,
              true,
              ref.zoneType === 'B2_IH',
              intradayDayHigh - candleHigh <= marginPoints * 3,
              marketState,
            );
            diagLog('v2e', '[V2E-ARMED-B2]', {
              instrument: params.instrumentName ?? '',
              candleTime: getCandleTimeStr(candle),
              zone: ref.label,
              b2Score,
              marketState,
              signalLow: candleLow,
              expiryIndex: i + getArmedExpiryWindow('B2', marketState),
            });
            if (isValidSweepSetupCandle(candle, ref.level)) {
              const seqSL = reversalSL(candleHigh);
              if (seqSL - candleClose <= maxSellRiskPts) {
                addPendingSequence({
                  seqType: 'SWEEP',
                  setupIndex: i,
                  zoneReference: ref.level,
                  zoneType: ref.zoneType ?? 'B2_SWEEP',
                  setupHigh: candleHigh,
                  setupLow: candleLow,
                  setupMidpoint: (candleHigh + candleLow) / 2,
                  stopLoss: seqSL,
                  reason: `V2E: Sweep Day High Rejection (${ref.label})`,
                  isDayHighZoneRejection: true,
                  nearDayHighZone: ref.zoneType === 'B2_IH',
                  isNearDailyHigh:
                    intradayDayHigh - candleHigh <= marginPoints * 3,
                  expiryIndex: i + cfg.seqConfirmWindowCandles,
                  marketStateAtSetup: marketState,
                });
              }
            }
          }
          b2Fired = true;
          break;
        }
      }
      if (b2Fired) continue;
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP B: Trend Day High Zone Rejection
    // ════════════════════════════════════════════════════════════════════════
    const bStrictPath = bearishEma && marketState !== 'BULLISH_OR_NEUTRAL';
    const bInheritedPath =
      cfg.setupBAllowInheritedContinuation &&
      inheritedBearishBias &&
      isCurrentMoveLikelyPullback(i, ema20);
    if (bStrictPath || bInheritedPath) {
      const nearIntradayHigh =
        intradayDayHigh > 0 &&
        Math.abs(candleHigh - intradayDayHigh) <= marginPoints * 1.5;
      const nearPrevDayHigh =
        yesterdayHigh > 0 &&
        Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
      const nearPrevDayClose =
        prevDayClose > 0 && Math.abs(candleHigh - prevDayClose) <= marginPoints;
      const nearFirstCandleHighZone =
        firstCandleHigh > 0 &&
        i > 3 &&
        Math.abs(candleHigh - firstCandleHigh) <= marginPoints;
      const nearFirstHourHigh =
        cfg.dhrIncludeFirstHourHigh &&
        firstHourHigh > 0 &&
        i >= cfg.firstHourCandles &&
        Math.abs(candleHigh - firstHourHigh) <= marginPoints * 1.5;
      let nearRecentSwingHigh = false;
      let nearSwingHighLevel = 0;
      if (cfg.dhrIncludeSwingHighs) {
        for (const sh of (params.swingHighs ?? []).slice(-3)) {
          if (
            sh.price > 0 &&
            sh.index < i &&
            sh.index >= i - cfg.sidewaysLookback * 3 &&
            Math.abs(candleHigh - sh.price) <= marginPoints * 1.5
          ) {
            nearRecentSwingHigh = true;
            nearSwingHighLevel = sh.price;
            break;
          }
        }
      }

      const nearAnyResistance =
        nearIntradayHigh ||
        nearPrevDayHigh ||
        nearPrevDayClose ||
        nearFirstCandleHighZone ||
        nearFirstHourHigh ||
        nearRecentSwingHigh;

      const dhrActiveLevel = nearIntradayHigh
        ? intradayDayHigh
        : nearPrevDayHigh
          ? yesterdayHigh
          : nearPrevDayClose
            ? prevDayClose
            : nearFirstHourHigh
              ? firstHourHigh
              : nearRecentSwingHigh
                ? nearSwingHighLevel
                : firstCandleHigh;

      if (
        nearAnyResistance &&
        isValidDhrTriggerCandle(candle, dhrActiveLevel)
      ) {
        const dhrSL = candleHigh + 2;
        const dhrRisk = dhrSL - candleClose;

        if (dhrRisk > 0 && dhrRisk <= maxSellRiskPts) {
          const emaDistance = ema20 - candleClose;
          const entryOk = bStrictPath ? emaDistance >= 0 : true;

          if (entryOk && !isDuplicate(candleClose, i)) {
            const dhrZone = nearIntradayHigh
              ? `intraday high ${intradayDayHigh.toFixed(0)}`
              : nearPrevDayHigh
                ? `prev day high ${yesterdayHigh.toFixed(0)}`
                : nearPrevDayClose
                  ? `prev day close ${prevDayClose.toFixed(0)}`
                  : nearFirstHourHigh
                    ? `1st hour high ${firstHourHigh.toFixed(0)}`
                    : nearRecentSwingHigh
                      ? `swing high ${nearSwingHighLevel.toFixed(0)}`
                      : `1st candle high ${firstCandleHigh.toFixed(0)}`;
            const bUW =
              upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
            const bEngulf =
              !!prev1 &&
              prev1.close > prev1.open &&
              candleOpen >= prev1.close &&
              candleClose < prev1.open &&
              isRedCandle;
            const bStrongBody = isRedCandle && candleBody > totalRange * 0.5;
            const dhrPattern = bEngulf
              ? 'Bearish Engulfing'
              : bStrongBody
                ? 'Strong Bearish Close'
                : bUW
                  ? 'Long Upper Wick'
                  : isDoji
                    ? 'Doji'
                    : 'Weak Close';
            const sig = buildSignal(
              i,
              `V2E: Day High Rejection (${dhrPattern} @ ${dhrZone})`,
              candleClose,
              dhrSL,
              true,
              nearIntradayHigh,
              rollingHigh - candleHigh <= marginPoints * 3,
            );
            results.push(sig);
            diagLog('v2e', '[V2E-SIGNAL-B]', {
              instrument: params.instrumentName ?? '',
              candleTime: sig.candleTime,
              setup: 'B-DayHighRejection',
              entryPath: bStrictPath ? 'strict' : 'inherited',
              inheritedBias: bInheritedPath,
              pattern: dhrPattern,
              zone: dhrZone,
              entryPrice: sig.entryPrice,
              stopLoss: sig.stopLoss,
              risk: sig.risk,
              ema20,
              emaDistance,
            });
            lastSignalIndex = i;
            lastSignalPrice = candleClose;
            continue;
          }
        }
      }

      if (
        nearAnyResistance &&
        isValidDhrSetupCandle(candle, dhrActiveLevel) &&
        !isDuplicate(candleClose, i)
      ) {
        const seqSL = candleHigh + 2;
        if (seqSL - candleClose <= maxSellRiskPts) {
          addPendingSequence({
            seqType: 'DHR',
            setupIndex: i,
            zoneReference: dhrActiveLevel,
            zoneType: 'B_DHR',
            setupHigh: candleHigh,
            setupLow: candleLow,
            setupMidpoint: (candleHigh + candleLow) / 2,
            stopLoss: seqSL,
            reason: `V2E: Day High Rejection @ ${dhrActiveLevel.toFixed(0)}`,
            isDayHighZoneRejection: true,
            nearDayHighZone: nearIntradayHigh,
            isNearDailyHigh: rollingHigh - candleHigh <= marginPoints * 3,
            expiryIndex: i + cfg.seqConfirmWindowCandles,
            marketStateAtSetup: marketState,
          });
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP C: Multi-candle EMA Rejection
    // ════════════════════════════════════════════════════════════════════════
    const cRangeEdgeNear =
      (firstHourHigh > 0 &&
        Math.abs(candleHigh - firstHourHigh) <=
          marginPoints * cfg.sidewaysRangeEdgeTolMult) ||
      (intradayDayHigh > 0 &&
        Math.abs(candleHigh - intradayDayHigh) <=
          marginPoints * cfg.sidewaysRangeEdgeTolMult);
    const cSidewaysRangeEdge =
      sideways &&
      cfg.sidewaysAllowsRangeEdgeSells &&
      ema20 > candleClose &&
      cRangeEdgeNear;
    if (
      ((!sideways && bearishEma) || cSidewaysRangeEdge) &&
      marketState !== 'BULLISH_OR_NEUTRAL'
    ) {
      const emaWindow = Math.min(cfg.emaRejectionWindow, i);
      let emaEventIdx = -1;
      let emaEventPattern = '';

      for (let w = Math.max(1, i - emaWindow); w <= i; w++) {
        const wc = candles[w];
        const we = ema20Values[w];
        if (!we) continue;
        const wRange = wc.high - wc.low;
        const wUpperWick = wc.high - Math.max(wc.open, wc.close);

        const directReject =
          wc.close < wc.open &&
          Math.abs(wc.high - we) <= marginPoints &&
          wc.close < we;

        const wickAbove =
          wc.high > we + marginPoints * 0.25 &&
          wc.close < we &&
          wRange > 0 &&
          wUpperWick / wRange >= 0.35;

        const nextWe = w < i ? (ema20Values[w + 1] ?? 0) : 0;
        const fakeReclaim =
          w < i &&
          wc.close > we &&
          wc.close > wc.open &&
          nextWe > 0 &&
          candles[w + 1].close < nextWe;

        const lowerHighUnderEma =
          w === i &&
          !!prev1 &&
          prev1.high >= we - marginPoints &&
          candleHigh < prev1.high &&
          isRedCandle &&
          candleHigh < we;

        if (directReject) {
          emaEventIdx = w;
          emaEventPattern = 'Direct Reject';
          break;
        }
        if (wickAbove) {
          emaEventIdx = w;
          emaEventPattern = 'Wick Above EMA';
          break;
        }
        if (fakeReclaim) {
          emaEventIdx = w;
          emaEventPattern = 'Fake Reclaim Fail';
          break;
        }
        if (lowerHighUnderEma) {
          emaEventIdx = w;
          emaEventPattern = 'Lower High Under EMA';
          break;
        }
      }

      if (emaEventIdx >= 0 && i - emaEventIdx <= cfg.emaRejectionWindow) {
        const confirmedNow = candleClose < ema20 && isRedCandle;

        const ec = candles[emaEventIdx];
        const ecRange = ec.high - ec.low;
        const ecUpperWick = ec.high - Math.max(ec.open, ec.close);
        const ecStrongWick = ecRange > 0 && ecUpperWick / ecRange >= 0.4;
        const ecStrongBody =
          ecRange > 0 &&
          ec.close < ec.open &&
          Math.abs(ec.open - ec.close) / ecRange >= 0.5;
        const eventCandleStrong = ecStrongWick || ecStrongBody;
        const canProceed = confirmedNow || eventCandleStrong;

        if (canProceed) {
          const prevEma3 = ema20Values[Math.max(0, i - 3)];
          const emaSlopingDown = prevEma3 != null && ema20 < prevEma3;

          let emaBounces = 0;
          const supportLookback = Math.min(10, i - 1);
          for (let k = Math.max(0, i - supportLookback); k < i; k++) {
            const ke = ema20Values[k];
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

          let cScore = 0;
          if (emaEventPattern === 'Direct Reject') cScore += 2;
          else if (emaEventPattern === 'Fake Reclaim Fail') cScore += 2;
          else if (emaEventPattern === 'Wick Above EMA') cScore += 2;
          else if (emaEventPattern === 'Lower High Under EMA') cScore += 1;
          if (emaSlopingDown) cScore += 1;
          if (emaNotSupport) cScore += 1;
          if (ema8 != null && ema8 < ema20) cScore += 1;
          if (eventCandleStrong) cScore += 1;
          if (confirmedNow) cScore += 1;

          if (cScore >= cfg.minEmaRejectionScore) {
            const eventHigh = candles[emaEventIdx].high;
            const emaSL = reversalSL(Math.max(candleHigh, eventHigh));
            const emaRisk = emaSL - candleClose;
            if (
              !isDuplicate(candleClose, i) &&
              emaRisk > 0 &&
              emaRisk <= maxSellRiskPts
            ) {
              const cDirectOk =
                marketState === 'BEARISH_TREND'
                  ? confirmedNow && cScore >= cfg.cTrendDirectMinScore
                  : isStrongBearishTriggerCandle(candle) &&
                    confirmedNow &&
                    cScore >= cfg.cTransitionDirectMinScore;
              if (cDirectOk) {
                const sig = buildSignal(
                  i,
                  `V2E: EMA Rejection (${emaEventPattern})`,
                  candleClose,
                  emaSL,
                  false,
                  false,
                  rollingHigh - candleHigh <= marginPoints * 3,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-C]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'C-EMAReject',
                  pattern: emaEventPattern,
                  emaEventIdx,
                  cScore,
                  marketState,
                  entryMode: 'direct',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  ema20,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              } else {
                if (hasActiveArmedSetupOfTypeNearby('C', ema20, i)) {
                  diagLog('v2e', '[V2E-SKIP-ARMED-C]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: getCandleTimeStr(candle),
                    reason: 'nearby C already armed',
                    pattern: emaEventPattern,
                    ema20,
                  });
                } else if (
                  recentlyExpiredNearbyCSetup(ema20, i) &&
                  !hasMovedAwayEnoughFromCZone(ema20, candleClose)
                ) {
                  diagLog('v2e', '[V2E-SKIP-ARMED-C]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: getCandleTimeStr(candle),
                    reason: 'recently expired C nearby, price not moved enough',
                    pattern: emaEventPattern,
                    ema20,
                  });
                } else {
                  armSetup(
                    'C',
                    i,
                    Math.max(candleHigh, eventHigh),
                    candleLow,
                    ema20,
                    emaSL,
                    `V2E: EMA Rejection (${emaEventPattern})`,
                    false,
                    false,
                    rollingHigh - candleHigh <= marginPoints * 3,
                    marketState,
                  );
                  diagLog('v2e', '[V2E-ARMED-C]', {
                    instrument: params.instrumentName ?? '',
                    candleTime: getCandleTimeStr(candle),
                    pattern: emaEventPattern,
                    cScore,
                    marketState,
                    signalLow: candleLow,
                    expiryIndex: i + getArmedExpiryWindow('C', marketState),
                  });
                }
              }
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP D: Sideways Range Logic (D1 / D2 / D3)
    // ════════════════════════════════════════════════════════════════════════
    if (sideways) {
      const fhTol = Math.max(marginPoints, atr * 0.3);

      // D1
      if (!firstHourHighZoneUsed && firstHourHigh > 0) {
        const nearFHH = Math.abs(candleHigh - firstHourHigh) <= fhTol;
        if (
          nearFHH &&
          (isBearishRejection(candle) || isStrongBearish(candle))
        ) {
          const fhhSL =
            ema20 > candleClose
              ? Math.max(firstHourHigh, ema20) + marginPoints * 0.5
              : firstHourHigh + marginPoints * 0.5;
          const fhhRisk = fhhSL - candleClose;
          const zk = makeZoneKey('FHH', firstHourHigh);
          if (
            fhhRisk > 0 &&
            fhhRisk <= maxSellRiskPts &&
            !isDuplicate(candleClose, i) &&
            (!isZoneRecentlyUsed(zk, i) || canRearmZone(zk, candleClose))
          ) {
            markZoneUsed(zk, i, firstHourHigh);
            firstHourHighZoneUsed = true;
            if (isStrongBearishTriggerCandle(candle)) {
              const sig = buildSignal(
                i,
                `V2E: 1st Hour High Rejection (sideways)`,
                candleClose,
                fhhSL,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-D1]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'D1-FHHReject',
                entryMode: 'direct',
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                firstHourHigh,
                ema20,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
            } else {
              armSetup(
                'D1',
                i,
                Math.max(candleHigh, firstHourHigh),
                candleLow,
                firstHourHigh,
                reversalSL(Math.max(candleHigh, firstHourHigh)),
                `V2E: 1st Hour High Rejection (sideways)`,
                false,
                false,
                false,
                marketState,
              );
              diagLog('v2e', '[V2E-ARMED-D1]', {
                instrument: params.instrumentName ?? '',
                candleTime: getCandleTimeStr(candle),
                signalLow: candleLow,
                firstHourHigh,
                marketState,
                expiryIndex: i + getArmedExpiryWindow('D1', marketState),
              });
            }
          }
        }
      }

      // D2
      if (!firstHourHighZoneUsed && firstHourHigh > 0) {
        const swept = candleHigh > firstHourHigh + cfg.sweepBufferPts;
        const closedBelow = candleClose < firstHourHigh;
        const sweepExcess = candleHigh - firstHourHigh;
        const maxSweep = Math.max(
          cfg.sweepMaxAboveRefPts,
          atr * cfg.sweepMaxAboveRefAtrMult,
        );
        if (swept && closedBelow && sweepExcess <= maxSweep) {
          let score = 3;
          if (isRedCandle) score += 1;
          if (ema20 > candleClose) score += 2;
          if (upperWick > totalRange * 0.4) score += 1;
          if (candleBody > totalRange * 0.3 && isRedCandle) score += 1;
          const zk = makeZoneKey('FHH_SWEEP', firstHourHigh);
          if (
            score >= cfg.minReversalScore &&
            !isDuplicate(candleClose, i) &&
            (!isZoneRecentlyUsed(zk, i) || canRearmZone(zk, candleClose))
          ) {
            const sl = reversalSL(candleHigh);
            const risk = sl - candleClose;
            if (risk > 0 && risk <= maxSellRiskPts) {
              markZoneUsed(zk, i, firstHourHigh);
              firstHourHighZoneUsed = true;
              if (
                isStrongBearishTriggerCandle(candle) &&
                score >= cfg.directEntryMinScore
              ) {
                const sig = buildSignal(
                  i,
                  `V2E: 1st Hour High Sweep Rejection (sideways)`,
                  candleClose,
                  sl,
                  true,
                  true,
                  false,
                );
                results.push(sig);
                diagLog('v2e', '[V2E-SIGNAL-D2]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: sig.candleTime,
                  setup: 'D2-FHHSweep',
                  score,
                  sweepExcess,
                  entryMode: 'direct',
                  entryPrice: sig.entryPrice,
                  stopLoss: sig.stopLoss,
                  risk: sig.risk,
                  firstHourHigh,
                  ema20,
                });
                lastSignalIndex = i;
                lastSignalPrice = candleClose;
              } else {
                armSetup(
                  'D2',
                  i,
                  candleHigh,
                  candleLow,
                  firstHourHigh,
                  sl,
                  `V2E: 1st Hour High Sweep Rejection (sideways)`,
                  true,
                  true,
                  false,
                  marketState,
                );
                diagLog('v2e', '[V2E-ARMED-D2]', {
                  instrument: params.instrumentName ?? '',
                  candleTime: getCandleTimeStr(candle),
                  score,
                  sweepExcess,
                  signalLow: candleLow,
                  firstHourHigh,
                  marketState,
                  expiryIndex: i + getArmedExpiryWindow('D2', marketState),
                });
              }
            }
          }
        }
      }

      // D3
      if (
        cfg.enableFirstHourLowBreakdown &&
        firstHourHighZoneUsed &&
        firstHourLow > 0 &&
        candleClose < firstHourLow &&
        isRedCandle
      ) {
        const zk = makeZoneKey('FHL', firstHourLow);
        if (!isZoneRecentlyUsed(zk, i) && !isDuplicate(candleClose, i)) {
          const sl = firstHourLow + marginPoints;
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            const sig = buildSignal(
              i,
              `V2E: 1st Hour Low Breakdown (sideways continuation)`,
              candleClose,
              sl,
            );
            results.push(sig);
            diagLog('v2e', '[V2E-SIGNAL-D3]', {
              instrument: params.instrumentName ?? '',
              candleTime: sig.candleTime,
              setup: 'D3-FHLBreakdown',
              entryPrice: sig.entryPrice,
              stopLoss: sig.stopLoss,
              risk: sig.risk,
              firstHourLow,
            });
            markZoneUsed(zk, i, firstHourLow);
            lastSignalIndex = i;
            lastSignalPrice = candleClose;
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SETUP E: Liquidity Sweep / Failed Breakout Rejection
    // ════════════════════════════════════════════════════════════════════════
    const eInheritedOk =
      inheritedBearishBias && isCurrentMoveLikelyPullback(i, ema20);
    if (marketState !== 'BULLISH_OR_NEUTRAL' || eInheritedOk) {
      const maxSweep2 = Math.max(
        cfg.sweepMaxAboveRefPts,
        atr * cfg.sweepMaxAboveRefAtrMult,
      );

      const keyHighRefs: Array<{
        level: number;
        label: string;
        zoneType: string;
      }> = [];
      if (intradayDayHigh > 0)
        keyHighRefs.push({
          level: intradayDayHigh,
          label: `intraday high ${intradayDayHigh.toFixed(0)}`,
          zoneType: 'IH',
        });
      if (yesterdayHigh > 0)
        keyHighRefs.push({
          level: yesterdayHigh,
          label: `prev day high ${yesterdayHigh.toFixed(0)}`,
          zoneType: 'PH',
        });
      if (firstCandleHigh > 0 && i > 3)
        keyHighRefs.push({
          level: firstCandleHigh,
          label: `1st candle high ${firstCandleHigh.toFixed(0)}`,
          zoneType: 'FC',
        });
      if (firstHourHigh > 0 && i >= cfg.firstHourCandles)
        keyHighRefs.push({
          level: firstHourHigh,
          label: `1st hour high ${firstHourHigh.toFixed(0)}`,
          zoneType: 'FHH_E',
        });
      for (const sh of (params.swingHighs ?? []).slice(-3)) {
        if (
          sh.price > 0 &&
          sh.index < i &&
          sh.index >= i - cfg.sidewaysLookback * 2
        ) {
          keyHighRefs.push({
            level: sh.price,
            label: `swing high ${sh.price.toFixed(0)}`,
            zoneType: 'SH',
          });
        }
      }

      for (const ref of keyHighRefs) {
        if (ref.level <= 0) continue;
        const swept = candleHigh > ref.level + cfg.sweepBufferPts;
        if (!swept) continue;
        const sweepExcess = candleHigh - ref.level;
        if (sweepExcess > maxSweep2) continue;
        if (cfg.sweepReturnRequired && candleClose >= ref.level) continue;

        let score = 3;
        if (candleClose < ref.level) score += 2;
        if (isRedCandle) score += 1;
        if (ema20 > candleClose) score += 2;
        if (upperWick > totalRange * 0.4) score += 1;
        if (candleBody > totalRange * 0.3 && isRedCandle) score += 1;
        if (i + 1 < candles.length) {
          const nc = candles[i + 1];
          if (nc && nc.close < nc.open && nc.close < candleClose) score += 2;
        }

        const zk = makeZoneKey(ref.zoneType, ref.level);
        if (isZoneRecentlyUsed(zk, i) && !canRearmZone(zk, candleClose))
          continue;

        if (score >= cfg.minReversalScore && !isDuplicate(candleClose, i)) {
          const sl = reversalSL(candleHigh);
          const risk = sl - candleClose;
          if (risk > 0 && risk <= maxSellRiskPts) {
            markZoneUsed(zk, i, ref.level);
            if (
              isValidSweepTriggerCandle(candle) &&
              score >= cfg.sweepDirectMinScore
            ) {
              const sig = buildSignal(
                i,
                `V2E: Liquidity Sweep Rejection (${ref.label})`,
                candleClose,
                sl,
                true,
                true,
                false,
              );
              results.push(sig);
              diagLog('v2e', '[V2E-SIGNAL-E]', {
                instrument: params.instrumentName ?? '',
                candleTime: sig.candleTime,
                setup: 'E-LiquiditySweep',
                zone: ref.label,
                score,
                sweepExcess,
                marketState,
                entryMode: 'direct',
                entryPrice: sig.entryPrice,
                stopLoss: sig.stopLoss,
                risk: sig.risk,
                ema20,
              });
              lastSignalIndex = i;
              lastSignalPrice = candleClose;
            } else {
              armSetup(
                'E',
                i,
                candleHigh,
                candleLow,
                ref.level,
                sl,
                `V2E: Liquidity Sweep Rejection (${ref.label})`,
                true,
                true,
                false,
                marketState,
              );
              diagLog('v2e', '[V2E-ARMED-E]', {
                instrument: params.instrumentName ?? '',
                candleTime: getCandleTimeStr(candle),
                zone: ref.label,
                score,
                sweepExcess,
                signalLow: candleLow,
                marketState,
                expiryIndex: i + getArmedExpiryWindow('E', marketState),
              });
              if (isValidSweepSetupCandle(candle, ref.level)) {
                if (sl - candleClose <= maxSellRiskPts) {
                  addPendingSequence({
                    seqType: 'SWEEP',
                    setupIndex: i,
                    zoneReference: ref.level,
                    zoneType: ref.zoneType ?? 'E_SWEEP',
                    setupHigh: candleHigh,
                    setupLow: candleLow,
                    setupMidpoint: (candleHigh + candleLow) / 2,
                    stopLoss: sl,
                    reason: `V2E: Liquidity Sweep Rejection (${ref.label})`,
                    isDayHighZoneRejection: true,
                    nearDayHighZone: true,
                    isNearDailyHigh: false,
                    expiryIndex: i + cfg.seqConfirmWindowCandles,
                    marketStateAtSetup: marketState,
                  });
                }
              }
            }
            break;
          }
        }
      }
    }
  }

  return results;
}

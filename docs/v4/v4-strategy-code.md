private detectDaySellSignalsV4(params: {
candles: any[];
ema8Values: (number | null)[];
ema20Values: (number | null)[];
vwapValues: number[];
superTrendData: Array<{ superTrend: number; trend: 'up' | 'down' } | null>;
marginPoints: number;
maxSellRiskPts?: number;
realtimeMode?: boolean;
instrumentName?: string;
}): Array<{
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
}> {
const {
candles,
ema8Values,
ema20Values,
vwapValues,
marginPoints,
maxSellRiskPts = 40,
realtimeMode = false,
} = params;

    const results: ReturnType<typeof this.detectDaySellSignalsV4> = [];
    if (candles.length < 3) return results;

    // ── Diagnostic file logger ────────────────────────────────────────────
    const v4DiagLogFile = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'v4',
      'v4-strategy-diag.log',
    );
    const v4DiagLog = (tag: string, data: object) => {
      const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
      try {
        fs.appendFileSync(v4DiagLogFile, line, 'utf8');
      } catch {
        // ignore
      }
    };

    // ── Adaptive config ──────────────────────────────────────────────────────
    const cfg = {
      candleBodyRatio: 0.55, // body / range >= this → "strong bearish"
      superBearishBodyRatio: 0.6, // first candle body / range threshold
      superBearishTailRatio: 0.15, // close within 15 % of range from candle low
      largeFirstCandleATRMultiplier: 1.4,
      retracements: [0.5, 0.618],
      retracementTol: 0.08, // ± 8 % of first-candle range
      ema20TolPct: 0.006, // 0.6 % of price (EMA proximity)
      sidewaysEmaGapPct: 0.004, // < 0.4 % gap between 8 & 20 EMA
      sidewaysLookback: 8,
      sidewaysCrossings: 2, // EMA cross-count threshold
      dupSuppressZonePct: 0.015, // suppress within 1.5 % of prior signal price
      firstHourCandles: 12, // 12 × 5 min = 1 hr
    };

    // ── ATR: average true range over first N candles ─────────────────────────
    const atrCandles = candles.slice(0, Math.min(10, candles.length));
    const atr =
      atrCandles.reduce((s, c) => s + (c.high - c.low), 0) / atrCandles.length;
    const zoneMargin = marginPoints;

    // ── First candle ─────────────────────────────────────────────────────────
    const firstCandle = candles[0];
    const fcRange = firstCandle.high - firstCandle.low;
    const fcBody = Math.abs(firstCandle.close - firstCandle.open);
    const fcBearish = firstCandle.close < firstCandle.open;
    const avgRange = Math.max(atr, fcRange * 0.5);

    // ── Activation: instrument must open BELOW 20 EMA ────────────────────────
    const firstEma20 = ema20Values[0];
    if (firstEma20 == null || firstCandle.open >= firstEma20) return results;

    // ── Classify first candle ────────────────────────────────────────────────
    const isSuperBearishFC = (() => {
      if (!fcBearish || fcRange < 0.5) return false;
      const bodyRatioOk =
        fcRange > 0 && fcBody / fcRange >= cfg.superBearishBodyRatio;
      const tailOk =
        fcRange > 0 &&
        (firstCandle.close - firstCandle.low) / fcRange <=
          cfg.superBearishTailRatio;
      return bodyRatioOk && tailOk;
    })();

    const isLargeFC = fcRange > cfg.largeFirstCandleATRMultiplier * avgRange;

    // ── First-candle retracement zones (50 % / 61.8 %) ──────────────────────
    const fcRetraceZones = cfg.retracements.map((lvl) => {
      const midPrice = firstCandle.high - fcRange * lvl;
      const tol = fcRange * cfg.retracementTol;
      return { level: lvl, low: midPrice - tol, high: midPrice + tol };
    });

    // ── First 1-hour range ────────────────────────────────────────────────────
    const fhSlice = candles.slice(
      0,
      Math.min(cfg.firstHourCandles, candles.length),
    );
    const firstHourHigh = Math.max(...fhSlice.map((c) => c.high));

    // ── V4 session setup diagnostics ─────────────────────────────────────────
    v4DiagLog('[V4-SETUP]', {
      instrument: params.instrumentName ?? '',
      firstCandleOpen: +firstCandle.open.toFixed(2),
      firstEma20: +firstEma20.toFixed(2),
      isSuperBearishFC,
      isLargeFC,
      fcRange: +fcRange.toFixed(2),
      atr: +atr.toFixed(2),
      firstHourHigh: +firstHourHigh.toFixed(2),
    });

    // ── Per-session zone / dedup memory ──────────────────────────────────────
    const usedZones = { firstCandleTop: false, firstHourHigh: false };
    const usedRetraceLevels = new Set<number>();
    let fcLowOriginal = firstCandle.low;
    let fcLowBrokenOnce = false;
    let reversalLow: number | null = null;
    let lastSignalIndex = -999;
    let lastSignalPrice = 0;

    // ── Candle helpers ────────────────────────────────────────────────────────
    const isStrongBearish = (c: any): boolean => {
      if (c.close >= c.open) return false;
      const range = c.high - c.low;
      if (range < 0.5) return false;
      return (c.open - c.close) / range >= cfg.candleBodyRatio;
    };

    const isBearishRejection = (c: any): boolean => {
      const range = c.high - c.low;
      if (range < 0.5) return false;
      const upperWick = c.high - Math.max(c.open, c.close);
      return upperWick / range >= 0.35 && c.close < c.open;
    };

    const isNearLevel = (price: number, level: number, tol: number) =>
      Math.abs(price - level) <= tol;

    const isDuplicate = (price: number): boolean =>
      lastSignalIndex >= 0 &&
      Math.abs(price - lastSignalPrice) / Math.max(price, 1) <=
        cfg.dupSuppressZonePct;

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

    // ── Timestamp helpers ─────────────────────────────────────────────────────
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

    const buildSignal = (
      i: number,
      reason: string,
      entryPrice: number,
      stopLoss: number,
    ) => {
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
        candleRSI: null as number | null,
        isDayHighZoneRejection: false,
        nearDayHighZone: false,
        isNearDailyHigh: false,
      };
    };

    const scanStart = realtimeMode ? Math.max(2, candles.length - 2) : 2;

    // ── Main scan loop ─────────────────────────────────────────────────────────
    for (let i = scanStart; i < candles.length; i++) {
      const candle = candles[i];
      const ema20 = ema20Values[i];
      const ema8 = ema8Values[i];
      if (!ema20 || !ema8) continue;

      // Track false-breakdown of first candle low
      if (
        !fcLowBrokenOnce &&
        candle.low < fcLowOriginal &&
        candle.close > fcLowOriginal
      ) {
        fcLowBrokenOnce = true;
        reversalLow = candle.low;
      }

      const sideways = isSidewaysAt(i);
      let signalReason: string | null = null;
      let entryPrice = 0;
      let stopLoss = 0;

      // ── Scenario 1: FIRST_CANDLE_PULLBACK_SELL ────────────────────────────
      if (
        !signalReason &&
        isSuperBearishFC &&
        !usedZones.firstCandleTop &&
        !sideways
      ) {
        const topZone = firstCandle.open;
        const tol = Math.max(zoneMargin, atr * 0.3);
        if (
          isNearLevel(candle.high, topZone, tol) &&
          (isBearishRejection(candle) || isStrongBearish(candle))
        ) {
          entryPrice = candle.close;
          stopLoss = Math.max(firstCandle.high, candle.high) + zoneMargin * 0.3;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_CANDLE_PULLBACK_SELL';
            usedZones.firstCandleTop = true;
          }
        }
      }

      // ── Scenario 2: FIRST_CANDLE_RETRACEMENT_SELL ────────────────────────
      if (!signalReason && isLargeFC && fcBearish) {
        for (const zone of fcRetraceZones) {
          if (usedRetraceLevels.has(zone.level)) continue;
          if (candle.high >= zone.low && candle.high <= zone.high + atr * 0.2) {
            if (isBearishRejection(candle) || isStrongBearish(candle)) {
              entryPrice = candle.close;
              stopLoss = firstCandle.high + zoneMargin * 0.3;
              const risk = stopLoss - entryPrice;
              if (risk > 0 && risk <= maxSellRiskPts) {
                signalReason = `FIRST_CANDLE_RETRACEMENT_SELL (${(zone.level * 100).toFixed(0)}%)`;
                usedRetraceLevels.add(zone.level);
                break;
              }
            }
          }
        }
      }

      // ── Scenario 3: FIRST_CANDLE_LOW_BREAK_SELL ───────────────────────────
      if (!signalReason) {
        const breakLevel =
          fcLowBrokenOnce && reversalLow != null ? reversalLow : fcLowOriginal;
        const prevC = candles[i - 1];
        if (
          candle.close < breakLevel &&
          prevC.close >= breakLevel &&
          isStrongBearish(candle)
        ) {
          entryPrice = candle.close;
          stopLoss = Math.max(candle.high, breakLevel) + zoneMargin * 0.3;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_CANDLE_LOW_BREAK_SELL';
          }
        }
      }

      // ── Scenario 4: EMA_REJECTION_SELL ────────────────────────────────────
      // Price below 20 EMA; pulls back to EMA zone from below; rejects.
      if (!signalReason && candle.close < ema20 && !sideways) {
        const emaTol = ema20 * cfg.ema20TolPct + zoneMargin * 0.5;
        const prevEma20 = ema20Values[i - 1];
        if (prevEma20 != null) {
          const prevBelowEma = candles[i - 1].close < prevEma20;
          const priceReachedEma =
            candle.high >= ema20 - emaTol &&
            candle.high <= ema20 + emaTol * 1.5;
          if (
            priceReachedEma &&
            prevBelowEma &&
            (isBearishRejection(candle) || isStrongBearish(candle))
          ) {
            entryPrice = candle.close;
            stopLoss = candle.high + zoneMargin * 0.3;
            const risk = stopLoss - entryPrice;
            if (risk > 0 && risk <= maxSellRiskPts) {
              signalReason = 'EMA_REJECTION_SELL';
            }
          }
        }
      }

      // ── Scenario 5: EMA_FAKE_BREAK_SELL ───────────────────────────────────
      // Previous candle closed above EMA/VWAP; current candle fails back below.
      if (!signalReason) {
        const prevC5 = candles[i - 1];
        const prevEma20_5 = ema20Values[i - 1];
        const prevVwap = vwapValues[i - 1] ?? 0;
        const currVwap = vwapValues[i] ?? 0;
        if (prevEma20_5 != null) {
          const prevFakeEma = prevC5.close > prevEma20_5;
          const currBelowEma = candle.close < ema20;
          const prevFakeVwap = prevVwap > 0 && prevC5.close > prevVwap;
          const currBelowVwap = currVwap > 0 && candle.close < currVwap;
          if (
            (prevFakeEma && currBelowEma) ||
            (prevFakeVwap && currBelowVwap)
          ) {
            if (isStrongBearish(candle) || isBearishRejection(candle)) {
              entryPrice = candle.close;
              stopLoss = Math.max(prevC5.high, candle.high) + zoneMargin * 0.3;
              const risk = stopLoss - entryPrice;
              if (risk > 0 && risk <= maxSellRiskPts) {
                signalReason = 'EMA_FAKE_BREAK_SELL';
              }
            }
          }
        }
      }

      // ── Scenario 6: FIRST_HOUR_HIGH_REJECTION_SELL ────────────────────────
      // Sideways market fallback: price touches first-hour high and rejects.
      if (!signalReason && sideways && !usedZones.firstHourHigh) {
        const fhTol = Math.max(zoneMargin, atr * 0.3);
        if (
          isNearLevel(candle.high, firstHourHigh, fhTol) &&
          (isBearishRejection(candle) || isStrongBearish(candle))
        ) {
          entryPrice = candle.close;
          stopLoss = firstHourHigh + zoneMargin * 0.5;
          const risk = stopLoss - entryPrice;
          if (risk > 0 && risk <= maxSellRiskPts) {
            signalReason = 'FIRST_HOUR_HIGH_REJECTION_SELL';
            usedZones.firstHourHigh = true;
          }
        }
      }

      // ── Emit signal ────────────────────────────────────────────────────────
      if (signalReason && entryPrice > 0 && stopLoss > entryPrice) {
        if (!isDuplicate(entryPrice)) {
          results.push(buildSignal(i, signalReason, entryPrice, stopLoss));
          lastSignalIndex = i;
          lastSignalPrice = entryPrice;
        }
      }

      // ── V4 per-candle eval diagnostic ────────────────────────────────────
      v4DiagLog('[V4-EVAL]', {
        instrument: params.instrumentName ?? '',
        candleTime: getCandleTimeStr(candle),
        candleClose: +candle.close.toFixed(2),
        ema20: +ema20.toFixed(2),
        ema8: +ema8.toFixed(2),
        vwap: +(vwapValues[i] ?? 0).toFixed(2),
        fcLowBrokenOnce,
        sideways,
        signalReason: signalReason ?? 'SKIP',
      });
    }

    return results;

}

private detectDaySellSignalsV3(params: {
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

    const results: ReturnType<typeof this.detectDaySellSignalsV3> = [];
    const scanStartIndex = realtimeMode ? Math.max(3, candles.length - 2) : 3;

    // ── Diagnostic file logger ────────────────────────────────────
    const diagLogFile = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'v3-strategy-diag.log',
    );
    const v3DiagLog = (tag: string, data: object) => {
      const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
      try {
        fs.appendFileSync(diagLogFile, line, 'utf8');
      } catch {
        // Silently ignore if docs folder is not writable
      }
    };

    const firstCandleLow = candles.length > 0 ? candles[0].low : 0;
    const firstCandleHigh = candles.length > 0 ? candles[0].high : 0;

    let rollingHigh = 0;
    for (let pi = 0; pi < scanStartIndex; pi++) {
      if (candles[pi].high > rollingHigh) rollingHigh = candles[pi].high;
    }

    // Allow up to 3 first-candle breakdown attempts
    let firstCandleLowBreakCount = 0;
    const maxBreakdownAttempts = 3;

    // Signal cooldown and zone memory
    let lastSignalIndex = -999;
    let lastSignalPrice = 0;

    // ── Fixed zone margin (static, instrument-agnostic) ───────────────────
    const zoneMargin = marginPoints;

    // ── Session-level zone usage memory (one clean rejection per zone) ────
    const usedZones = {
      intradayHigh: false,
      prevDayHigh: false,
      prevDayClose: false,
      firstCandleHigh: false,
    };
    const usedSwingHighLevels = new Set<number>();

    // ── Helper: has a swing high been broken (close decisively above it) ──
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

    // ── Helper: is a swing high still relevant (recent, valid pivot) ──────
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

    // ── Helper: find nearest valid unbroken swing high within zone ────────
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
      // Prefer more recent pivot; break ties by higher price
      candidates.sort((a, b) =>
        b.index !== a.index ? b.index - a.index : b.price - a.price,
      );
      return candidates[0];
    };

    for (let i = scanStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const candleEMA = emaValues[i];
      if (!candleEMA) continue;

      // Use previous rolling high so a new-high candle is not treated as DHR
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
      // Trade window: 9:25 AM – 2:45 PM IST
      if (minsOfDay < 9 * 60 + 25 || minsOfDay > 14 * 60 + 45) continue;

      const prev1 = i >= 1 ? candles[i - 1] : null;
      const prev2 = i >= 2 ? candles[i - 2] : null;
      const candleRSI = rsiValues[i];

      // ── Signal cooldown: block new signal for 5 candles ──────────────────
      if (i - lastSignalIndex < 5) continue;

      // ── Zone memory: block repeated signals at same price zone ────────────
      if (
        lastSignalPrice > 0 &&
        Math.abs(candleHigh - lastSignalPrice) <= zoneMargin
      )
        continue;

      // ── Uptrend filter ────────────────────────────────────────────────────
      // If >60% of last 20 candles are above EMA → uptrend → only resistance/EMA rejection
      const lookback20 = Math.min(20, i);
      let aboveEMACount = 0;
      for (let k = i - lookback20; k < i; k++) {
        const ke = emaValues[k];
        if (ke != null && candles[k].close > ke) aboveEMACount++;
      }
      const isUptrend = lookback20 > 0 && aboveEMACount / lookback20 > 0.6;

      // ── SuperTrend filter ─────────────────────────────────────────────────
      const stEntry = superTrendData ? superTrendData[i] : null;
      const isSuperTrendUp = stEntry ? stEntry.trend === 'up' : false;

      // ── Strong trend filter ───────────────────────────────────────────────
      const strongTrend =
        i >= 6 &&
        emaValues[i] != null &&
        emaValues[i - 3] != null &&
        emaValues[i - 6] != null &&
        (emaValues[i] as number) > (emaValues[i - 3] as number) &&
        (emaValues[i - 3] as number) > (emaValues[i - 6] as number);

      if (strongTrend && candleClose > candleEMA) continue;

      // ── Resistance zones ──────────────────────────────────────────────────
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

      // Helpers
      const makeTs = () => Math.floor(candleDate.getTime() / 1000) + 19800;
      const makeTime = () =>
        candleDate.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });

      // ── Strong bull run filter ─────────────────────────────────────────
      const strongBullRun =
        i >= 4 &&
        candles[i - 1].close > candles[i - 1].open &&
        candles[i - 2].close > candles[i - 2].open &&
        candles[i - 3].close > candles[i - 3].open &&
        candles[i - 1].high > candles[i - 2].high &&
        candles[i - 2].high > candles[i - 3].high;

      if (strongBullRun && candleClose > candleEMA) continue;

      // ── Market regime classifier ──────────────────────────────────────────
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

      // ── Regime diagnostics ──────────────────────────────────────────
      v3DiagLog('[V3-REGIME-DIAG]', {
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

      let bestSignal: (typeof results)[0] | null = null;
      let signalZoneRef = candleHigh; // zone reference for duplicate suppression

      // ── Shared bearish rejection confirmation (reused by all P1 zone branches) ──
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
      // Requires: strict proximity + weak close + no bullish context + bearish regime
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
          if (nearPrevDayHigh) score += 1; // confluence with prev day high
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
      // Requires bearish structure (regime/emaDown/lowerHigh) + not bullish context
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
      // Requires strong bearish context (same standard as intraday high)
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
      // PRIORITY 2: EMA Rejection (allowed even in uptrend / ST up)
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

          // ── V3 EMA Rejection Diagnostics ─────────────────────────────
          if (nearEMA) {
            const score =
              1 +
              (lowerHighForming ? 2 : 0) +
              (candleRSI != null && candleRSI > 50 ? 1 : 0) +
              (nearAnyResistance ? 2 : 0);
            v3DiagLog('[V3-EMA-DIAG]', {
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
          // ─────────────────────────────────────────────────────────────

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
              score += 1; // EMA rejection
              if (lowerHighForming) score += 2; // lower high structure
              if (candleRSI != null && candleRSI > 50) score += 1;
              if (nearAnyResistance) score += 2; // resistance confluence
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
      // Candle pushes above EMA intrabar but closes back below → bull trap.
      // Quality standard matches P2 EMA Rejection — not a loose fallback.
      // ════════════════════════════════════════════════════════════════════
      if (!bestSignal) {
        const fakeBreakAboveEMA =
          candleHigh > candleEMA && candleClose < candleEMA;

        if (fakeBreakAboveEMA) {
          // Compute belowCount for context
          const lb6fb = Math.min(6, i);
          let belowCountFb = 0;
          for (let k = i - lb6fb; k < i; k++) {
            const ke = emaValues[k];
            if (ke != null && candles[k].close < ke) belowCountFb++;
          }

          // Use 3-period EMA slope — same standard as P2 EMA Rejection
          const emaSlopingDownFb =
            i >= 3 &&
            emaValues[i] != null &&
            emaValues[i - 3] != null &&
            (emaValues[i] as number) < (emaValues[i - 3] as number);

          // Rejection confirmation: meaningful upper wick above EMA
          const wickAboveEMA = candleHigh - candleEMA;
          const rejectionWick =
            wickAboveEMA > 0 &&
            (upperWick > candleBody * 1.2 || upperWick > totalRange * 0.35);

          // EMA bounce count — prevent signals when EMA has been acting as support
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
              score += 2; // fake break above EMA = strong signal
              if (emaSlopingDownFb) score += 1; // EMA slope bearish
              if (belowCountFb >= 3) score += 1; // price predominantly below EMA
              if (candleRSI != null && candleRSI > 50) score += 1; // RSI overbought
              if (nearAnyResistance) score += 1; // near resistance
              if (lowerHighForming) score += 1; // lower high structure
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
      // Bucket A — rejection/retest engine: runs BEFORE the early-skip block
      // so it is evaluated even on uptrend/SuperTrend days.
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
      // Bucket A engines (P1, P2, P2b, P4) have already run above.
      // Bucket B continuation engines (P3, P5) are skipped in uptrend/ST-up.
      if (isUptrend || isSuperTrendUp) {
        if (bestSignal) results.push(bestSignal);
        continue;
      }

      // ════════════════════════════════════════════════════════════════════
      // PRIORITY 3: Lower High Breakdown
      // Bucket B — continuation engine: only runs when not in uptrend/ST-up
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
            score += 2; // lower high structure
            score += 1; // EMA rejection
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
            // Support protection: no support within 1R below entry
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
        // Mark the triggering zone as used for this session
        if (nearIntradayHigh) usedZones.intradayHigh = true;
        if (nearPrevDayHigh) usedZones.prevDayHigh = true;
        if (nearPrevDayClose) usedZones.prevDayClose = true;
        if (nearFirstCandleHigh) usedZones.firstCandleHigh = true;
        if (nearSwingHigh && matchedSwingHigh) {
          usedSwingHighLevels.add(matchedSwingHigh.price);
        }
      }

      // Update rolling high AFTER signal evaluation so a new-high candle
      // is only available as DHR reference from the NEXT iteration.
      if (candle.high > rollingHigh) rollingHigh = candle.high;
    }

    return results;

}

private detectDaySellSignals(params: {
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
minSellRsi = 45,
maxSellRiskPts = 25,
realtimeMode = false,
instrumentName = '',
superTrendData,
} = params;

    const results: ReturnType<typeof this.detectDaySellSignals> = [];

    // ── Diagnostic file logger ────────────────────────────────────────────
    const v1DiagLogFile = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'docs',
      'v1-strategy-diag.log',
    );
    const v1DiagLog = (tag: string, data: object) => {
      const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`;
      try {
        fs.appendFileSync(v1DiagLogFile, line, 'utf8');
      } catch {
        // ignore
      }
    };

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
    // Previous day pullback guard: if prev day’s low is within
    // marginPoints×2 of today’s first candle low they form the same
    // confluence support zone — don’t fire until the LOWER level is broken.
    // const firstCandleLowBreakLevel =
    //   prevDayLow > 0 &&
    //   firstCandleLow > 0 &&
    //   Math.abs(firstCandleLow - prevDayLow) <= marginPoints * 2
    //     ? Math.min(firstCandleLow, prevDayLow) - 1
    //     : firstCandleLow;
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
      // Price breaks below the opening 9:15 candle low with a valid breakdown candle.
      // Condition 1: Valid breakdown candle (one of):
      //   a) Large bearish body  — body > 40% of range
      //   b) Bearish engulfing   — current red candle engulfs prior green candle
      //   c) Strong close near candle low — close in bottom 20% of range
      // Condition 2: No nearby support below entry (would block reaching T1):
      //   a) 20 EMA not within 1R below entry
      //   b) Previous Day Low not within 1R below entry
      //   c) No intraday swing low (prior candle lows) within 1R below entry
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
          // Weak candle pattern — do NOT set the flag. Let the next candle retry.
          // (e.g. 9:40 is a wide-range 5-min candle with no strong body; 9:45 may be cleaner)
          v1DiagLog('[V1-FCL-SKIP]', {
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

        // EMA must be above the candle — if EMA is below close, it's acting as
        // dynamic support beneath the price. Selling into support is invalid.
        if (candleEMA != null && candleEMA < candleClose) {
          // EMA is below close (support present) — consume flag so we don't retry
          firstCandleLowBreakFired = true;
          v1DiagLog('[V1-FCL-SKIP]', {
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

        // Valid pattern + EMA clear — lock the flag now
        firstCandleLowBreakFired = true;

        // SL: structural level (the broken first candle low is now resistance).
        // Using the structural level (not candleHigh) keeps risk tight and consistent
        // across all candle intervals (1min, 3min, 5min).
        const breakSL = firstCandleLow + 2;
        const breakRisk = breakSL - candleClose;

        // Allow up to 2× the normal risk cap for structural breakdown signals.
        // 5-min candles naturally have wider range than 1-min; the structural SL
        // (first candle low) is valid regardless of candle interval.
        if (breakRisk > 0 && breakRisk <= maxSellRiskPts * 2) {
          // ── Condition 2: No nearby support within 1R below entry ──
          // 2a) 20 EMA support (already guaranteed to be at/above close by check above)
          const brkEMASupport =
            candleEMA != null &&
            candleEMA < candleClose &&
            candleClose - candleEMA < breakRisk;

          // 2b) Previous Day Low support
          const brkPrevDayLowSupport =
            prevDayLow > 0 &&
            prevDayLow < candleClose &&
            candleClose - prevDayLow < breakRisk;

          // 2c) Intraday swing low support — scan prior candles for lows that are
          //     below entry but within 1R (price likely to stall there before T1)
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
            v1DiagLog('[V1-FCL-SKIP]', {
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
          v1DiagLog('[V1-FCL-SKIP]', {
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

      // Uptrend guard: scan every candle from session start to now.
      // If ≥60% of candles closed above the 20 EMA, the EMA is acting as
      // support (price has been staying above or briefly dipping and recovering).
      // Selling into such a market is low-probability — skip.
      // No hardcoded lookback: uses actual price-vs-EMA relationship all session.
      {
        let aboveEMA = 0;
        let counted = 0;
        for (let k = 0; k <= i; k++) {
          const ema = emaValues[k];
          if (ema == null) continue;
          counted++;
          if (candles[k].close > ema) aboveEMA++;
        }
        // Exception: Day-High Zone Rejection is valid even in an uptrend —
        // price reaching the session high and getting rejected there is bearish
        // regardless of the overall EMA trend direction.
        if (counted >= 3 && aboveEMA / counted > 0.6 && !nearDayHighZone) {
          continue;
        }
      }

      // Resistance level proximity
      const nearEMA = Math.abs(candleHigh - candleEMA) <= marginPoints;
      const nearYesterdayHigh =
        yesterdayHigh > 0 &&
        Math.abs(candleHigh - yesterdayHigh) <= marginPoints;
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

      // EMA touch rejection: high reached EMA zone AND candle closed below EMA AND below its open.
      // isRedCandle (close < open) is required — a green candle touching EMA but closing green
      // shows buyers stepping in, not a rejection. Computed before candle-type gate so it can bypass it.
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
      const actualLowerWick =
        Math.min(actualOpen, actualClose) - actualEntry.low;
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
          ? swingHighs.find(
              (s) => Math.abs(candleHigh - s.price) <= marginPoints,
            )?.price
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
        // If EMA is the resistance, high must actually reach within half-margin of EMA
        // (prevents firing when price is still far below a declining EMA)
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

      // EMA support check: look back at the last 10 candles. For each candle
      // that touched the EMA (low or close within marginPoints), if the *next*
      // candle was green (bounced), EMA behaved as support there.
      // If ≥2 such bounces exist, EMA is clearly acting as support for this
      // session → a current EMA touch should NOT generate a sell signal.
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
            // Bounce = next candle was green (buyers stepped in at EMA)
            if (nextKC && nextKC.close > nextKC.open) {
              emaBounceCount++;
            }
          }
        }
        if (emaBounceCount >= 2) emaActsAsSupport = true;
      }

      // 20 EMA Rejection — bearish structure validation (all three must pass):
      //
      // Check 1: Price already below EMA.
      //   At least 3 of the last 6 candles closed below the EMA before this retrace.
      //   Ensures we are selling a known downtrend pull-back, not a first dip.
      let emaBearishBelowCount = 0;
      const emaBearLookback = Math.min(6, i);
      for (let k = i - emaBearLookback; k < i; k++) {
        const kEMA = emaValues[k];
        if (kEMA != null && candles[k].close < kEMA) emaBearishBelowCount++;
      }
      const emaBearishStructure = emaBearishBelowCount >= 3;

      // Check 2: First-cross-below filter.
      //   If the 2 candles immediately before this one BOTH closed above the EMA,
      //   the current touch is a first break downward (price was up, then dropped).
      //   This could be a temporary retracement before price moves up again → skip.
      //   Only fire after price has been below the EMA, retraced back, and is now
      //   getting rejected for a second (confirmed) time.
      const emaRecentAboveCount = [i - 1, i - 2].reduce((cnt, k) => {
        if (k < 0) return cnt;
        const kEMA = emaValues[k];
        return kEMA != null && candles[k].close > kEMA ? cnt + 1 : cnt;
      }, 0);
      const emaIsFirstCrossBelow = emaRecentAboveCount >= 2;

      // Check 3: Lower highs forming (confirms a downtrending/weakening retrace).
      //   At least one of the two consecutive prior-candle high pairs is declining.
      //   Uses candles i−3 → i−2 → i−1 to exclude the current retrace candle itself.
      const emaLowerHighsForming =
        i >= 3 &&
        (candles[i - 1].high < candles[i - 2].high ||
          candles[i - 2].high < candles[i - 3].high);

      // Already computed above as emaTouchRejection — referenced here for signal reason.
      // Suppressed when:
      //   • EMA is acting as support (confirmed by multiple recent bounces), OR
      //   • bearish structure hasn't been established yet (price not previously below EMA), OR
      //   • this looks like a first cross (not a confirmed re-test rejection), OR
      //   • higher highs suggest the retrace is in a strong environment.
      const bearishOpenAtEMA =
        emaTouchRejection &&
        !emaActsAsSupport &&
        emaBearishStructure &&
        !emaIsFirstCrossBelow &&
        emaLowerHighsForming;

      // Day-high zone rejection
      const emaForDHR = emaValues[i];
      // Pick the actual resistance level being tested so the EMA-distance rule
      // works correctly for prevDayHigh and prevDayClose zones, not just session high.
      const dhrResistanceLevel = nearDayHighZone
        ? confirmedResZone
        : nearYesterdayHigh
          ? yesterdayHigh
          : prevDayClose;
      const emaFarBelowZone =
        emaForDHR != null && dhrResistanceLevel - emaForDHR > marginPoints * 2;
      const rsiForDHR = rsiValues[i];
      const rsiNotOversold = rsiForDHR == null || rsiForDHR > 35;
      // Rejection candle types for Day High Zone Rejection:
      // - Long upper wick (long upper wick = price tried to push higher but got rejected)
      // - Bearish engulfing (strong reversal signal at resistance)
      // - Strong bearish close (large red body)
      const dhrLongUpperWick =
        upperWick > candleBody * 1.2 || upperWick > totalRange * 0.4;
      const dhrBearishEngulfing =
        !!prev1 &&
        prev1.close > prev1.open &&
        candleOpen >= prev1.close &&
        candleClose < prev1.open &&
        isRedCandle;
      const dhrStrongBearishClose =
        isRedCandle && candleBody > totalRange * 0.5;
      const dhrRejectionCandle =
        dhrLongUpperWick ||
        dhrBearishEngulfing ||
        dhrStrongBearishClose ||
        isDoji;

      // Resistance zones for Day High Rejection: session high zone, prev day high, prev day close
      const nearAnyDayHighResistance =
        nearDayHighZone || nearYesterdayHigh || nearPrevDayClose;

      // EMA position relative to entry (close) for DHR:
      // - EMA above entry → EMA is overhead resistance alongside the zone → valid DHR context
      // - EMA far below entry (>= marginPoints) → clear room for price to fall to targets → valid
      // - EMA slightly below entry (< marginPoints) → EMA acts as dynamic support right in the
      //   path of the trade; the underlying is likely in an uptrend (PE in falling-Nifty = rising)
      //   so the 20 EMA is a rising support floor — no room to fall after entry → block
      const emaNotSupportAtEntry =
        emaForDHR == null ||
        emaForDHR >= candleClose || // EMA at/above entry = overhead resistance = OK
        candleClose - emaForDHR >= marginPoints; // EMA far enough below = room = OK

      // ── New engine helpers ─────────────────────────────────────────────────
      // P2b: EMA Fake Break Rejection — bull trap: high pierces EMA but close fails below
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

      // P3: Broken First Candle Low Retest Rejection
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

      // P4: Lower High Breakdown
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

      // ── Shared rejection pattern label (used by P1 zone branches) ─────────
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

      // Any valid P1 rejection candle pattern
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
      let useRetestSL = false; // use structural SL for broken-support retest

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
      else if (hasStrongRejection)
        signalReason = 'Strong Rejection @ Resistance';

      if (!signalReason) {
        v1DiagLog('[V1-SKIP]', {
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

      // First-candle-high gate (no chasing unless RSI > 60 or it's a clean EMA touch rejection)
      const candleRSI = rsiValues[i];
      if (
        actualClose > candles[0].high &&
        !(candleRSI != null && candleRSI > 60) &&
        !emaTouchRejection
      )
        continue;

      // RSI quality gate for non-DHR SELL signals:
      // Require RSI >= minSellRsi (default 45) — the CE must still be at a
      // neutral/elevated level. A low RSI means the option has already sold
      // off heavily; selling into further weakness has elevated whipsaw risk.
      // DHR is exempt: it has its own RSI > 35 not-oversold gate.
      // bearishOpenAtEMA (emaTouchRejection) is also exempt — price explicitly
      // touching the 20 EMA and getting rejected is the cleanest structural sell
      // signal; RSI being low after a morning sell-off does NOT invalidate it.
      if (
        !isDayHighZoneRejection &&
        !bearishOpenAtEMA &&
        candleRSI != null &&
        candleRSI < minSellRsi
      )
        continue;

      // Swing-high-aware SL:
      // 1. Look back up to 10 candles for a session swing high that is:
      //    - above the entry (actualClose)
      //    - below entry + 30 (within the fixed-fallback range)
      //    - at least 8 pts above entry (avoids hair-trigger SL from tiny wicks)
      // 2. If found, SL = swingHigh + 2 (structurally meaningful)
      // 3. Otherwise fall back to fixed entry + 30 (consistent with Signal UI)
      // Target is always 2× risk for 1:2 RRR.
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
        // Broken support retest: SL above the retested structural level
        stopLoss = Math.max(candleHigh, firstCandleLow) + 2;
        risk = stopLoss - actualClose;
      } else if (candidateSwings.length > 0) {
        // Most recent qualifying swing high
        const nearestSwing = candidateSwings.reduce((a, b) =>
          a.index > b.index ? a : b,
        );
        stopLoss = nearestSwing.price + 2;
        risk = stopLoss - actualClose;
      } else {
        // Fallback: fixed 30 pt SL
        stopLoss = actualClose + FALLBACK_SL_PTS;
        risk = FALLBACK_SL_PTS;
      }
      // Non-DHR patterns: cap at maxSellRiskPts (default 25) — wide SLs in a
      // choppy market lead to oversized losses on whipsaws.
      // DHR keeps its own fixed 40 pt ceiling (structural zone may be distant).
      if (risk > (isDayHighZoneRejection ? 40 : maxSellRiskPts)) continue;

      // SuperTrend trend context filter:
      // trend='up'  → ST line below price = market is in an UPTREND.
      //               SELL signals are counter-trend and low probability UNLESS price
      //               is at a strong structural reversal:
      //                 • dayHighZoneRejection: key day-high resistance (valid even in uptrend)
      //                 • bearishOpenAtEMA: price just explicitly rejected from EMA (EMA = resistance)
      //               Everything else (momentumSlowing, earlyRejection, shootingStar, etc.)
      //               in a bullish-ST context is a bounce off support, not a reversal — skip.
      // trend='down' → ST line above price = market is in a DOWNTREND → SELL is with-trend → allow.
      // Generic: works for any instrument (index, stock, option underlying).
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

      // EMA support floor: if EMA is below entry and closer than 1× risk,
      // price will likely stall at the EMA before reaching T1 — no 1:1 chance.
      // Applies to ALL patterns including Day-High Zone Rejection:
      // a day-high rejection is only worth taking if there is at least 1R of
      // room between entry and the EMA (i.e. price can retrace to EMA and we
      // still hit T1). The one exception is bearishOpenAtEMA where entry IS
      // the EMA — no floor check needed there.
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

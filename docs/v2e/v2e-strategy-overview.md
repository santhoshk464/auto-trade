# Day Selling V2 Enhanced (V2E) — Strategy Logic & Overview

`detectDaySellSignalsV2Enhanced`

---

## Table of Contents

1. [Strategy Summary](#1-strategy-summary)
2. [Function Signature & Inputs](#2-function-signature--inputs)
3. [Signal Output Shape](#3-signal-output-shape)
4. [Configuration Reference](#4-configuration-reference)
5. [Internal Helpers](#5-internal-helpers)
6. [Market State Classification](#6-market-state-classification)
7. [Session Activation](#7-session-activation)
8. [Rolling High Tracking](#8-rolling-high-tracking)
9. [Setups A – E](#9-setups-a--e)
   - [Setup A — First Candle Low Break](#setup-a--first-candle-low-break)
   - [Setup B — Trend Day High Rejection (DHR)](#setup-b--trend-day-high-rejection-dhr)
   - [Setup B2 — Sweep / Transition DHR](#setup-b2--sweep--transition-dhr)
   - [Setup C — Multi-candle EMA Rejection](#setup-c--multi-candle-ema-rejection)
   - [Setup D — Sideways Range Logic](#setup-d--sideways-range-logic)
   - [Setup E — Liquidity Sweep / Failed Breakout Rejection](#setup-e--liquidity-sweep--failed-breakout-rejection)
10. [Armed Setup System](#10-armed-setup-system)
11. [2-Candle Pending Sequence Queue](#11-2-candle-pending-sequence-queue)
12. [Zone Memory](#12-zone-memory)
13. [Duplicate Suppression](#13-duplicate-suppression)
14. [Sideways Detection](#14-sideways-detection)
15. [Inherited Bearish Bias](#15-inherited-bearish-bias)
16. [Diagnostic Logs](#16-diagnostic-logs)
17. [Behavior by Market State](#17-behavior-by-market-state)
18. [Signal Reason Labels](#18-signal-reason-labels)
19. [ATR Usage](#19-atr-usage)
20. [Data Flow Summary](#20-data-flow-summary)

---

## 1. Strategy Summary

V2E is a **5-minute intraday sell-signal detection strategy** for Indian index options (e.g. NIFTY, BANKNIFTY puts). It builds on V2 by adding:

| Enhancement | Description |
|---|---|
| Market-state classification | Classifies each candle as Bearish Trend / Sideways / Reversal Transition / Bullish-Neutral |
| Setup B2 — Sweep DHR | Reversal entries at failed breakouts without requiring full bearish EMA context |
| Multi-candle EMA rejection (Setup C) | Confluence scoring across a 3-candle look-back window |
| First-hour range edge logic | Sideways-mode setups at the boundaries of the first-hour range |
| Liquidity sweep detection (Setup E) | Score-based failed-breakout sells above any important reference high |
| Zone memory + rearm | Prevents signal spam from a level; zones rearm once price moves away |
| 2-candle pending sequence queue | Tracks multiple concurrent DHR/sweep setups that need confirmation on the next candle |
| Armed setup system | Stores setups that did not immediately trigger; fires when candle LOW later breaks trigger level |
| Inherited bearish bias | Allows B2 and E setups when the current session looks like a pullback into a broader bearish structure |

**Scan window**: 9:30 AM – 2:30 PM IST  
**Candle granularity**: 5 minutes  
**Instruments**: any Indian index option / underlying (general, not hardcoded)

---

## 2. Function Signature & Inputs

```ts
detectDaySellSignalsV2Enhanced(params: {
  candles:       any[];                              // 5-min OHLC array for the session
  ema20Values:   (number | null)[];                  // Pre-computed 20-period EMA per candle
  ema8Values:    (number | null)[];                  // Pre-computed 8-period EMA per candle
  rsiValues:     (number | null)[];                  // Pre-computed RSI per candle
  swingHighs:    Array<{ price: number; index: number }>; // Recent swing highs
  yesterdayHigh: number;                             // Previous day's high
  prevDayLow?:   number;                             // Previous day's low (default 0)
  prevDayClose?: number;                             // Previous day's close (default 0)
  marginPoints:  number;                             // Instrument tick granularity / proximity buffer
  maxSellRiskPts?: number;                           // Max allowed SL distance in points (default 30)
  realtimeMode?: boolean;                            // Scan only last 2 candles instead of full session
  instrumentName?: string;                           // Used in diagnostic logs
  superTrendData?: Array<...>;                       // Not used in current V2E logic
})
```

---

## 3. Signal Output Shape

Each detected signal is returned in this shape:

```ts
{
  candleIndex:            number;       // Index within the candle array
  actualCandleIndex:      number;       // Same as candleIndex
  candleTime:             string;       // e.g. "11:45 AM" (IST)
  candleDate:             Date;
  unixTimestamp:          number;       // IST epoch (UTC + 19800 s)
  reason:                 string;       // Human-readable setup label
  entryPrice:             number;       // candleClose at signal candle
  stopLoss:               number;       // Above candle high or reference level
  risk:                   number;       // stopLoss − entryPrice
  candleRSI:              number | null;
  isDayHighZoneRejection: boolean;
  nearDayHighZone:        boolean;
  isNearDailyHigh:        boolean;
}
```

---

## 4. Configuration Reference

All parameters are inlined in the `cfg` object at the top of the function. Defaults below.

### 4.1 Session Activation

| Field | Default | Description |
|---|---|---|
| `requireOpenBelow20Ema` | `true` | Session activates only if first candle open < EMA20 |
| `allowDelayedActivation` | `true` | Allow activation mid-session |
| `delayedActivationLookback` | `6` | Candles to examine for delayed activation |
| `delayedActivationBelowCloseCount` | `4` | Required below-EMA closes for delayed activation |
| `delayedActivationEmaSlopeThreshold` | `0` | Max EMA slope allowed at delayed activation (0 = flat/down) |
| `lateBearishActivationEnabled` | `true` | Allow late-session activation after EMA loss |
| `lateBearishActivationLookback` | `5` | Look-back window for late activation |
| `lateBearishActivationBelowCloses` | `3` | Required below-EMA closes in late activation window |

### 4.2 EMA Resistance Context

| Field | Default | Description |
|---|---|---|
| `emaResistanceLookback` | `6` | Candles checked for bearish EMA context |
| `minBelowEmaCloses` | `3` | Required closes below EMA20 for bearish EMA context |
| `maxAllowedAboveEmaCloses` | `3` | Max tolerated closes above EMA20 in the window |
| `emaSlopePeriod` | `3` | Periods back to measure EMA slope direction |

### 4.3 Sideways Detection

| Field | Default | Description |
|---|---|---|
| `sidewaysEmaGapPct` | `0.004` | Max EMA8/EMA20 gap ratio to count as "narrow" |
| `sidewaysLookback` | `8` | Look-back window for sideways check |
| `sidewaysCrossings` | `2` | Min EMA crossings to classify as sideways |

### 4.4 First-Hour Range

| Field | Default | Description |
|---|---|---|
| `firstHourCandles` | `12` | 5-min candles in first hour (9:15–10:15) |
| `enableFirstHourLowBreakdown` | `false` | Opt-in for Setup D3 (FHL continuation) |

### 4.5 Sweep Logic

| Field | Default | Description |
|---|---|---|
| `sweepBufferPts` | `2` | Minimum pts above reference to qualify as a sweep |
| `sweepMaxAboveRefPts` | `15` | Max sweep excess in points |
| `sweepMaxAboveRefAtrMult` | `0.8` | Max sweep excess as ATR multiple |
| `sweepReturnRequired` | `true` | Candle must close back below swept level |

### 4.6 Multi-Candle EMA Rejection (Setup C)

| Field | Default | Description |
|---|---|---|
| `emaRejectionWindow` | `3` | Candles back to search for EMA event |
| `minEmaRejectionScore` | `2` | Minimum confluence score to consider an EMA rejection |
| `sidewaysAllowsRangeEdgeSells` | `true` | Allow Setup C in sideways near range edges |
| `sidewaysRangeEdgeTolMult` | `2` | Range-edge proximity = `marginPoints × this` |

### 4.7 Confluence Scoring Thresholds

| Field | Default | Description |
|---|---|---|
| `minReversalScore` | `4` | Min score for Setup D2 / Setup E |
| `sweepDhrMinScore` | `4` | Min score for Setup B2 |

### 4.8 Zone Memory

| Field | Default | Description |
|---|---|---|
| `dupSuppressZonePct` | `0.0015` | Price proximity (%) to suppress duplicate signals |
| `dupCooldownCandles` | `5` | Min candle gap between signals |
| `zoneRearmPct` | `0.003` | Price move-away fraction needed to rearm a zone |
| `zoneRearmCandles` | `8` | Candle cooldown before zone can rearm |

### 4.9 Candle Quality

| Field | Default | Description |
|---|---|---|
| `candleBodyRatio` | `0.55` | Body/range ratio for strong-bearish candle |
| `sidewaysBreakdownStrictMode` | `true` | Setup A in sideways requires full bearish EMA context |

### 4.10 DHR / Sweep Trigger Quality

| Field | Default | Description |
|---|---|---|
| `dhrUpperWickRatio` | `0.28` | Min upper-wick/range for valid DHR rejection wick |
| `dhrWeakCloseRatio` | `0.52` | Close in lower X fraction of range = weak (DHR/sweep) |
| `dhrMinBodyRatioForDirect` | `0.22` | Min bearish body/range fraction for DHR direct trigger |
| `triggerCandleBodyRatio` | `0.32` | Min body/range ratio for a strong direct-entry candle |
| `triggerCandleCloseLowPct` | `0.45` | Close must be in lower portion of range for direct entry |

### 4.11 Armed Setup Windows

| Field | Default | Description |
|---|---|---|
| `trendArmedMaxCandles` | `4` | BEARISH_TREND — expire window (candles) |
| `transitionArmedMaxCandles` | `6` | BEARISH_REVERSAL_TRANSITION — expire window |
| `sidewaysArmedMaxCandles` | `5` | SIDEWAYS_RANGE — expire window |
| `neutralArmedMaxCandles` | `3` | BULLISH_OR_NEUTRAL — expire window |
| `b2ArmedExtraCandles` | `0` | B2 offset on top of market-state base |
| `cArmedExtraCandles` | `-1` | C: 1 candle shorter than base |
| `dArmedExtraCandles` | `1` | D: 1 extra candle |
| `eArmedExtraCandles` | `0` | E: base window |
| `armedInvalidateOnCloseAboveHigh` | `true` | Expire if candle closes above signal candle high |
| `armedInvalidationBuffer` | `1` | Points tolerance above signal high |
| `armedInvalidateEmaReclaim` | `true` | C only: expire if price clearly reclaims EMA |
| `armedSetupTriggerBuffer` | `1` | Fixed pts below signal-candle low as trigger level |
| `armedSetupTriggerBufferAtrMult` | `0.1` | ATR fraction for trigger buffer |
| `armedTriggerNeedConfirm` | `true` | Require secondary bearish confirmation on low break |

### 4.12 Direct vs Armed Entry Thresholds

| Field | Default | Description |
|---|---|---|
| `directEntryMinScore` | `6` | Min score for non-trend direct close-entry |
| `sweepDirectMinScore` | `5` | Min score for direct B2/E entry with moderate sweep trigger |
| `b2TrendDirectMinScore` | `4` | Min b2Score for direct B2 in BEARISH_TREND (easier) |
| `b2TransitionDirectMinScore` | `6` | Min b2Score for direct B2 in non-trend (stricter) |
| `cTrendDirectMinScore` | `4` | Min cScore for direct C in BEARISH_TREND |
| `cTransitionDirectMinScore` | `5` | Min cScore for direct C in non-trend |
| `cArmMinScore` | `3` | Min cScore to arm a C setup (non-trend only) |

### 4.13 2-Candle Sequence Confirmation

| Field | Default | Description |
|---|---|---|
| `seqConfirmWindowCandles` | `3` | Candles after setup candle allowed for confirmation |
| `seqConfirmBelowMidpoint` | `true` | Confirm candle must close below setup candle midpoint |
| `seqConfirmBelowSetupLow` | `false` | Stricter: confirm candle closes below setup candle low |
| `seqSetupMinUwickRatio` | `0.18` | Min upper-wick/range to qualify as DHR/sweep setup candle |
| `seqDuplicateZonePts` | `5` | Zone proximity tolerance (raw pts) for pending-sequence de-dup |

### 4.14 Setup B Expanded Reference Family

| Field | Default | Description |
|---|---|---|
| `dhrIncludeFirstHourHigh` | `true` | Add 1st-hour high to Setup B reference set |
| `dhrIncludeSwingHighs` | `true` | Add recent swing highs to Setup B reference set |

### 4.15 Inherited Bearish Bias

| Field | Default | Description |
|---|---|---|
| `inheritedBiasEnabled` | `true` | Master switch |
| `prevSessionBearishLookback` | `15` | Early-session candles used to score prior bearishness |
| `prevSessionMinBelowEmaRatio` | `0.55` | Fraction of early candles that must be below EMA |
| `prevSessionMinScore` | `4` | Threshold on 0–7 scoring scale |
| `pullbackMaxAboveEmaPct` | `0.006` | If close > EMA by > this → likely real reversal (not pullback) |
| `pullbackMaxAtrMove` | `1.5` | If session up-move > N × ATR → likely real reversal |
| `setupBAllowInheritedContinuation` | `true` | Allow Setup B with inherited bearish bias path |

---

## 5. Internal Helpers

| Helper | Purpose |
|---|---|
| `getCandleTs(c)` | Convert candle date to IST epoch |
| `getCandleTimeStr(c)` | Format candle time as "HH:MM AM/PM" |
| `isStrongBearish(c)` | Body/range ≥ 0.55 and red candle |
| `isBearishRejection(c)` | Upper wick/range ≥ 0.35 and red candle |
| `isSidewaysAt(i)` | Sideways detection at candle index i |
| `isBearishEmaContext(i, ema20)` | Master EMA resistance filter |
| `checkDelayedActivation(i)` | Check delayed activation criteria |
| `checkLateBearishActivation(i)` | Check late bearish activation criteria |
| `makeZoneKey(type, level)` | Create zone memory key (snapped to marginPoints) |
| `isZoneRecentlyUsed(key, i)` | Check if zone was used within cooldown window |
| `markZoneUsed(key, i, level)` | Record zone as used |
| `canRearmZone(key, price)` | Check if price has moved away enough to rearm zone |
| `getMarketState(i, ema20, sideways, bearishEma)` | Classify market state for candle i |
| `isDuplicate(price, i)` | Global duplicate suppression check |
| `buildSignal(i, reason, entry, sl, ...)` | Construct signal output object |
| `isStrongBearishTriggerCandle(c)` | Strong direct-entry quality: body + close-near-low |
| `isValidDhrSetupCandle(c, zone)` | 2-candle setup: touched zone, wick or weak close |
| `isValidDhrConfirmationCandle(c, mid, low)` | 2-candle confirm: close < midpoint or break low |
| `isValidSweepSetupCandle(c, ref)` | 2-candle setup: swept level and closed back below |
| `isValidSweepConfirmationCandle(c, mid, low)` | 2-candle confirm for sweep type |
| `isValidDhrTriggerCandle(c, zone)` | Relaxed DHR trigger: wick or body + weak close |
| `isValidSweepTriggerCandle(c)` | Relaxed sweep/failure trigger |
| `reversalSL(refHigh)` | Adaptive SL: `refHigh + max(2, ATR × 0.3)` |
| `getArmedExpiryWindow(type, state)` | Candle-count expiry window by setup type + market state |
| `armSetup(...)` | Add or replace armed sell setup |
| `hasActiveArmedSetupOfTypeNearby(type, zoneRef, i)` | Anti-rearm anti-duplicate check for armed setups |
| `isArmedSetupInvalidated(armed, candle, ema20)` | Structure-break expiry for armed setups |
| `hasArmedSetupGoneStale(armed, i, low)` | ATR-based stale check (optional, off by default) |
| `shouldExpireArmedSetup(armed, i, candle, ema20)` | Unified expiry decision (time + struct + stale) |
| `scorePreviousSessionBearishness()` | 0–7 score of prior session bearish structure |
| `isCurrentMoveLikelyPullback(i, ema20)` | Validates that the current up-move is corrective, not impulsive |
| `hasSimilarPendingSequence(seqType, zone)` | De-dup check for pending sequence queue |
| `addPendingSequence(seq)` | Push to pending sequence queue (with de-dup) |

---

## 6. Market State Classification

Called once per candle via `getMarketState(i, ema20, sideways, bearishEma)`.

| State | Condition |
|---|---|
| `SIDEWAYS_RANGE` | `isSidewaysAt(i) === true` |
| `BEARISH_TREND` | `bearishEma === true AND candleClose < ema20` |
| `BEARISH_REVERSAL_TRANSITION` | Late-activation conditions met (≥ 3 closes below EMA in last 5 candles AND EMA flat or down) |
| `BULLISH_OR_NEUTRAL` | None of the above |

Setups B, C, D require non-bullish context.  
Setups B2 and E can fire in `BULLISH_OR_NEUTRAL` when `inheritedBearishBias` is active.

---

## 7. Session Activation

The strategy is **blocked entirely** until one of three activation paths is satisfied:

### Path 1 — Normal
First candle open is below EMA20 at session start.

### Path 2 — Delayed
Within a look-back window of 6 candles at least 4 closes are below EMA20, and the EMA slope is flat or down.

### Path 3 — Late Bearish
In the last 5 candles, at least 3 closes are below EMA20, and EMA is not rising.

> Once any path activates, all three paths are re-checked at every candle so activation cannot be lost.

---

## 8. Rolling High Tracking

```
// BEFORE evaluating candle i:
prevRollingHigh = rollingHigh           // snapshot prior to this candle
intradayDayHigh = prevRollingHigh       // used in all setup evaluations

// AFTER evaluation:
if (candle.high > rollingHigh) rollingHigh = candle.high
```

This ensures a candle that makes a **new intraday high** is tested against the previously known high, not against itself — preventing false DHR signals on the very candle that sets the high.

---

## 9. Setups A – E

### Setup A — First Candle Low Break

**Label**: `V2E: 1st Candle Low Break (${pattern})`  
**Fires**: once per session (guarded by `firstCandleLowBreakFired` flag)  

**Break level**:
- If `prevDayLow` is within `marginPoints × 2` of `firstCandleLow` → break level = `min(firstCandleLow, prevDayLow) - 1`
- Otherwise: `firstCandleLow`

**Candle must be one of**:

| Pattern | Condition |
|---|---|
| Large Bearish Body | `body > range × 0.4` |
| Bearish Engulfing | Prior candle green; current opens ≥ prior close and closes < prior open |
| Strong Close Near Low | `(close - low) / range < 0.20` |

**Blocked if**:
- EMA20 < current close (EMA is acting as support below price)
- Sideways mode + `sidewaysBreakdownStrictMode` + no bearish EMA context
- A nearby support level exists within the risk distance
- Breakdown candle is not a `isStrongBearishTriggerCandle`

**Entry**: Direct close-entry only (no arming for Setup A)  
**SL**: `firstCandleLow + 2`  
**Risk cap**: `maxSellRiskPts × 2`

---

### Setup B — Trend Day High Rejection (DHR)

**Label**: `V2E: Day High Rejection (${pattern} @ ${zone})`  
**Active paths**:
- **Strict**: `bearishEma === true AND marketState !== BULLISH_OR_NEUTRAL`
- **Inherited**: `inheritedBearishBias === true AND isCurrentMoveLikelyPullback()`

**Reference zones** (candle high must be within `marginPoints × 1.5`):

| Zone | Condition |
|---|---|
| Intraday rolling high | `intradayDayHigh > 0` |
| Previous day's high | `yesterdayHigh > 0` |
| Previous day's close | `prevDayClose > 0` |
| First candle's high | `firstCandleHigh > 0 AND i > 3` |
| First-hour high | `dhrIncludeFirstHourHigh AND i ≥ firstHourCandles` |
| Recent swing high | `dhrIncludeSwingHighs` — up to 3 most recent swing highs |

**Candle quality** (`isValidDhrTriggerCandle`):
- Upper wick/range ≥ `dhrUpperWickRatio (0.28)`, OR
- Bearish body/range ≥ `dhrMinBodyRatioForDirect (0.22)`, OR
- Doji (body < range × 0.12)
- Close must be in lower `dhrWeakCloseRatio (0.52)` fraction of range
- Close must be below zone level + marginPoints

**Additional filter (strict path)**: `ema20 >= candleClose`

**Entry** (direct): `isValidDhrTriggerCandle` passed → direct close-entry  
**Entry (2-candle)**: if trigger not strong enough → `addPendingSequence` (DHR type)

**SL**: `candleHigh + 2`

**Patterns reported**:
- Bearish Engulfing / Strong Bearish Close / Long Upper Wick / Doji / Weak Close

---

### Setup B2 — Sweep / Transition DHR

**Label**: `V2E: Sweep Day High Rejection (${zone})`  
**Active when**: `marketState === BEARISH_REVERSAL_TRANSITION OR BEARISH_TREND OR (inheritedBearishBias AND isCurrentMoveLikelyPullback())`

**Reference zones**:

| Zone | Condition |
|---|---|
| Intraday rolling high | always included |
| Previous day's high | always included |
| First-hour high | only after `firstHourCandles` have passed |

**Entry condition**: Candle must reach or sweep the reference level AND close back below it (`candleClose < ref.level`).

**Confluence scoring**:

| Condition | Score |
|---|---|
| Base: near key high + closed below | +2 |
| Actual sweep above level (`> sweepBufferPts`) | +1 |
| Red candle | +1 |
| EMA20 overhead (`ema20 > close`) | +2 |
| Upper wick > 40% of range | +1 |
| Body > 30% of range + red | +1 |
| Next candle confirms bearish follow-through | +2 |

Fires when `b2Score >= sweepDhrMinScore (4)`.

**State-aware direct-entry threshold**:

| Market State | Direct Entry Rule |
|---|---|
| `BEARISH_TREND` | Red candle + `b2Score >= b2TrendDirectMinScore (4)` |
| Non-trend | `isValidSweepTriggerCandle()` + `b2Score >= b2TransitionDirectMinScore (6)` |

If direct threshold not met → **arm** setup AND additionally **push to pending sequence queue** (SWEEP type) if the setup candle qualifies.

**SL**: `reversalSL(candleHigh)` = `candleHigh + max(2, ATR × 0.3)`

---

### Setup C — Multi-Candle EMA Rejection

**Label**: `V2E: EMA Rejection (${pattern})`  

**Active when**:
- Normal: `!sideways AND bearishEma AND marketState !== BULLISH_OR_NEUTRAL`
- Sideways range-edge: `sideways AND cfg.sidewaysAllowsRangeEdgeSells AND ema20 > close AND candle near first-hour-high or intraday-high`

**EMA event detection** (searches `emaRejectionWindow (3)` candles back, oldest first):

| Pattern | Detection |
|---|---|
| Direct Reject | `close < open`, `|high - EMA20| ≤ marginPoints`, `close < EMA20` |
| Wick Above EMA | `high > EMA20 + marginPoints × 0.25`, `close < EMA20`, upper wick ≥ 35% of range |
| Fake Reclaim Fail | Prior candle closed above EMA20 (green); next candle closes back below EMA20 |
| Lower High Under EMA | Current candle: lower high than prev, both below EMA20, red candle |

**Confirmation on current candle**: `candleClose < ema20 AND isRedCandle`

> If the EMA event candle itself is strong (wick ≥ 40% or body ≥ 50%), the current candle does not need to be perfectly bearish — a partial confirmation is accepted.

**Confluence scoring**:

| Condition | Score |
|---|---|
| Direct Reject / Fake Reclaim Fail / Wick Above | +2 |
| Lower High Under EMA | +1 |
| EMA sloping down (vs 3 candles ago) | +1 |
| EMA not acting as support (< 2 bounces in last 10) | +1 |
| EMA8 < EMA20 | +1 |
| Event candle itself is strong | +1 |
| Current candle also confirms (bearish close) | +1 |

Fires when `cScore >= minEmaRejectionScore (2)`.

**State-aware direct-entry threshold**:

| Market State | Direct Entry Rule |
|---|---|
| `BEARISH_TREND` | `confirmedNow AND cScore >= cTrendDirectMinScore (4)` |
| Non-trend | `isStrongBearishTriggerCandle() AND confirmedNow AND cScore >= cTransitionDirectMinScore (5)` |

If direct threshold not met → **arm** (with anti-rearm guard: one active armed C per EMA zone; recently-expired C zones have a cooldown of `cRearmCooldownCandles (8)` unless price has moved enough).

**SL**: `reversalSL(max(candleHigh, eventCandleHigh))`

---

### Setup D — Sideways Range Logic

**Active when**: `isSidewaysAt(i) === true`

#### D1 — First-Hour High Rejection

**Label**: `V2E: 1st Hour High Rejection (sideways)`

- Candle high within `max(marginPoints, ATR × 0.3)` of first-hour high
- Candle shows `isBearishRejection()` (upper wick ≥ 35% + red) or `isStrongBearish()`
- Only fires once per first-hour-high zone until zone rearms

**Entry**: Direct if `isStrongBearishTriggerCandle()`, otherwise **arm**  
**SL**: `max(firstHourHigh, ema20) + marginPoints × 0.5` (EMA overhead check included)

#### D2 — First-Hour High Sweep Rejection

**Label**: `V2E: 1st Hour High Sweep Rejection (sideways)`

- Candle sweeps above first-hour high by ≥ `sweepBufferPts` points
- Closes back below first-hour high
- Sweep excess ≤ `max(sweepMaxAboveRefPts (15), ATR × 0.8)`

**Scoring**:

| Condition | Score |
|---|---|
| Base: sweep + closed below | +3 |
| Red candle | +1 |
| EMA20 overhead | +2 |
| Upper wick > 40% | +1 |
| Body > 30% + red | +1 |

Fires when `score >= minReversalScore (4)`.

**Entry**: Direct if `isStrongBearishTriggerCandle() AND score >= directEntryMinScore (6)`, otherwise **arm**  
**SL**: `reversalSL(candleHigh)`

#### D3 — First-Hour Low Breakdown *(opt-in, off by default)*

**Label**: `V2E: 1st Hour Low Breakdown (sideways continuation)`

- `enableFirstHourLowBreakdown: true` is required
- Only fires after D1 or D2 has triggered (`firstHourHighZoneUsed === true`)
- Close breaks below first-hour low + red candle

**Entry**: Direct  
**SL**: `firstHourLow + marginPoints`

---

### Setup E — Liquidity Sweep / Failed Breakout Rejection

**Label**: `V2E: Liquidity Sweep Rejection (${zone})`

**Active when**: `marketState !== BULLISH_OR_NEUTRAL OR (inheritedBearishBias AND isCurrentMoveLikelyPullback())`

**Reference highs tested**:

| Zone | Condition |
|---|---|
| Intraday rolling high | always |
| Previous day's high | always |
| First candle's high | only after candle 3 |
| First-hour high | only after `firstHourCandles` have passed |
| Up to 3 most recent swing highs | within `sidewaysLookback × 2` candles |

**Entry condition**: Candle high sweeps above reference by ≥ `sweepBufferPts (2)` AND closes back below (if `sweepReturnRequired`).  
Sweep excess must be ≤ `max(sweepMaxAboveRefPts, ATR × 0.8)`.

**Confluence scoring**:

| Condition | Score |
|---|---|
| Base: swept a key high | +3 |
| Closed back below swept level | +2 |
| Red candle | +1 |
| EMA20 overhead | +2 |
| Upper wick > 40% | +1 |
| Body > 30% + red | +1 |
| Next candle bearish follow-through | +2 |

Fires when `score >= minReversalScore (4)`.

Only one sweep signal per candle — **first qualifying reference wins**.

**Entry**: Direct if `isValidSweepTriggerCandle() AND score >= sweepDirectMinScore (5)`, otherwise **arm** AND optionally **push to pending sequence queue** (SWEEP type).  
**SL**: `reversalSL(candleHigh)`

---

## 10. Armed Setup System

Setups that detect a valid rejection but where the candle itself is not strong enough for a direct close-entry are **armed**. An armed setup fires a signal when a later candle's LOW breaks below the trigger level.

### Armed Setup Data Model

```ts
type ArmedSellSetup = {
  type:                  string;   // 'B2' | 'C' | 'D1' | 'D2' | 'E'
  signalIndex:           number;   // Candle index when arming occurred
  signalLow:             number;   // Low of the signal candle
  signalHigh:            number;   // High of the signal candle
  zoneReference:         number;   // Reference price level
  expiryIndex:           number;   // Last valid candle index for trigger
  stopLoss:              number;
  reason:                string;
  isDayHighZoneRejection: boolean;
  nearDayHighZone:       boolean;
  isNearDailyHigh:       boolean;
  armMarketState:        string;
};
```

### Trigger Logic (per candle)

For each active armed setup:

1. **Expiry check**: if `shouldExpireArmedSetup()` → remove (logs `[V2E-EXPIRED-ARMED]`)
2. **Trigger level**: `signalLow - max(armedSetupTriggerBuffer, ATR × 0.1)`
3. **Hit condition**: `candle.low ≤ triggerLevel`
4. **Secondary confirmation** (`armedTriggerNeedConfirm: true`): at least one of:
   - Red candle
   - `candleClose < armed.signalLow`
   - `candleClose < (signalLow + signalHigh) / 2`
5. On valid trigger: emit signal, remove armed setup

### Expiry Conditions (any one triggers removal)

| Condition | Check |
|---|---|
| Time-based | `currentIndex > armed.expiryIndex` |
| Structure-invalidated | `candle.close > armed.signalHigh + armedInvalidationBuffer` |
| EMA reclaim (C only) | `candle.close > ema20 + armedInvalidationBuffer` |
| Stale (optional) | Price has not moved toward trigger after half the expiry window |

### Expiry Window (market state + setup type)

```
Base:
  BEARISH_TREND                → 4 candles
  BEARISH_REVERSAL_TRANSITION  → 6 candles
  SIDEWAYS_RANGE               → 5 candles
  BULLISH_OR_NEUTRAL           → 3 candles

Per-type offset:
  B2  → +0
  C   → −1  (EMA rejection must trigger fast)
  D   → +1  (range timing is slower)
  E   → +0
```

---

## 11. 2-Candle Pending Sequence Queue

When a setup candle shows rejection qualities but is not strong enough for any trigger (even armed), it is stored in a **multi-sequence pending queue** (`pendingSeqs: PendingRejectionSetup[]`). A confirmation candle in the next `seqConfirmWindowCandles (3)` candles completes the signal.

### Pending Sequence Data Model

```ts
type PendingRejectionSetup = {
  seqType:              'DHR' | 'SWEEP';
  setupIndex:           number;
  zoneReference:        number;
  zoneType?:            string;
  setupHigh:            number;
  setupLow:             number;
  setupMidpoint:        number;   // (high + low) / 2
  stopLoss:             number;
  reason:               string;
  isDayHighZoneRejection: boolean;
  nearDayHighZone:      boolean;
  isNearDailyHigh:      boolean;
  expiryIndex:          number;   // setupIndex + seqConfirmWindowCandles
  marketStateAtSetup:   string;
};
```

### Queue Lifecycle

```
Candle i:  B or B2 or E detects setup candle
           → addPendingSequence() (de-duped by seqType + zone ± seqDuplicateZonePts)
           → logs [V2E-SEQ-QUEUED] or [V2E-SEQ-SKIP-DUPE]

Candle i+1 … i+3:
  For each pending sequence:
    ├─ seqExpired  (i > expiryIndex)              → remove + log [V2E-EXPIRED-SEQ]
    ├─ seqInvalidated (close > setupHigh + 1)     → remove + log [V2E-EXPIRED-SEQ]
    ├─ seqConfirmed (DHR or SWEEP confirm helper) → emit signal + log [V2E-SIGNAL-SEQ] + remove
    └─ still active                               → keep in queue
```

### Confirmation Rules

**DHR confirmation** (`isValidDhrConfirmationCandle`):
- `close < setupMidpoint`, OR
- `low < setupLow`, OR
- Strong bearish follow-through (body ≥ 50%, close in lower 35% of range)

**Sweep confirmation** (`isValidSweepConfirmationCandle`): same logic as DHR.

> If `seqConfirmBelowSetupLow: true`, the stricter rule applies: `close < setupLow OR low < setupLow`.

---

## 12. Zone Memory

All key-level setups (B, B2, D1, D2, E) use a shared `zoneMemory: Map<string, { lastUsed, level }>` to prevent repeated signals from the same zone.

**Key generation**: Level is snapped to nearest `marginPoints` grid.

**Zone is blocked when both**:
- `i - lastUsed < zoneRearmCandles (8)`, AND
- `|currentPrice - level| / price ≤ zoneRearmPct (0.3%)`

**Zone rearms** when price has moved away by more than `zoneRearmPct`.

---

## 13. Duplicate Suppression

In addition to zone memory, a global check prevents two signals that are:
- Within `0.15%` of each other in price, AND
- Within `5 candles` of each other in time

---

## 14. Sideways Detection

`isSidewaysAt(i)` uses a `sidewaysLookback (8)` candle window. **Both** conditions must be met:

1. **Narrow EMA spread**: At least 60% of candles in the window have `|EMA8 - EMA20| / midpoint < 0.4%`
2. **EMA crossings**: Price crossed EMA20 at least `sidewaysCrossings (2)` times in the window

---

## 15. Inherited Bearish Bias

Scored once per session call via `scorePreviousSessionBearishness()` on a 0–7 scale:

| Criterion | Score |
|---|---|
| Prior session close was below EMA20 | +2 |
| Prior close was in lower 45% of prior session range | +1 |
| Prior close did not reach the day high (no late bullish surge) | +1 |
| Early session candles (first 15) mostly below EMA20 | +2 |
| EMA itself was declining in the early session | +1 |

**`inheritedBearishBias = true`** when `score >= prevSessionMinScore (4)`.

When `inheritedBearishBias` is active, setups B2 and E can fire even when `marketState === BULLISH_OR_NEUTRAL`, provided `isCurrentMoveLikelyPullback()` returns true.

**`isCurrentMoveLikelyPullback`** checks:
- Close is not more than `pullbackMaxAboveEmaPct (0.6%)` above EMA20
- Session high-to-now has not exceeded `prevDayClose + pullbackMaxAtrMove × ATR` (i.e. no impulsive rally)

> Setup B, C, D are **not affected** by inherited bias — they still require strict EMA context.

---

## 16. Diagnostic Logs

All events are emitted via `diagLog('v2e', tag, payload)`.

| Tag | Fires when |
|---|---|
| `[V2E-CALL]` | Function entry — session-level summary |
| `[V2E-CANDLE]` | Every candle that passes the time/activation gate |
| `[V2E-SIGNAL-A]` | Setup A fires |
| `[V2E-SIGNAL-B]` | Setup B fires |
| `[V2E-SIGNAL-B2]` | Setup B2 fires |
| `[V2E-SIGNAL-C]` | Setup C fires |
| `[V2E-SIGNAL-D1]` | Setup D1 fires |
| `[V2E-SIGNAL-D2]` | Setup D2 fires |
| `[V2E-SIGNAL-D3]` | Setup D3 fires |
| `[V2E-SIGNAL-E]` | Setup E fires |
| `[V2E-SIGNAL-ARMED]` | Armed setup triggers on low-break |
| `[V2E-SIGNAL-SEQ]` | 2-candle pending sequence confirms |
| `[V2E-ARMED-B2]` | Setup B2 armed |
| `[V2E-ARMED-C]` | Setup C armed |
| `[V2E-ARMED-D1]` | Setup D1 armed |
| `[V2E-ARMED-D2]` | Setup D2 armed |
| `[V2E-ARMED-E]` | Setup E armed |
| `[V2E-EXPIRED-ARMED]` | Armed setup expired or invalidated |
| `[V2E-EXPIRED-SEQ]` | Pending sequence expired or invalidated |
| `[V2E-SEQ-QUEUED]` | New pending sequence added to queue |
| `[V2E-SEQ-SKIP-DUPE]` | Pending sequence skipped — similar one already active |
| `[V2E-SKIP-ARMED-C]` | C arming skipped — nearby C already armed or recently expired |

---

## 17. Behavior by Market State

| Market State | Active Setups |
|---|---|
| `BEARISH_TREND` | A, B (strict), B2, C, E |
| `SIDEWAYS_RANGE` | A (strict), D1, D2, D3 (opt-in), C (range-edge only), E |
| `BEARISH_REVERSAL_TRANSITION` | A, B2, C, E |
| `BULLISH_OR_NEUTRAL` | A only (if first-candle break not yet fired); B2 + E allowed when `inheritedBearishBias && isCurrentMoveLikelyPullback` |

---

## 18. Signal Reason Labels

| Setup | Reason string |
|---|---|
| A | `V2E: 1st Candle Low Break (${pattern})` |
| B | `V2E: Day High Rejection (${pattern} @ ${zone})` |
| B2 | `V2E: Sweep Day High Rejection (${zone})` |
| C | `V2E: EMA Rejection (${pattern})` |
| D1 | `V2E: 1st Hour High Rejection (sideways)` |
| D2 | `V2E: 1st Hour High Sweep Rejection (sideways)` |
| D3 | `V2E: 1st Hour Low Breakdown (sideways continuation)` |
| E | `V2E: Liquidity Sweep Rejection (${zone})` |

Armed trigger suffix: `${reason} [Triggered]`  
2-candle sequence suffix: `${reason} [2-Candle Seq]`

---

## 19. ATR Usage

ATR is computed once as the average `high − low` across the first `min(10, candles.length)` candles of the session:

```ts
atr = mean(candles[0..9].map(c => c.high - c.low))
```

Used in:
- `reversalSL(refHigh)` — adaptive stop-loss
- `getArmedExpiryWindow()` — (indirectly, through fixed values)
- `sweepMaxAboveRef` — `max(sweepMaxAboveRefPts, atr × sweepMaxAboveRefAtrMult)`
- `firstHourHigh` zone tolerance for D1 — `max(marginPoints, atr × 0.3)`
- `hasArmedSetupGoneStale()` — stale-detection threshold (disabled by default)

---

## 20. Data Flow Summary

```
Session start
│
├─ Compute ATR, firstCandleLow/High, firstHourHigh/Low
├─ Score inherited bearish bias (prevSessionBearishScore)
├─ Check sessionActive (normal activation)
└─ Emit [V2E-CALL]

Main loop: i = scanStartIndex → candles.length - 1
│
├─ Update intradayDayHigh (prevRollingHigh snapshot BEFORE current candle)
├─ Time gate: 9:30–14:30 IST
├─ Session activation check (normal / delayed / late)
├─ Compute: candleBody, upperWick, totalRange, isRedCandle, isDoji, prev1
├─ Compute: sideways, bearishEma, marketState
├─ Emit [V2E-CANDLE]
│
├─ ── Armed Setup Trigger Check ──────────────────────────────
│    For each active armed setup (reverse iterate):
│    ├─ shouldExpireArmedSetup? → remove + [V2E-EXPIRED-ARMED]
│    ├─ low ≤ triggerLevel + secondary confirm? → signal + [V2E-SIGNAL-ARMED]
│    └─ break after first valid trigger
│
├─ ── Pending Sequence Check ──────────────────────────────────
│    For each pending sequence:
│    ├─ expired or close > setupHigh + 1 → remove + [V2E-EXPIRED-SEQ]
│    ├─ confirmation candle valid → signal + [V2E-SIGNAL-SEQ]
│    └─ else: keep active
│
├─ ── Setup A ─────────────────────────────────────────────────
│    !firstCandleLowBreakFired + red candle + close < breakLevel
│    + isStrongBearishTriggerCandle → signal [V2E-SIGNAL-A]
│
├─ ── Setup B2 ────────────────────────────────────────────────
│    (Evaluated BEFORE Setup B)
│    Transition/Trend/InheritedBias → sweep/touch at intraday/prevDay/FHH
│    b2Score >= 4 → direct or arm + optional pending sequence
│
├─ ── Setup B ─────────────────────────────────────────────────
│    bearishEma / inheritedPath → isValidDhrTriggerCandle at any reference high
│    → direct signal or addPendingSequence (DHR)
│
├─ ── Setup C ─────────────────────────────────────────────────
│    (!sideways && bearishEma) || cSidewaysRangeEdge
│    EMA event in last 3 candles + confirmation
│    cScore >= 2 → direct or arm (with rearm cooldown guard)
│
├─ ── Setup D (sideways only) ─────────────────────────────────
│    D1: touch FHH + bearish candle → direct or arm
│    D2: sweep FHH + score >= 4 → direct or arm
│    D3: (opt-in) break FHL after D1/D2 fired → direct
│
└─ ── Setup E ─────────────────────────────────────────────────
     !BULLISH_OR_NEUTRAL || inheritedBias
     sweep any key high + score >= 4
     → direct (score >= 5 + valid trigger) or arm + optional pending sequence
```

---

*Last updated: 2026-03-17 — reflects `detectDaySellSignalsV2Enhanced` as implemented in `apps/api/src/kite/services/kite.service.ts`.*

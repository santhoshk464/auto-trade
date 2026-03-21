# Day Selling Strategy V1 — Full Reference

**Function:** `detectDaySellSignals`
**Status:** Production — Do NOT modify without deep understanding of all filter interactions.

---

## Overview

V1 is the original day sell signal engine. It detects intraday bearish reversal and breakdown setups on options (CE) using price structure, EMA, resistance zones, candlestick patterns, and RSI.

It is completely independent from V2 and V3.

---

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `candles` | `any[]` | — | Array of OHLCV candles (5-min) |
| `emaValues` | `(number\|null)[]` | — | 20 EMA value per candle |
| `rsiValues` | `(number\|null)[]` | — | RSI value per candle |
| `swingHighs` | `{price, index}[]` | — | Detected session swing highs |
| `yesterdayHigh` | `number` | — | Previous day's high |
| `prevDayLow` | `number` | `0` | Previous day's low |
| `prevDayClose` | `number` | `0` | Previous day's close |
| `marginPoints` | `number` | — | Zone proximity tolerance (points) |
| `minSellRsi` | `number` | `45` | Minimum RSI for non-DHR signals |
| `maxSellRiskPts` | `number` | `25` | Maximum allowed risk (non-DHR capped at 25, DHR at 40) |
| `realtimeMode` | `boolean` | `false` | Only scan last 2 candles (use pre-pass for zone state) |
| `instrumentName` | `string` | `''` | For logging |
| `superTrendData` | `{superTrend, trend}[]` | `undefined` | Optional SuperTrend data |

---

## Trade Window

- **Start:** 9:30 AM IST
- **End:** 2:30 PM IST
- Exception: `Day 1st Candle Low Break` runs from 9:15 AM (first candle) and is checked before the time gate.

---

## Session State (Rolling Zone Tracker)

V1 maintains a dynamic **Day High Zone** using a rolling zone tracker called `updateZone`. It runs on every candle including pre-scan candles.

### How `updateZone` works

1. Tracks `rollingHigh` — the highest candle high seen in the session so far.
2. When a new session high is made, it evaluates the candle for **resistance characteristics**:
   - Doji body (body < 10% of range), OR
   - Long upper wick rejection (wick > 35% range AND wick > 1.5× body), OR
   - Strong bearish close at high (red candle with body > 35% range)
3. If a resistance characteristic is found → sets `confirmedResZone = candleHigh` and resets zone state.
4. Tracks `pulledBackFromResZone`: becomes `true` when price pulls back more than `marginPoints × 2` below the confirmed zone.
5. Tracks `dayHighZoneTestCount`: increments each time price retests the zone (within `marginPoints × 1.5`) after pulling back.

### `nearDayHighZone`

```ts
nearDayHighZone =
  pulledBackFromResZone &&
  confirmedResZone > 0 &&
  i > confirmedResZoneIndex + 1 &&
  Math.abs(candleHigh - confirmedResZone) <= marginPoints * 1.5
```

This is the **core Day High Zone** flag — price has pulled back from a confirmed resistance high and is now retesting it.

`nearDayHighZone` bypasses the EMA trend filter and the uptrend guard, since a rejection at the session high is valid regardless of overall EMA direction.

---

## Pre-Filters (Applied Before Pattern Detection)

### 1. EMA Trend Filter

```ts
if (priceAboveEMA && !highTouchesEMA && gapFromEMA < marginPoints * 1.5 && !nearDayHighZone)
  continue;
```

Skips candles that are slightly above the EMA but not touching it (not yet a rejection setup), unless in the day-high zone.

### 2. Uptrend Guard

Scans all candles from session start to current candle. If ≥ 60% of candles closed above the 20 EMA → uptrend detected → skip (EMA is acting as support).

**Exception:** `nearDayHighZone` bypasses the uptrend guard — a day-high rejection is valid even in an uptrend.

### 3. Resistance Proximity Gate

At least one must be true:

- `nearEMA` — candle high within `marginPoints` of 20 EMA
- `nearYesterdayHigh` — candle high within `marginPoints` of previous day high
- `nearPrevDayClose` — candle high within `marginPoints` of previous day close
- `nearSwingHigh` — candle high within `marginPoints` of any prior session swing high
- `nearDayHighZone` — near the confirmed rolling session high resistance zone

If none match → skip candle.

### 4. Candle Type Gate

Only valid candle types proceed:

- Red candle
- Doji with next candle red
- Green Shooting Star (near EMA, next candle red)
- Any candle if `nearDayHighZone` or `emaTouchRejection`

---

## Signals (Pattern Engines)

### Signal 1: Day 1st Candle Low Break

**Trigger:** First time price breaks and closes below the 9:15 AM candle's low.

**Conditions:**

| Condition | Detail |
|---|---|
| First candle low must exist | `firstCandleLow > 0` |
| Not already fired | `!firstCandleLowBreakFired` |
| Current candle is red | `isRedCandle` |
| Close below first candle low | `candleClose < firstCandleLowBreakLevel` |

**Valid breakdown candle** (at least one required):

- Large bearish body: `body > 40%` of range
- Bearish engulfing: current red candle engulfs prior green candle's full body
- Strong close near low: close in bottom 20% of range

**EMA check:** EMA must be at or above close — if EMA is below close, it acts as dynamic support beneath price → skip.

**No nearby support check:** Blocks if any of the following are within 1R below entry:

- 20 EMA below close (already blocked above)
- Previous day low within 1R
- Any prior intraday candle low within 1R (price will stall before T1)

**SL:** `max(candleHigh, firstCandleLow) + 2`

**Fires once per session.** `firstCandleLowBreakFired = true` after first attempt (valid or invalid breakdown candle).

---

### Signal 2: Day High Zone Rejection (DHR)

**The primary signal engine.** Fires when price retests the confirmed session high resistance zone with a rejection candle.

**Required conditions:**

| Condition | Detail |
|---|---|
| `nearAnyDayHighResistance` | `nearDayHighZone \|\| nearYesterdayHigh \|\| nearPrevDayClose` |
| `emaFarBelowZone` | EMA is more than `marginPoints × 2` below the resistance zone (room to fall) |
| `emaNotSupportAtEntry` | EMA is at/above close (overhead resistance) OR EMA is far enough below close (≥ `marginPoints`) |
| `rsiNotOversold` | RSI == null OR RSI > 35 |
| Candle type | Red candle, Doji, or Green Shooting Star |
| `dhrRejectionCandle` | Long upper wick (wick > body×1.2 OR wick > range×0.4), OR Bearish Engulfing, OR Strong Bearish Close (body > 50% range), OR Doji |

**Resistance zones for DHR:**
- `nearDayHighZone` — confirmed rolling session high (pulled-back-then-retested)
- `nearYesterdayHigh` — previous day's high
- `nearPrevDayClose` — previous day's close

**SL:** Up to `actualClose + 40` (DHR has a wider 40-point ceiling vs. 25 for other patterns).

**Signal reason format:** `Day High Rejection (Pattern @ zone)`

Examples:
- `Day High Rejection (Bearish Engulfing @ session high 23450)`
- `Day High Rejection (Long Upper Wick @ prev day high 23380)`
- `Day High Rejection (Doji @ prev day close 23310)`

---

### Signal 3: Bearish Open @ EMA Rejection

**Trigger:** Price retraces back up to the 20 EMA and gets rejected — a clean EMA resistance touch in a confirmed downtrend.

**Conditions:**

| Condition | Detail |
|---|---|
| `emaTouchRejection` | `nearEMA` + red candle + high ≥ EMA – margin×0.5 + close < EMA |
| `!emaActsAsSupport` | Fewer than 2 EMA bounces in the last 10 candles |
| `emaBearishStructure` | At least 3 of last 6 candles closed below EMA |
| `!emaIsFirstCrossBelow` | Both prev-1 and prev-2 did NOT close above EMA (not a first dip) |
| `emaLowerHighsForming` | At least one declining high in the candles i-3 → i-2 → i-1 |

**EMA Bounce Check:** Scans last 10 candles. If ≥ 2 candles touched the EMA low/close and the *next* candle was green → EMA is acting as support → block.

**RSI gate:** Exempt from `minSellRsi` (EMA rejection is structural — valid even at low RSI after a morning sell-off).

**SL:** Swing-high-aware (see Stop Loss section).

**Signal reason:** `Bearish Open @ EMA Rejection`

---

### Signal 4: Weak Close @ Resistance

**Trigger:** Price reaches a resistance level multiple times but closes weakly (failing to hold gains).

**Conditions:**

- `nearEMA || nearYesterdayHigh || nearSwingHigh`
- `candleHigh ≥ resistanceLevel × 0.99`
- `candleClose < candleHigh × 0.995`
- If green candle: `close < open + body × 0.5`
- `resistanceTests ≥ 2` (resistance tested at least twice in last 4 candles)

**Signal reason:** `Weak Close @ Resistance (N tests)`

---

### Signal 5: Early Rejection @ Resistance

**Trigger:** Strong upper wick rejection at a known resistance level.

**Conditions:**

- `nearEMA || nearYesterdayHigh || nearSwingHigh`
- `upperWick > body × 1.2 AND upperWick > range × 0.4`
- `close < high × 0.99`
- If near EMA: `high ≥ EMA – margin × 0.5` (must actually reach the EMA zone)

**Signal reason:** `Early Rejection @ Resistance`

---

### Signal 6: Momentum Slowing @ Resistance

**Trigger:** Three consecutive candles with shrinking bodies at a resistance level — buyers losing conviction.

**Conditions:**

- `prev2` and `prev1` exist
- Red candle with body < prev1 body < prev2 body (shrinking momentum)
- `resistanceTests ≥ 2`

**Signal reason:** `Momentum Slowing @ Resistance`

---

### Signal 7: Shooting Star @ Resistance

**Signal reason:** `Shooting Star @ Resistance`

**Conditions:**

- `upperWick > body × 2`
- `lowerWick < body × 0.5`
- `upperWick > range × 0.6`

---

### Signal 8: Bearish Engulfing @ Resistance

**Signal reason:** `Bearish Engulfing @ Resistance`

**Conditions:**

- Previous candle was green
- Current candle opens above prev close AND closes below prev open (full engulf)
- Current candle is red

---

### Signal 9: Strong Rejection @ Resistance

**Signal reason:** `Strong Rejection @ Resistance`

**Conditions:**

- Red candle
- `upperWick > body × 2`
- `upperWick > range × 0.5`
- `close < open × 0.98`

---

## Post-Pattern Filters

These run after a signal reason is determined and can cancel the signal.

### First Candle High Gate

```ts
if (actualClose > candles[0].high && !(RSI > 60) && !emaTouchRejection) continue;
```

Prevents chasing signals above the opening candle's high unless RSI > 60 (strong overbought) or it's an EMA touch rejection.

### RSI Quality Gate

```ts
if (!isDayHighZoneRejection && !bearishOpenAtEMA && RSI != null && RSI < minSellRsi) continue;
```

Requires RSI ≥ 45 (default) for all patterns except DHR and EMA Rejection.

### SuperTrend Filter

```ts
if (st.trend === 'up' && !isDayHighZoneRejection && !bearishOpenAtEMA) continue;
```

In SuperTrend uptrend: only DHR and EMA Rejection are allowed. All other patterns are with-trend (counterproductive).

### EMA Support Floor

```ts
if (!bearishOpenAtEMA && EMA < actualClose && actualClose - EMA < risk) continue;
```

If EMA is below entry and within 1R of entry → EMA will act as a floor and block price from reaching T1 → skip.
(Exception: `bearishOpenAtEMA` entry IS the EMA, so no floor check needed.)

### Risk Cap

- Non-DHR signals: capped at `maxSellRiskPts` (default 25 pts)
- DHR signals: capped at 40 pts

---

## Stop Loss Logic

V1 uses a **swing-high-aware SL** with a fixed fallback:

1. Scan last 10 candles for swing highs that are:
   - Above entry price
   - Below `entry + 30`
   - At least 8 pts above entry (avoids hair-trigger SL)
2. If found → `SL = nearestSwingHigh + 2`
3. If not found → `SL = entry + 30` (fixed fallback)

Target is always `2× risk` (1:2 risk-reward ratio).

---

## Entry Candle Logic (Doji/Shooting Star Deferral)

For Doji and Green Shooting Star signals, the **next candle** is used as the actual entry:

```ts
const useNextAsEntry = (isDoji || isGreenShootingStar) && nextIsRed && nextCandle;
const actualEntry = useNextAsEntry ? nextCandle : candle;
```

This ensures the entry is on confirmed momentum, not the signal candle itself.

---

## Signal Output Fields

| Field | Type | Description |
|---|---|---|
| `candleIndex` | `number` | Index of the signal candle |
| `actualCandleIndex` | `number` | Index of the actual entry candle (may differ for Doji/SS) |
| `candleTime` | `string` | Signal candle time (e.g. `"11:15 AM"`) |
| `candleDate` | `Date` | Date object of signal candle |
| `unixTimestamp` | `number` | Unix timestamp (IST adjusted) |
| `reason` | `string` | Signal reason label |
| `entryPrice` | `number` | Actual entry candle close |
| `stopLoss` | `number` | Calculated SL |
| `risk` | `number` | `stopLoss - entryPrice` |
| `candleRSI` | `number \| null` | RSI at signal candle |
| `isDayHighZoneRejection` | `boolean` | True if DHR signal |
| `nearDayHighZone` | `boolean` | True if near confirmed rolling high zone |
| `isNearDailyHigh` | `boolean` | True if candle high is within `marginPoints × 3` of rolling high |

---

## Signal Priority (Implicit)

The first matching pattern wins for each candle (evaluated in this order):

1. Day 1st Candle Low Break *(handled separately before main loop — skips to next candle)*
2. Day High Zone Rejection
3. Weak Close @ Resistance
4. Bearish Open @ EMA Rejection
5. Early Rejection @ Resistance
6. Momentum Slowing @ Resistance
7. Shooting Star @ Resistance
8. Bearish Engulfing @ Resistance
9. Strong Rejection @ Resistance

---

## Key Design Principles

| Principle | Implementation |
|---|---|
| DHR bypasses uptrend guard | `nearDayHighZone` exception in uptrend check |
| DHR bypasses EMA trend filter | `nearDayHighZone` exception in EMA filter |
| EMA Rejection bypasses RSI gate | `bearishOpenAtEMA` exception in RSI check |
| EMA Rejection bypasses EMA support floor | `bearishOpenAtEMA` exception in floor check |
| SuperTrend only allows high-conviction sells | Only DHR + EMA Rejection allowed in ST-up |
| Dynamic resistance zone | `updateZone` runs on every candle, builds state incrementally |
| 1st candle break fires only once | `firstCandleLowBreakFired` flag |
| No duplicate SL levels | Swing-high-aware SL with 8-pt minimum and 30-pt fallback |

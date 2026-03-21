# V2E Strategy — Day Sell Signals (Enhanced)

`detectDaySellSignalsV2Enhanced`

---

## Overview

V2E is a 5-minute intraday sell signal detection strategy for Indian index options. It builds on V2 by adding:

- Market-state classification (bearish trend / sideways / reversal transition)
- Sweep / Transition DHR (Setup B2) for reversal entries without full bearish context
- Multi-candle EMA rejection with confluence scoring (Setup C)
- First-hour range edge logic in sideways mode
- Liquidity sweep / failed breakout detection (Setup E)
- Zone memory with rearm logic to prevent signal spam

Scan window: **9:30 AM – 2:30 PM IST**

---

## Inputs

| Parameter        | Type                 | Description                                          |
| ---------------- | -------------------- | ---------------------------------------------------- |
| `candles`        | `any[]`              | 5-min OHLC array for the session                     |
| `ema20Values`    | `(number \| null)[]` | Pre-computed 20-period EMA per candle                |
| `ema8Values`     | `(number \| null)[]` | Pre-computed 8-period EMA per candle                 |
| `rsiValues`      | `(number \| null)[]` | Pre-computed RSI per candle                          |
| `swingHighs`     | `{price, index}[]`   | Recent swing highs for sweep reference               |
| `yesterdayHigh`  | `number`             | Previous day's high                                  |
| `prevDayLow`     | `number`             | Previous day's low (used for 1st-candle break level) |
| `prevDayClose`   | `number`             | Previous day's close (used as resistance reference)  |
| `marginPoints`   | `number`             | Instrument tick granularity / proximity buffer       |
| `maxSellRiskPts` | `number`             | Max allowed SL distance in points (default: 30)      |
| `realtimeMode`   | `boolean`            | Scan only last 2 candles instead of full session     |
| `instrumentName` | `string`             | Used in diagnostic logs                              |
| `superTrendData` | `array`              | Not used in V2E logic directly                       |

---

## Output

Each detected signal returns:

```ts
{
  candleIndex: number;
  actualCandleIndex: number;
  candleTime: string; // e.g. "11:45 AM"
  candleDate: Date;
  unixTimestamp: number; // IST epoch (+19800)
  reason: string; // Human-readable setup label
  entryPrice: number; // candleClose
  stopLoss: number; // above candle high or reference level
  risk: number; // stopLoss - entryPrice
  candleRSI: number | null;
  isDayHighZoneRejection: boolean;
  nearDayHighZone: boolean;
  isNearDailyHigh: boolean;
}
```

---

## Configuration (all inlined as `cfg`)

### Session activation

| Field                                | Default | Description                                             |
| ------------------------------------ | ------- | ------------------------------------------------------- |
| `requireOpenBelow20Ema`              | `true`  | Session activates only if first candle open < EMA20     |
| `allowDelayedActivation`             | `true`  | Allow activation mid-session if enough below-EMA closes |
| `delayedActivationLookback`          | `6`     | Candles to look back for delayed activation             |
| `delayedActivationBelowCloseCount`   | `4`     | Required below-EMA closes for delayed activation        |
| `delayedActivationEmaSlopeThreshold` | `0`     | Max EMA slope allowed at delayed activation             |
| `lateBearishActivationEnabled`       | `true`  | Allow late-session activation after EMA loss            |
| `lateBearishActivationLookback`      | `5`     | Lookback window for late activation                     |
| `lateBearishActivationBelowCloses`   | `3`     | Required below-EMA closes in late activation window     |

### EMA resistance context

| Field                      | Default | Description                                     |
| -------------------------- | ------- | ----------------------------------------------- |
| `emaResistanceLookback`    | `6`     | Candles checked for bearish EMA context         |
| `minBelowEmaCloses`        | `3`     | Required closes below EMA20 for bearish context |
| `maxAllowedAboveEmaCloses` | `3`     | Max tolerated closes above EMA20 in window      |
| `emaSlopePeriod`           | `3`     | Periods back to check EMA slope direction       |

### Sideways detection

| Field               | Default | Description                                 |
| ------------------- | ------- | ------------------------------------------- |
| `sidewaysEmaGapPct` | `0.004` | Max EMA8/EMA20 gap ratio to count as narrow |
| `sidewaysLookback`  | `8`     | Lookback window for sideways check          |
| `sidewaysCrossings` | `2`     | Min EMA crossings to classify as sideways   |

### First-hour range

| Field                         | Default | Description                                            |
| ----------------------------- | ------- | ------------------------------------------------------ |
| `firstHourCandles`            | `12`    | Number of 5-min candles in the first hour (9:15–10:15) |
| `enableFirstHourLowBreakdown` | `false` | Opt-in for Setup D3 (FHL continuation)                 |

### Sweep logic

| Field                     | Default | Description                                 |
| ------------------------- | ------- | ------------------------------------------- |
| `sweepBufferPts`          | `2`     | Min pts above reference to count as a sweep |
| `sweepMaxAboveRefPts`     | `15`    | Max sweep excess in points                  |
| `sweepMaxAboveRefAtrMult` | `0.8`   | Max sweep excess as ATR multiple            |
| `sweepReturnRequired`     | `true`  | Candle must close back below swept level    |

### Multi-candle EMA rejection (Setup C)

| Field                          | Default | Description                                  |
| ------------------------------ | ------- | -------------------------------------------- |
| `emaRejectionWindow`           | `3`     | Candles back to search for EMA event         |
| `minEmaRejectionScore`         | `2`     | Minimum confluence score to fire Setup C     |
| `sidewaysAllowsRangeEdgeSells` | `true`  | Allow Setup C in sideways near range edges   |
| `sidewaysRangeEdgeTolMult`     | `2`     | Range-edge proximity = `marginPoints × this` |

### Scoring thresholds

| Field              | Default | Description                      |
| ------------------ | ------- | -------------------------------- |
| `minReversalScore` | `4`     | Min score for Setup D2 / Setup E |
| `sweepDhrMinScore` | `4`     | Min score for Setup B2           |

### Zone memory

| Field                | Default | Description                                   |
| -------------------- | ------- | --------------------------------------------- |
| `dupSuppressZonePct` | `0.015` | Price proximity to suppress duplicate signals |
| `dupCooldownCandles` | `5`     | Min candle gap between signals                |
| `zoneRearmPct`       | `0.01`  | Price move-away needed to rearm a zone        |
| `zoneRearmCandles`   | `8`     | Candle cooldown for zone reuse                |

### Candle quality

| Field                         | Default | Description                                           |
| ----------------------------- | ------- | ----------------------------------------------------- |
| `candleBodyRatio`             | `0.55`  | Body/range ratio for strong-bearish candle            |
| `sidewaysBreakdownStrictMode` | `true`  | Setup A in sideways requires full bearish EMA context |

---

## Market State Classification

Called once per candle via `getMarketState(i, ema20, sideways, bearishEma)`.

| State                         | Condition                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `SIDEWAYS_RANGE`              | `isSidewaysAt(i) === true`                                                             |
| `BEARISH_TREND`               | `bearishEma && candleClose < ema20`                                                    |
| `BEARISH_REVERSAL_TRANSITION` | Late activation criteria met (≥3 closes below EMA in last 5 candles, EMA flat or down) |
| `BULLISH_OR_NEUTRAL`          | None of the above                                                                      |

Setups A, B, B2, C, D, E are each gated per market state. `BULLISH_OR_NEUTRAL` blocks most setups.

---

## Session Activation

The strategy is blocked unless one of three activation conditions is met:

1. **Normal activation**: First candle open is below EMA20 at session start.
2. **Delayed activation**: Within a lookback window of 6 candles, at least 4 closes are below EMA20 and EMA slope is flat or down.
3. **Late bearish activation**: In the last 5 candles, at least 3 closes are below EMA20 and EMA is not rising.

---

## Rolling High Tracking

```
prevRollingHigh = rollingHigh          ← snapshot BEFORE this candle
intradayDayHigh = prevRollingHigh      ← used for all setup evaluations
if (candle.high > rollingHigh) rollingHigh = candle.high   ← update AFTER
```

This ensures that a candle making a new intraday high is tested against the previously known high, not against itself.

---

## Setups

### Setup A — First Candle Low Break

**Signal label**: `V2E: 1st Candle Low Break (${pattern})`

Fires once per session when price breaks below the first candle's low.

**Break level calculation**:

- If `prevDayLow` is close to `firstCandleLow` (within `marginPoints × 2`), break level = `min(firstCandleLow, prevDayLow) - 1`
- Otherwise: `firstCandleLow`

**Candle must be one of**:

- Large bearish body (`body > range × 0.4`)
- Bearish engulfing vs prev candle
- Strong close near low (`close within 20% of range from low`)

**Blocked if**:

- EMA20 is below current close (support below price)
- In sideways + `sidewaysBreakdownStrictMode` + no bearish EMA context
- A nearby support level exists within the risk distance (EMA, prev-day low, intraday low)

**SL**: `firstCandleLow + 2`

**Risk cap**: `maxSellRiskPts × 2`

---

### Setup B — Trend Day High Zone Rejection (DHR)

**Signal label**: `V2E: Day High Rejection (${pattern} @ ${zone})`

**Required context**: `bearishEma === true` and market state is not `BULLISH_OR_NEUTRAL`.

**Reference zones tested** (candle high must be within `marginPoints × 1.5`):

- Intraday rolling high (prior candle reference)
- Previous day's high
- Previous day's close
- First candle's high

**Candle must show a rejection pattern**:

- Long upper wick (`wick > body × 1.2` or `wick > range × 0.4`)
- Bearish engulfing
- Strong bearish close (`body > range × 0.5`)
- Doji

**Additional filter**: EMA20 must be at or above the close (`ema20 >= candleClose`).

**SL**: `candleHigh + 2`

---

### Setup B2 — Sweep / Transition Day High Rejection

**Signal label**: `V2E: Sweep Day High Rejection (${zone})`

Fires in `BEARISH_REVERSAL_TRANSITION` or `BEARISH_TREND` when full bearish EMA context is **not** yet confirmed. Catches failed breakout reversal sells during transition.

**Reference zones**:

- Intraday rolling high
- Previous day's high
- First-hour high (only after first-hour period has fully passed)

**Entry condition**: Candle must reach or sweep the reference level AND close back below it.

**Confluence scoring**:

| Condition                                              | Score |
| ------------------------------------------------------ | ----- |
| Base: near key high + closed below                     | +2    |
| Candle actually swept above level (`> sweepBufferPts`) | +1    |
| Red candle                                             | +1    |
| EMA20 overhead (`ema20 > close`)                       | +2    |
| Upper wick > 40% of range                              | +1    |
| Body > 30% of range + red                              | +1    |
| Next candle confirms bearish follow-through            | +2    |

Fires when `b2Score >= sweepDhrMinScore (4)`.

Zone memory prevents re-entry until price moves away by `zoneRearmPct`.

**SL**: `candleHigh + 2`

---

### Setup C — Multi-Candle EMA Rejection

**Signal label**: `V2E: EMA Rejection (${pattern})`

Scans a window of up to `emaRejectionWindow (3)` candles back for an EMA event, then requires bearish confirmation on the current candle.

**Active when**:

- Normal mode: `!sideways && bearishEma`
- Sideways edge mode: `sideways && sidewaysAllowsRangeEdgeSells && ema20 > close && candle is near first-hour-high or intraday-high`

**EMA event patterns** (searched oldest → newest in window):

| Pattern                  | Detection                                                                      |
| ------------------------ | ------------------------------------------------------------------------------ |
| **Direct Reject**        | Close < open, `\|high - EMA20\| ≤ marginPoints`, close < EMA20                 |
| **Wick Above EMA**       | High > EMA20 + marginPoints × 0.25, close < EMA20, upper wick ≥ 35% of range   |
| **Fake Reclaim Fail**    | Prior candle closed above EMA20 (green), next candle closes back below EMA20   |
| **Lower High Under EMA** | Current candle: lower high than prev, red, both high and prev high below EMA20 |

**Confirmation on current candle**: `candleClose < ema20 && isRedCandle`

**Confluence scoring**:

| Condition                                          | Score |
| -------------------------------------------------- | ----- |
| Direct Reject / Fake Reclaim Fail / Wick Above     | +2    |
| Lower High Under EMA                               | +1    |
| EMA sloping down (vs 3 candles ago)                | +1    |
| EMA not acting as support (< 2 bounces in last 10) | +1    |
| EMA8 < EMA20                                       | +1    |

Fires when `cScore >= minEmaRejectionScore (2)`.

**SL**: `max(candleHigh, eventCandle.high) + 2`

---

### Setup D — Sideways Range Logic

Only active when `isSidewaysAt(i) === true`.

#### D1 — First-Hour High Rejection

**Signal label**: `V2E: 1st Hour High Rejection (sideways)`

- Candle high within `max(marginPoints, ATR × 0.3)` of first-hour high
- Bearish rejection candle (upper wick ≥ 35% of range + red close, or strong bearish body)
- EMA20 must be overhead (`close < ema20`)

**SL**: `firstHourHigh + marginPoints × 0.5`

Zone memory: reuses `FHH` zone key. Only one D1 signal per zone until price moves away.

#### D2 — First-Hour High Sweep Rejection

**Signal label**: `V2E: 1st Hour High Sweep Rejection (sideways)`

- Candle sweeps above first-hour high by at least `sweepBufferPts (2)` points
- Closes back below first-hour high
- Sweep excess ≤ `max(sweepMaxAboveRefPts (15), ATR × sweepMaxAboveRefAtrMult (0.8))`

**Confluence scoring** (same as D structure, min score 4):

| Condition                 | Score |
| ------------------------- | ----- |
| Base sweep + closed below | +3    |
| Red candle                | +1    |
| EMA20 overhead            | +2    |
| Upper wick > 40% of range | +1    |
| Body > 30% + red candle   | +1    |

**SL**: `candleHigh + 2`

#### D3 — First-Hour Low Breakdown

**Signal label**: `V2E: 1st Hour Low Breakdown (sideways continuation)`

**Opt-in only** (`enableFirstHourLowBreakdown: false` by default).

- Only fires after D1 or D2 has been triggered (`firstHourHighZoneUsed === true`)
- Close breaks below first-hour low
- Red candle

**SL**: `firstHourLow + marginPoints`

---

### Setup E — Liquidity Sweep / Failed Breakout Rejection

**Signal label**: `V2E: Liquidity Sweep Rejection (${zone})`

Active in any non-bullish market state. Score-based. Catches trapped buyers above any important reference high.

**Reference highs tested**:

- Intraday rolling high
- Previous day's high
- First candle's high (only after candle 3)
- First-hour high (only after first-hour period)
- Up to 3 most recent swing highs (within `sidewaysLookback × 2` candles)

**Entry condition**: Candle high sweeps above reference by at least `sweepBufferPts` AND closes back below it.

**Confluence scoring**:

| Condition                          | Score |
| ---------------------------------- | ----- |
| Base: swept a key high             | +3    |
| Closed back below swept level      | +2    |
| Red candle                         | +1    |
| EMA20 overhead                     | +2    |
| Upper wick > 40% of range          | +1    |
| Body > 30% + red                   | +1    |
| Next candle bearish follow-through | +2    |

Fires when `score >= minReversalScore (4)`.

Only one sweep signal per candle (first qualifying reference wins). Zone memory prevents reuse.

**SL**: `candleHigh + 2`

---

## Zone Memory

All key-level setups (B, B2, D1, D2, E) use a shared `zoneMemory` map to prevent repeated signals from the same zone.

**Key generation**: Level is snapped to nearest `marginPoints` to handle minor variation.

**Zone is blocked when**:

- `i - lastUsed < zoneRearmCandles (8)` AND
- `|currentPrice - level| / price ≤ zoneRearmPct (1%)`

Zones can rearm if price has moved sufficiently away from the level.

---

## Duplicate Suppression

In addition to zone memory, a simple global duplicate check prevents any two signals that are:

- Within `1.5%` of each other in price, OR
- Within `5 candles` of each other in time

---

## Sideways Detection

`isSidewaysAt(i)` uses a `sidewaysLookback (8)` candle window:

1. **Narrow EMA spread**: At least 60% of candles in the window have `|EMA8 - EMA20| / midpoint < 0.4%`
2. **EMA crossings**: Price crossed EMA20 at least `sidewaysCrossings (2)` times in the window

Both conditions must be met to classify as sideways.

---

## Behavior by Market State

| Market State                  | Active Setups                                           |
| ----------------------------- | ------------------------------------------------------- |
| `BEARISH_TREND`               | A, B, C, E                                              |
| `SIDEWAYS_RANGE`              | A (strict), D1, D2, D3 (opt-in), C (range-edge only), E |
| `BEARISH_REVERSAL_TRANSITION` | A, B2, C, E                                             |
| `BULLISH_OR_NEUTRAL`          | A only (if first-candle break not yet fired)            |

---

## Signal Reason Labels

| Setup | Reason string                                         |
| ----- | ----------------------------------------------------- |
| A     | `V2E: 1st Candle Low Break (${pattern})`              |
| B     | `V2E: Day High Rejection (${pattern} @ ${zone})`      |
| B2    | `V2E: Sweep Day High Rejection (${zone})`             |
| C     | `V2E: EMA Rejection (${pattern})`                     |
| D1    | `V2E: 1st Hour High Rejection (sideways)`             |
| D2    | `V2E: 1st Hour High Sweep Rejection (sideways)`       |
| D3    | `V2E: 1st Hour Low Breakdown (sideways continuation)` |
| E     | `V2E: Liquidity Sweep Rejection (${zone})`            |

---

## Diagnostic Logs

All events are emitted via `diagLog('v2e', tag, payload)`.

| Tag               | Fires when                                    |
| ----------------- | --------------------------------------------- |
| `[V2E-CALL]`      | Function entry, before scan loop              |
| `[V2E-CANDLE]`    | Every candle that passes time/activation gate |
| `[V2E-SIGNAL-A]`  | Setup A fires                                 |
| `[V2E-SIGNAL-B]`  | Setup B fires                                 |
| `[V2E-SIGNAL-B2]` | Setup B2 fires                                |
| `[V2E-SIGNAL-C]`  | Setup C fires                                 |
| `[V2E-SIGNAL-D1]` | Setup D1 fires                                |
| `[V2E-SIGNAL-D2]` | Setup D2 fires                                |
| `[V2E-SIGNAL-D3]` | Setup D3 fires                                |
| `[V2E-SIGNAL-E]`  | Setup E fires                                 |

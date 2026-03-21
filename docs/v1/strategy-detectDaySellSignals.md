# Current Strategy Documentation: detectDaySellSignals

---

## 1. Strategy Overview

`detectDaySellSignals` is a **bearish intraday signal detection engine** for options (primarily CE/PE instruments). It scans a series of 5-minute candles and returns every candle index where a **SELL signal** is detected, along with entry price, stop-loss, and risk metadata.

The function operates as a **multi-pattern detector** with two distinct detection paths:

| Path | Description | Time Gate |
|------|-------------|-----------|
| **Day 1st Candle Low Break** | Fires at most once per session when price breaks below the opening candle's low | Before 9:30 AM (no time restriction), fires on any candle |
| **Resistance Zone Signals** | Multiple candlestick patterns at structural resistance | Only between 9:30 AM – 2:30 PM IST |

Every detected signal includes:
- `candleIndex` / `actualCandleIndex` — which candle triggered vs. which is the entry
- `entryPrice` — close of the actual entry candle
- `stopLoss` — swing-high-aware SL
- `risk` — stop distance in points
- `candleRSI` — RSI at the signal candle
- `isDayHighZoneRejection`, `nearDayHighZone`, `isNearDailyHigh` — zone flags

---

## 2. Parameters Used

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `candles` | `any[]` | — | Array of OHLCV candle objects with `date`, `open`, `high`, `low`, `close`, `volume` |
| `emaValues` | `(number \| null)[]` | — | Pre-computed 20-period EMA, index-aligned with `candles`. `null` means insufficient data |
| `rsiValues` | `(number \| null)[]` | — | Pre-computed RSI, index-aligned with `candles`. `null` means insufficient data |
| `swingHighs` | `Array<{price, index}>` | — | Pre-identified session swing highs used as resistance references |
| `yesterdayHigh` | `number` | — | Previous trading day's high price (used as a fixed resistance level) |
| `prevDayLow` | `number` | `0` | Previous day's low (used in first-candle-low-break support check) |
| `prevDayClose` | `number` | `0` | Previous day's closing price (used as a fixed resistance zone) |
| `marginPoints` | `number` | — | Tolerance in price points for all proximity checks (e.g., "within margin of EMA") |
| `minSellRsi` | `number` | `45` | Minimum RSI required for non-DHR and non-EMA-rejection signals |
| `maxSellRiskPts` | `number` | `25` | Maximum allowed risk (SL distance) in points for non-DHR signals |
| `realtimeMode` | `boolean` | `false` | If `true`, only scans the last 2 candles for signals (but pre-processes all earlier candles for zone state) |
| `instrumentName` | `string` | `''` | Instrument identifier used for log messages only |
| `superTrendData` | `Array<{superTrend, trend} \| null>` | — | Optional SuperTrend indicator; when provided, blocks counter-trend signals |

### How Parameters Influence Logic

- **`marginPoints`** is the single most impactful parameter. It controls 8+ different proximity checks: nearEMA, nearYesterdayHigh, nearPrevDayClose, nearSwingHigh, nearDayHighZone, zone pullback detection, EMA-floor check, and SL filtering. Larger values = wider tolerance zones = more signals.
- **`minSellRsi = 45`** gates non-DHR, non-EMA signals. Instruments whose RSI has already fallen below 45 will not produce these signals, preventing entries into already-exhausted moves.
- **`maxSellRiskPts = 25`** caps the stop-loss distance for all signals except Day High Zone Rejection (DHR uses a 40-point ceiling). Wide-SL setups are discarded.
- **`yesterdayHigh`** and **`prevDayClose`** act as fixed resistance ceilings. If these are far above current price (e.g., 600+ while price is at 200), they will never trigger proximity checks.
- **`prevDayLow`** is only used in the Day 1st Candle Low Break path to check whether there is a support level blocking the trade.
- **`realtimeMode`** changes `scanStartIndex` from `1` to `candles.length - 2`, making only the last 2 candles eligible for signal detection while all earlier candles are still used to compute zone state.
- **`superTrendData`**: if `trend = 'up'` at a candle, only Day High Zone Rejection and Bearish Open @ EMA signals are allowed; all others are suppressed.

---

## 3. Candle Data Structure

Each candle in the `candles` array must have:

```
{
  date:   string | Date   // ISO string or Date object (IST timezone on server)
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}
```

**Derived quantities computed per candle:**

| Variable | Formula |
|----------|---------|
| `candleBody` | `abs(close - open)` |
| `upperWick` | `high - max(open, close)` |
| `lowerWick` | `min(open, close) - low` |
| `totalRange` | `high - low` |
| `isRedCandle` | `close < open` |
| `isGreenCandle` | `close > open` |
| `isDoji` | `candleBody < totalRange * 0.1` |
| `mins` | `getHours() * 60 + getMinutes()` (IST) |

---

## 4. Strategy Logic Breakdown

### 4.1 Day-High Zone State Machine

The function maintains a rolling **resistance zone tracker** that runs on every candle regardless of time or EMA availability. State variables:

| Variable | Purpose |
|----------|---------|
| `rollingHigh` | Always-updated session high (highest `high` seen so far) |
| `confirmedResZone` | The session high that was **confirmed as resistance** by its candle structure |
| `confirmedResZoneIndex` | Candle index where `confirmedResZone` was set |
| `pulledBackFromResZone` | `true` once price pulled away from the zone (low went > 2×margin below zone) |
| `dayHighZoneTestCount` | Number of times price has re-tested the zone after pulling back |

**Zone update logic (`updateZone`) — runs on every candle:**

1. If `candle.high > rollingHigh` → new session high. Check if this candle is a **rejection candle**:
   - Body/range ratio < 0.1 (tiny body, like a doji), OR
   - Upper wick/range > 0.35 AND wick > body × 1.5 (dominant wick), OR
   - Bearish candle (close < open) with body/range > 0.35 (strong red candle at new high)
   - If any condition true → set `confirmedResZone = candle.high`, reset pullback state.
2. Pullback detection: if `confirmedResZone > 0` AND price has NOT yet pulled back AND `candle.low < confirmedResZone - margin × 2` → set `pulledBackFromResZone = true`.
3. Re-test detection: if pulled back AND `|candle.high - confirmedResZone| ≤ margin × 1.5` → increment `dayHighZoneTestCount`.

### 4.2 Scan Start Index

- **Normal mode** (`realtimeMode = false`): scan starts at index 1 (first candle is index 0, always used for reference only).
- **Realtime mode** (`realtimeMode = true`): a pre-pass calls `updateZone` on all candles before `candles.length - 2`, then scanning begins at `max(1, candles.length - 2)`.

### 4.3 First Candle Low Break Path

This is evaluated **before the time gate** and fires at most once per session.

**Entry point into this path:**
```
i > 0
AND NOT firstCandleLowBreakFired
AND firstCandleLow > 0
AND isRedCandle
AND candleClose < firstCandleLowBreakLevel
```

Where `firstCandleLow = candles[0].low` and `firstCandleLowBreakLevel = firstCandleLow` (i.e., exactly the opening candle's low).

In realtime mode, `firstCandleLowBreakFired` is pre-set to `true` if any prior candle already closed below `firstCandleLowBreakLevel`.

**Condition 1 — Valid breakdown candle** (at least one must be true):
- **Large Bearish Body**: `candleBody > totalRange × 0.4` (body is ≥ 40% of range)
- **Bearish Engulfing**: prev candle was green AND current opens at or above prev close AND current closes below prev open
- **Strong Close Near Low**: `(candleClose - candleLow) / totalRange < 0.2` (close in bottom 20% of candle range)

If none of the above: mark `firstCandleLowBreakFired = true` and skip (no weak candles retried).

**EMA Check**: If EMA exists and is **below** the close price → EMA acts as support beneath entry → skip (invalid sell).

**Stop-Loss**: `max(candleHigh, firstCandleLow) + 2`

**Risk Check**: `0 < breakRisk ≤ maxSellRiskPts` (must be positive and within 25 pts).

**Condition 2 — No nearby support within 1R below entry** (all must be false):
- `brkEMASupport`: EMA below close AND close − EMA < breakRisk
- `brkPrevDayLowSupport`: prevDayLow > 0 AND prevDayLow below close AND close − prevDayLow < breakRisk
- `brkIntradaySupport`: any prior candle low between close−breakRisk and close

If any support found → no signal. Otherwise → **signal emitted**:
```
reason: "Day 1st Candle Low Break (Bearish Engulfing | Strong Close Near Low | Large Bearish Body)"
entryPrice: candleClose
stopLoss: max(candleHigh, firstCandleLow) + 2
```

After this path runs (signal or not), `continue` is called — the candle does not proceed to resistance-zone pattern checks.

### 4.4 Time Filter (Resistance Zone Path)

```typescript
if (!candleEMA || mins < 9 * 60 + 30 || mins > 14 * 60 + 30) continue;
```

Skips the candle if:
- No EMA value available, OR
- Before 9:30 AM IST (570 mins), OR
- After 2:30 PM IST (870 mins)

### 4.5 Near Day-High Zone Check

```typescript
nearDayHighZone =
  pulledBackFromResZone
  AND confirmedResZone > 0
  AND i > confirmedResZoneIndex + 1
  AND |candleHigh - confirmedResZone| ≤ marginPoints × 1.5
```

Price must have previously pulled back from the confirmed resistance zone AND now be retesting it from below (within 1.5× margin tolerance). This flag is computed **before** the EMA trend filter and can bypass it.

### 4.6 EMA Trend Filter

```typescript
if (priceAboveEMA AND NOT highTouchesEMA AND gapFromEMA < margin × 1.5 AND NOT nearDayHighZone) → skip
```

Where:
- `priceAboveEMA = candleClose > candleEMA`
- `highTouchesEMA = |candleHigh - candleEMA| ≤ margin × 1.5`
- `gapFromEMA = |candleClose - candleEMA|`

Logic: If price is above EMA AND the high is not touching EMA AND price is within 1.5×margin of EMA AND not in day-high zone → skip. This blocks candles that are just slightly above EMA without touching it (not a valid EMA contact signal). Price **below** EMA or **high touching EMA** always proceeds.

### 4.7 Uptrend Guard

Counts all candles from session start through the current candle. If ≥ 60% of candles (with non-null EMA) **closed above** the EMA → market is in an uptrend → skip ALL patterns **except** `nearDayHighZone`.

This is a whole-session lookback with no fixed window.

### 4.8 Resistance Proximity Check

At least one must be true for the candle to proceed (unless `nearDayHighZone`):

| Check | Condition |
|-------|-----------|
| `nearEMA` | `\|candleHigh − candleEMA\| ≤ marginPoints` |
| `nearYesterdayHigh` | `yesterdayHigh > 0 AND \|candleHigh − yesterdayHigh\| ≤ marginPoints` |
| `nearPrevDayClose` | `prevDayClose > 0 AND \|candleHigh − prevDayClose\| ≤ marginPoints` |
| `nearSwingHigh` | A swing high in `swingHighs` where `swing.index < i − 3` AND `\|candleHigh − swing.price\| ≤ marginPoints` |

### 4.9 EMA Touch Rejection (emaTouchRejection)

```
nearEMA
AND isRedCandle
AND candleHigh ≥ candleEMA − margin × 0.5
AND candleClose < candleEMA
```

Red candle whose high reached within half-margin of EMA, and which closed below EMA. Computed early because it can **bypass** the candle-type gate below.

### 4.10 Candle Type Gate

The candle must be one of:
- `isRedCandle` (close < open), OR
- `isDoji` (body < range × 0.1) AND `nextIsRed`, OR
- `isGreenShootingStar` (green candle near EMA, `upperWick > body × 2` AND `upperWick > range × 0.5`, followed by red next candle), OR
- `nearDayHighZone` (day-high zone candles bypass this gate), OR
- `emaTouchRejection` (EMA-touch-rejection candles bypass this gate)

**Entry Candle Shift**: For Doji and Green Shooting Star, the **next candle** (which must be red) is used as the actual entry candle:
- `actualEntry = nextCandle`
- `actualCandleIndex = i + 1`
- All entry price / SL calculations use `actualEntry`

### 4.11 Resistance Tests Counter

Looks back at the last 4 candles (prev3, prev2, prev1, current) and counts how many had their high within `margin × 1.5` of `resistanceLevel`. Used by `weakCloseAtResistance` and `momentumSlowing` patterns.

`resistanceLevel` is chosen as:
1. `yesterdayHigh` if `nearYesterdayHigh`
2. Else the matching swing high price if `nearSwingHigh`
3. Else `candleEMA`

---

## 5. Candle Relationship Logic

### Current Candle (`candle` / `candles[i]`)
The primary candidate candle. All wick/body measurements, EMA/RSI comparisons, and zone proximity checks are computed from this candle.

### Previous Candle (`prev1 = candles[i-1]`)
Used in:
- **Bearish Engulfing pattern**: `prev1` must be green and `current` must engulf it.
- **DHR Bearish Engulfing**: same but within the Day High Zone rejection block.
- **Momentum Slowing**: body comparison `b1 = |prev1.close − prev1.open|`.
- **EMA bounce detection**: if `prev1` was green after touching EMA → counts as EMA support bounce.

### Previous 2nd Candle (`prev2 = candles[i-2]`)
Used in:
- **Momentum Slowing**: body comparison `b2 = |prev2.close − prev2.open|`. Need `b2 > b1 > body`.
- **Lower-highs check** for `bearishOpenAtEMA`: `candles[i-2].high < candles[i-3].high` OR `candles[i-1].high < candles[i-2].high`.

### Previous 3rd Candle (`prev3 = candles[i-3]`)
Used in:
- **Resistance tests counter**: checks if `prev3.high` is near resistance.
- **Lower-highs check**: `candles[i-2].high < candles[i-3].high`.

### Next Candle (`nextCandle = candles[i+1]`)
Used in:
- **Doji confirmation**: must be red.
- **Green Shooting Star confirmation**: must be red.
- **EMA bounce detection** (looking forward from each lookback candle): if the candle after an EMA touch was green, it counts as a bounce.

### First Candle (`candles[0]`)
- Its `low` defines `firstCandleLowBreakLevel`.
- Its `high` is used as the first-candle-high gate: signals where `actualClose > candles[0].high` are suppressed unless RSI > 60 or it is an EMA touch rejection.

### EMA Bounce Lookback (last 10 candles)
For `emaTouchRejection` candles, the function scans back up to 10 candles to detect if EMA acted as **support** rather than resistance. A "bounce" is: candle touched EMA (`|low − EMA| ≤ margin` or `|close − EMA| ≤ margin`) AND the **next candle** was green. If ≥ 2 bounces → `emaActsAsSupport = true` → `bearishOpenAtEMA` is suppressed.

---

## 6. Sell Signal Trigger Conditions

### Signal 1: Day 1st Candle Low Break

**Active**: At most once per session, any time after candle 0, before the 9:30 time gate.

**Required (all)**:
1. Red candle (`close < open`)
2. Close below `firstCandleLow` (candles[0].low)
3. Valid breakdown candle (body > 40% of range, OR bearish engulfing, OR close in bottom 20% of range)
4. EMA does NOT exist below close (EMA must be above or absent)
5. Risk (SL − close) > 0 AND ≤ `maxSellRiskPts`
6. **No support within 1R below entry**: not EMA support, not prevDayLow support, not any intraday candle low support

---

### Signal 2: Day High Rejection (DHR)

**Active**: 9:30 AM – 2:30 PM.

**Required (all)**:
1. Near any session or external day-high resistance: `nearDayHighZone` OR `nearYesterdayHigh` OR `nearPrevDayClose`
2. `emaFarBelowZone`: resistance level − EMA > `margin × 2` (EMA is well below the zone)
3. `emaNotSupportAtEntry`: EMA ≥ close (above) OR close − EMA ≥ margin (EMA is at least 1×margin below entry)
4. RSI > 35 (not oversold) — or RSI is null
5. Candle type: `isRedCandle` OR `isDoji` OR `isGreenShootingStar`
6. Rejection candle (at least one): upper wick > body × 1.2 OR upper wick > range × 0.4 OR bearish engulfing OR body > range × 0.5 OR doji

**Risk cap**: SL distance ≤ 40 points.

**Not subject to**: uptrend guard exception (DHR is explicitly allowed in uptrends), SuperTrend "up" suppression, RSI < minSellRsi suppression.

---

### Signal 3: Weak Close @ Resistance

**Required (all)**:
1. Near EMA, yesterdayHigh, or swingHigh
2. `candleHigh ≥ resistanceLevel × 0.99` (high reached within 1% of resistance)
3. `candleClose < candleHigh × 0.995` (close is > 0.5% below the candle high)
4. If green candle: close < open + body × 0.5 (for green candles this condition is mathematically impossible, so only red/doji candles qualify)
5. `resistanceTests ≥ 2` (resistance tested at least twice in last 4 candles)

---

### Signal 4: Bearish Open @ EMA Rejection

**Required (all)**:
1. `emaTouchRejection`: near EMA + red candle + high ≥ EMA − 0.5×margin + close < EMA
2. NOT `emaActsAsSupport` (< 2 recent EMA bounces in last 10 candles)
3. `emaBearishStructure`: at least 3 of last 6 candles closed below EMA
4. NOT `emaIsFirstCrossBelow`: not both of the 2 prior candles were above EMA
5. `emaLowerHighsForming`: at i≥3, one of `candles[i-1].high < candles[i-2].high` or `candles[i-2].high < candles[i-3].high`

**Note**: This signal is **exempt** from the RSI quality gate (RSI < minSellRsi does not suppress it).

---

### Signal 5: Early Rejection @ Resistance

**Required (all)**:
1. Near EMA, yesterdayHigh, or swingHigh
2. `upperWick > candleBody × 1.2`
3. `upperWick > totalRange × 0.4`
4. `candleClose < candleHigh × 0.99`
5. If nearEMA: `candleHigh ≥ candleEMA − margin × 0.5` (high must genuinely reach EMA)

---

### Signal 6: Momentum Slowing @ Resistance

**Required (all)**:
1. `prev2` and `prev1` both exist
2. `isRedCandle`
3. Shrinking bearish bodies: `candleBody < b1 < b2` (strictly shrinking)
4. `resistanceTests ≥ 2`

---

### Signal 7: Shooting Star @ Resistance

**Required (all)**:
1. `upperWick > candleBody × 2`
2. `lowerWick < candleBody × 0.5`
3. `upperWick > totalRange × 0.6`

---

### Signal 8: Bearish Engulfing @ Resistance

**Required (all)**:
1. `prev1` exists and is green (`prev1.close > prev1.open`)
2. `candleOpen > prev1.close`
3. `candleClose < prev1.open`
4. `isRedCandle`

---

### Signal 9: Strong Rejection @ Resistance

**Required (all)**:
1. `isRedCandle`
2. `upperWick > candleBody × 2`
3. `upperWick > totalRange × 0.5`
4. `candleClose < candleOpen × 0.98`

---

### Signal Priority (when multiple patterns match)

```
1. Day High Rejection
2. Weak Close @ Resistance
3. Bearish Open @ EMA Rejection
4. Early Rejection @ Resistance
5. Momentum Slowing @ Resistance
6. Shooting Star @ Resistance
7. Bearish Engulfing @ Resistance
8. Strong Rejection @ Resistance
```

Only **one** signal reason per candle is reported (highest priority match).

---

## 7. Strategy Flow (Step-by-Step)

```
FOR each candle i from 1 to end:

  ── Path A: First Candle Low Break ───────────────────────────────────
  1. Is this the first time checking, candle is red, AND close < firstCandleLow?
     a. Does the breakdown candle qualify? (large body / engulfing / strong close near low)
        → NO: mark fired, skip candle
        → YES: continue
     b. Is EMA below close? → skip (EMA is support)
     c. Calculate SL = max(candleHigh, firstCandleLow) + 2; risk = SL − close
     d. Is risk > 0 AND ≤ maxSellRiskPts? → NO: skip
     e. Is there any support below entry within 1R? → YES: skip
     f. ✓ Emit signal: "Day 1st Candle Low Break"
     → CONTINUE (skip Path B for this candle)

  ── Path B: Resistance Zone Patterns ─────────────────────────────────
  2. Update day-high zone state (updateZone)
  3. Time gate: skip if no EMA OR before 9:30 OR after 14:30
  4. Compute nearDayHighZone (zone re-test after pullback)
  5. EMA trend filter: skip if price above EMA and not near/touching it (unless nearDayHighZone)
  6. Uptrend guard: skip if ≥60% of session candles above EMA (unless nearDayHighZone)
  7. Resistance check: skip if candle high not near any resistance level
  8. Compute emaTouchRejection flag
  9. Candle type gate: skip if not red/doji/shootingStar/nearDHZ/emaTouchRejection
 10. Handle entry candle shift for Doji and Green Shooting Star (use next red candle)
 11. Compute context: prev1, prev2, prev3, resistanceTests
 12. Evaluate all 8 patterns: DHR, weakClose, bearishOpenAtEMA, earlyRejection,
     momentumSlowing, shootingStar, bearishEngulfing, strongRejection
 13. Signal reason: assign highest-priority pattern that matched
 14. No match → skip
 15. First-candle-high gate: if actualClose > candles[0].high AND RSI ≤ 60 AND NOT emaTouchRejection → skip
 16. RSI quality gate: if NOT (DHR or bearishOpenAtEMA) AND RSI < minSellRsi → skip
 17. Calculate SL (swing-high-aware):
     a. Find recent swing highs within [entry, entry+30] and ≥ 8 pts above entry (last 10 candles)
     b. If found: SL = nearestSwing.price + 2
     c. Else: SL = actualClose + 30
 18. Risk cap: if NOT DHR AND risk > maxSellRiskPts → skip
                if DHR AND risk > 40 → skip
 19. SuperTrend filter: if ST trend='up' AND NOT (DHR or bearishOpenAtEMA) → skip
 20. EMA support floor: if NOT bearishOpenAtEMA AND EMA below entry AND entry − EMA < risk → skip
 21. ✓ Emit signal with all metadata
```

---

## 8. Example Scenario

### Example: Day 1st Candle Low Break

**Setup:**
- Instrument: NIFTY2631723350CE
- `marginPoints = 20`, `maxSellRiskPts = 25`
- `firstCandleLow = candles[0].low = 287.75` (the opening 9:15 AM candle)
- `prevDayLow = 422.7` (far above current prices — irrelevant)

**Candle at i=5** (09:40 AM IST):

| Field | Value |
|-------|-------|
| open | 298.35 |
| high | 301.75 |
| low | 286.65 |
| close | 286.75 |
| EMA | 406.47 |

**Evaluation:**

1. `isRedCandle`? YES (286.75 < 298.35)
2. `candleClose (286.75) < firstCandleLowBreakLevel (287.75)`? YES
3. Breakdown candle check:
   - `candleBody = |286.75 − 298.35| = 11.6`
   - `totalRange = 301.75 − 286.65 = 15.1`
   - `brkLargeBearishBody`: 11.6 > 15.1 × 0.4 = 6.04 → **YES**
4. EMA (406.47) below close (286.75)? NO (EMA is above) → proceed
5. `SL = max(301.75, 287.75) + 2 = 303.75`
6. `risk = 303.75 − 286.75 = 17` → within 25 → proceed
7. Support below entry check:
   - `prevDayLow (422.7) < close (286.75)`? NO → no prevDayLow support
   - Intraday candle lows (candles 1–4): `candle[1].low = 280.1`. Is 280.1 < 286.75? YES. Is 286.75 − 280.1 = 6.65 < 17? YES → **brkIntradaySupport = true**
8. Support found → **signal is BLOCKED**

**Result**: `firstCandleLowBreakFired = true` set. No signal generated. All subsequent candles skip this path entirely.

---

### Example: Day High Zone Rejection

**Setup:**
- Instrument: NIFTY2631723550PE
- `marginPoints = 20`, `yesterdayHigh = 283.65`

**Candle at i=13** (10:05 AM IST, `swingHighs` include `{price:369, index:13}`):

| Field | Value |
|-------|-------|
| open | 356.65 |
| high | 369.00 |
| low | 344.55 |
| close | 360.35 |
| EMA | 288.22 |
| RSI | 81.57 |

**Evaluation (as a normal resistance signal):**

1. Time gate: 10:05 AM IST → passes
2. `nearDayHighZone`: requires pullback from zone — need to trace state, but assume confirmedResZone not yet set above 369 as this is the swing high candle itself
3. `nearEMA`: |369 − 288.22| = 80.78 > 20 → NO
4. `nearYesterdayHigh`: |369 − 283.65| = 85.35 > 20 → NO
5. Resistance check fails → **candle skipped**

The PE instrument showed a strong uptrend (prices rising from 280 to 510+), EMA trailing well behind price. Since the SuperTrend is in "down" (confusingly, from the PE perspective, the instrument itself is rising). Most candles close above EMA (uptrend guard would fire) → non-DHR signals suppressed. DHR requires the zone and EMA checks above.

---

### Why "No SELL signals found" for NIFTY2631723350CE

Given the actual parameters:
- `yesterdayHigh = 612.95` — far above all candle prices (150–340 range) → `nearYesterdayHigh` never true
- `prevDayClose = 457.1` — far above all prices → `nearPrevDayClose` never true
- EMA values start at 478 and decline to ~169, but prices fall faster → EMA stays well above price → `nearEMA` rarely true
- When EMA eventually comes close to candle highs (around candles 26–32), the EMA had acted as support in those prior candles (2 bounces detected: candles 26 and 27) → `emaActsAsSupport = true` → `bearishOpenAtEMA` suppressed
- `swingHighs` at 262.9, 285.1, and 203.4 are too far from candle highs in most candles to trigger `nearSwingHigh`
- SuperTrend is in "up" trend for indices 9–31 → blocks non-DHR signals
- First candle low break at i=5: blocked by `candle[1].low = 280.1` being within 1R below entry (intraday support found)

All these filters combined result in zero signals for this instrument on this session.

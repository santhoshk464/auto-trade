# V3 Strategy Change Log

---

## 2026-03-15 — Refactor: Split P1 into Zone-Specific Branches + Tighten P2b

**File:** `apps/api/src/kite/services/kite.service.ts`  
**Function:** `detectDaySellSignalsV3`

### Problems Fixed

**Problem 1 — Broad P1 resistance block caused mismatched labels**  
One generic block handled all five zone types under a single condition  
(`nearAnyResistance && (isRedCandle || isDoji) + dhrRejection`). Whichever zone  
happened to match first won the label. This meant a candle near a prev-day-close  
could be labelled "Resistance Rejection" or even get routed through intraday-high  
logic, producing output that didn't match the chart.

**Problem 2 — Bullish/uptrend protection inconsistent across zones**  
Only `isHighBasedZone` (intraday high + prev day high) had the  
`!(isUptrend || bullishRegime)` guard. Prev Day Close, First Candle High,  
and Swing High could fire in a clearly bullish market.

**Problem 3 — P2b EMA Fake Break was a loose fallback**  
P2b used a 2-period `emaTrendingDown` slope (weaker than P2's 3-period  
`emaSlopingDown`), had no `lowerHighForming` requirement, no `noRecentBullRun`  
filter, no `emaBounces < 2` guard, and required no body-quality check.  
It could therefore fire signals that P2 would have rejected.

### Changes Applied

#### 1. Shared variables moved before P1 branches

These are now computed once in the outer loop body and reused by all branches:

| Variable                                                                  | Meaning                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `rejUpperWick`, `rejBearishEngulf`, `rejShootingStar`, `rejStrongBearish` | Individual rejection patterns                      |
| `candleRejection`                                                         | Any of the above or `isDoji`                       |
| `lowerHighForming`                                                        | `prev1.high < prev2.high`                          |
| `weakCloseFromHigh`                                                       | close in bottom 60% of candle range                |
| `noRecentBullRun`                                                         | No 3-green-rising-high candles before this one     |
| `inBullishContext`                                                        | `isUptrend \|\| bullishRegime`                     |
| `dhrBearishContext`                                                       | `bearishRegime \|\| (emaDown && lowerHighForming)` |
| `candlePattern`                                                           | Human-readable rejection pattern label             |

#### 2. P1 split into five independent zone branches

| Branch                              | Zone                     | Gate                                                                                           |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| **P1a** Intraday High Rejection     | `intradayDayHigh`        | `candleRejection + weakCloseFromHigh + !inBullishContext + dhrBearishContext`, score ≥ 4       |
| **P1b** Prev Day High Rejection     | `yesterdayHigh`          | Same as P1a                                                                                    |
| **P1c** Prev Day Close Rejection    | `prevDayClose`           | `candleRejection + !inBullishContext + (bearishRegime\|emaDown\|lowerHighForming)`, score ≥ 4  |
| **P1d** First Candle High Rejection | `firstCandleHigh`        | Same as P1c                                                                                    |
| **P1e** Swing High Rejection        | `matchedSwingHigh.price` | `candleRejection + !inBullishContext + dhrBearishContext`, score ≥ 4 (strong context required) |

Each branch: checks its own `!usedZones.*` / `!usedSwingHighLevels` gate, sets  
`signalZoneRef` to the actual zone price, and builds the signal with the correct  
zone-specific label.

#### 3. P2 duplicate variable declarations removed

`const lowerHighForming` and `const noRecentBullRun` were removed from inside  
P2's inner scope — they now refer to the shared outer-scope versions.

#### 4. P2b tightened to match P2 quality standard

| Filter               | P2b before                 | P2b after                       |
| -------------------- | -------------------------- | ------------------------------- |
| EMA slope            | 2-period `emaTrendingDown` | **3-period `emaSlopingDownFb`** |
| Lower-high structure | not required               | **`lowerHighForming` required** |
| No recent bull run   | not required               | **`noRecentBullRun` required**  |
| EMA bounce guard     | not present                | **`emaBouncesFb < 2` required** |
| `belowCountFb >= 2`  | present                    | kept                            |
| Score threshold      | ≥ 3                        | kept                            |

---

## 2026-03-15 — Fix False "Day High Rejection" Signals

**File:** `apps/api/src/kite/services/kite.service.ts`  
**Function:** `detectDaySellSignalsV3`

### Root Cause

The old code used a price-percentage based dynamic margin:

```ts
const dynMargin = Math.max(marginPoints, candleClose * 0.03);
```

For NIFTY near 24600 this evaluated to `24600 * 0.03 = 738 points`.

The `nearIntradayHigh` check then used `dynMargin * 0.3 = 221 points` as the
proximity threshold:

```ts
const nearIntradayHigh =
  intradayDayHigh > 0 && candleHigh >= intradayDayHigh - dynMargin * 0.3;
```

This meant a candle that was **115 points below the day high** still qualified
as "near intraday high", producing false Day High Rejection signals.

The `isNearDailyHigh` flag was equally broken:

```ts
isNearDailyHigh: rollingHigh - candleHigh <= dynMargin * 3,
// → 738 * 3 = 2214 points — almost always true
```

### Fix Applied

Replaced the oversized dynamic margin with a **fixed absolute margin** equal to
`marginPoints` (e.g. 20 points):

```ts
// Before
const dynMargin = Math.max(marginPoints, candleClose * 0.03);

// After
const zoneMargin = marginPoints; // e.g. 20 points — no price-% scaling
```

All resistance-proximity conditions updated to use strict `Math.abs()` distance:

| Condition                              | Old                                               | New                                                    |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `nearIntradayHigh`                     | `candleHigh >= intradayDayHigh - dynMargin * 0.3` | `Math.abs(candleHigh - intradayDayHigh) <= zoneMargin` |
| `nearPrevDayHigh`                      | `Math.abs(...) <= dynMargin`                      | `Math.abs(...) <= zoneMargin`                          |
| `nearPrevDayClose`                     | `Math.abs(...) <= dynMargin`                      | `Math.abs(...) <= zoneMargin`                          |
| `nearFirstCandleHigh`                  | `Math.abs(...) <= dynMargin`                      | `Math.abs(...) <= zoneMargin`                          |
| `nearSwingHigh`                        | `Math.abs(...) <= dynMargin * 0.6`                | `Math.abs(...) <= zoneMargin * 0.6`                    |
| `isNearDailyHigh` (all 5 result sites) | `rollingHigh - candleHigh <= dynMargin * 3`       | `Math.abs(rollingHigh - candleHigh) <= zoneMargin`     |

Zone-memory cooldown also tightened:

```ts
// Before: dynMargin * 0.8
// After:  zoneMargin  (no multiplier)
Math.abs(candleHigh - lastSignalPrice) <= zoneMargin;
```

EMA-distance checks inside P2/P2b/P3/P4 updated to use `zoneMargin` as well.

### Effect

- A candle must now be within `marginPoints` (e.g. 20 pts) of the day high to
  trigger a Day High Rejection — eliminating the 115-pt false-signal example.
- `isNearDailyHigh` now only returns `true` when the candle is genuinely close
  to the rolling high, not 2000+ points away.
- No other strategy logic changed; only the threshold width was corrected.

---

## 2026-03-15 — Generic Redesign: Swing High, Zone Memory, Duplicate Suppression

**File:** `apps/api/src/kite/services/kite.service.ts`  
**Function:** `detectDaySellSignalsV3`

### Problems Fixed

**Problem 1 — False Swing High Rejection**  
The old `swingHighs.some(...)` check returned `true` for any registered pivot
within distance, including stale, weak, or already-broken ones. A candle could
fire a "Swing High Rejection" signal against a pivot that was broken weeks ago
or several hundred candles back.

**Problem 2 — Wrong zone reference for swing-high signals**  
When a swing-high triggered the signal, `signalZoneRef` fell back to `candleHigh`
instead of the actual matched swing-high price, making the duplicate-suppression
window point to the wrong level and allowing repeated signals on the same pivot.

**Problem 3 — Repeated major-zone rejections**  
`prevDayClose`, `prevDayHigh`, `intradayHigh`, and `firstCandleHigh` could fire
multiple times per session. There was no session-scoped "already used" tracking.

**Problem 4 — Generic one-block resistance logic**  
All five zone types shared a single rejection block with no per-zone rules, making
the logic too broad.

### Changes Applied

#### A. Three helper closures added before the loop

```ts
const isSwingBroken(sh, upToIndex): boolean
```

Returns `true` if any candle between the pivot and current index closed
decisively above the pivot (by `zoneMargin * 0.5`). Prevents signals from
already-broken pivots.

```ts
const isSwingRelevant(sh, currentIndex): boolean
```

Returns `true` only if the pivot is ≤ 40 bars old AND has a proper pivot
structure (lower candle on each side).

```ts
const findMatchedSwingHigh(candleHighValue, currentIndex)
```

Filters swing highs through `isSwingRelevant`, `isSwingBroken`, and a
`zoneMargin * 0.75` proximity window, then sorts by recency (most recent first).
Returns the best candidate or `null`.

#### B. Replaced `nearSwingHigh = swingHighs.some(...)` with matched selection

```ts
// Before
const nearSwingHigh = swingHighs.some(
  (sh) =>
    sh.index < i - 3 && Math.abs(candleHigh - sh.price) <= zoneMargin * 0.6,
);

// After
const matchedSwingHigh = findMatchedSwingHigh(candleHigh, i);
const nearSwingHigh = !!matchedSwingHigh;
```

#### C. Session-level zone usage memory (initialized before the loop)

```ts
const usedZones = {
  intradayHigh: false,
  prevDayHigh: false,
  prevDayClose: false,
  firstCandleHigh: false,
};
const usedSwingHighLevels = new Set<number>();
```

#### D. Zone-usage gate added in P1 before signal creation

```ts
const zoneUsageOk =
  (nearIntradayHigh && !usedZones.intradayHigh) ||
  (nearPrevDayHigh  && !usedZones.prevDayHigh)  ||
  (nearPrevDayClose && !usedZones.prevDayClose) ||
  (nearFirstCandleHigh && !usedZones.firstCandleHigh) ||
  (nearSwingHigh && !!matchedSwingHigh && !usedSwingHighLevels.has(matchedSwingHigh.price));

if (zoneUsageOk && score >= 3) { ... }
```

#### E. Fixed `signalZoneRef` to use actual matched swing-high price

```ts
signalZoneRef = ...
  : nearSwingHigh && matchedSwingHigh
    ? matchedSwingHigh.price   // was: candleHigh (wrong)
    : candleHigh;
```

Swing-high label in reason string now also includes the actual price:
`swing high 24520` instead of generic `swing high`.

#### F. Zones marked as used after signal is pushed

```ts
if (nearIntradayHigh) usedZones.intradayHigh = true;
if (nearPrevDayHigh) usedZones.prevDayHigh = true;
if (nearPrevDayClose) usedZones.prevDayClose = true;
if (nearFirstCandleHigh) usedZones.firstCandleHigh = true;
if (nearSwingHigh && matchedSwingHigh)
  usedSwingHighLevels.add(matchedSwingHigh.price);
```

#### G. `zoneMargin` moved before the loop

Since it no longer depends on `candleClose` (static = `marginPoints`), it is
now declared once before the loop instead of re-computed every candle. The three
helper closures also reference it directly.

### Configurable Defaults (used in helpers)

| Parameter           | Default             | Description                                |
| ------------------- | ------------------- | ------------------------------------------ |
| `maxBarsAge`        | 40                  | Ignore pivots older than this many candles |
| `minBarsAfterSwing` | 3                   | Pivot must be at least this many bars old  |
| `swingZoneMargin`   | `zoneMargin * 0.75` | Proximity window for swing match           |
| `breakBuffer`       | `zoneMargin * 0.5`  | Close above this = pivot broken            |

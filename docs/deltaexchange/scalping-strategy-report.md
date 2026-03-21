# Delta Exchange — Scalping Strategy: Detailed Report

**Strategy ID:** `SCALPING`  
**Asset classes:** Crypto perpetual futures (XRPUSD, SOLUSD, BTCUSD, ETHUSD, …)  
**Base interval:** 5 m  
**Bias interval:** 15 m (derived by grouping every 3 × 5 m candles)  
**Indicator:** EMA 20 (both timeframes)  
**Risk model:** Fixed 1 : 2 RRR with break-even trail at 1R  
**Implementation:** `apps/api/src/delta/services/delta.service.ts` – private helpers + `SCALPING` branch inside `findTradeSignals()`

---

## 1 · Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  RAW 5m CANDLES  (fetched via Delta Public Candles API)              │
│                                                                       │
│  ┌──────────────┐    group 3:1    ┌──────────────┐                  │
│  │  5m candles  │ ──────────────► │  15m candles │  (HTF bias)      │
│  │  EMA 20 (5m) │                 │  EMA 20 (15m)│                  │
│  │  ATR 14      │                 │  HH/HL logic │                  │
│  └──────────────┘                 └──────────────┘                  │
│         │                                │                           │
│         │                   ┌────────────┘                          │
│         │                   ▼                                        │
│         │           getHTFBias() ──► BULLISH / BEARISH / NEUTRAL    │
│         │                   │                                        │
│         ▼                   ▼                                        │
│   ┌─────────────────────────────────────────┐                       │
│   │  Setup scanner (per 5m candle)          │                       │
│   │  1. checkTrendPullback()                │                       │
│   │  2. checkLiquiditySweep()               │                       │
│   │  3. checkEmaRejection()                 │                       │
│   └─────────────────────────────────────────┘                       │
│         │                                                            │
│         ▼                                                            │
│   Forward simulation → SL / 1R-BE / 2R Target                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2 · Pre-filters (applied before any setup runs)

| Filter             | Rule                               | Purpose                                       |
| ------------------ | ---------------------------------- | --------------------------------------------- |
| Min candle history | i ≥ 30                             | All indicators need lookback                  |
| HTF index          | htfIdx ≥ 20                        | Need 20 × 15m bars for EMA 20 HTF to be valid |
| ATR filter         | `atr14[i] ≥ close × 0.001` (0.1 %) | Skip candles in a choppy / compressed market  |

---

## 3 · HTF Bias — `getHTFBias()`

Derived from the **synthetic 15 m candles** (3 base candles merged).

### Algorithm

1. Take the last 8 HTF candles at the current index.
2. Split them into two halves (older / recent).
3. Compare their swing highs and lows:
   - **HH + HL** → higher highs and higher lows
   - **LH + LL** → lower highs and lower lows
4. Combine with close vs EMA 20 position:

| Price vs EMA 20 | Market Structure | → Bias               |
| --------------- | ---------------- | -------------------- |
| above EMA       | HH + HL          | **BULLISH** (strong) |
| above EMA       | anything else    | **BULLISH** (weak)   |
| below EMA       | LH + LL          | **BEARISH** (strong) |
| below EMA       | anything else    | **BEARISH** (weak)   |
| equal           | —                | **NEUTRAL**          |

> **NEUTRAL bias = no trade for any setup.** All three setups skip the candle when HTF is neutral.

---

## 4 · Setup 1 — Trend Pullback

**Concept:** In a trending market, price pulls back to EMA 20, then the entry candle confirms continuation.

### BUY Conditions

```
HTF Bias:  BULLISH
─────────────────────────────────────────
FILTER 1   prev.low  ≤ emaP × 1.003          ← previous candle dipped into EMA zone
           prev.low  ≥ emaP × 0.997          ← within ±0.3% of previous EMA value
FILTER 2   c.close > c.open                  ← current candle is bullish
FILTER 3   AT LEAST ONE of:
           a) c.close > ema                  ← close above current EMA
           b) c.close > prev.high            ← engulfing (body swallows prev candle)
              AND c.open ≤ prev.close
           c) lowerWick / range > 30 %       ← strong lower wick rejection
```

Signal ID in reason string: **`"Trend Pullback BUY"`**

### SELL Conditions

```
HTF Bias:  BEARISH
─────────────────────────────────────────
FILTER 1   prev.high ≥ emaP × 0.997         ← previous candle pierced EMA zone
           prev.high ≤ emaP × 1.003
FILTER 2   c.close < c.open                  ← current candle is bearish
FILTER 3   AT LEAST ONE of:
           a) c.close < ema                  ← close below EMA
           b) c.close < prev.low             ← engulfing down
              AND c.open ≥ prev.close
           c) upperWick / range > 30 %       ← strong upper wick rejection
```

Signal ID in reason string: **`"Trend Pullback SELL"`**

### Stop-Loss (shared with all setups — see § 7)

- **BUY SL:** swing low of last 3 candles × 0.999
- **SELL SL:** swing high of last 3 candles × 1.001

---

## 5 · Setup 2 — Liquidity Sweep

**Concept:** Market makers sweep a pool of stop orders below a swing low (or above a swing high). Once the liquidity is collected the price reverses sharply. We enter on the reversal candle.

### BUY Conditions

```
HTF Bias:  NOT BEARISH (neutral or bullish)
─────────────────────────────────────────
STEP 1     Identify swing low of last 10 candles (lookback = 10)
STEP 2     prev.low  < swingLow               ← sweep candle pierced below the low
STEP 3     c.close   > swingLow               ← current candle reclaimed above the level
           c.close   > c.open                  ← bullish close
           bodyStr   > 40 %                    ← strong body (body / range > 0.4)
```

`bodyStr = |close − open| / (high − low)`

Signal ID in reason string: **`"Liquidity Sweep BUY"`**  
Reason also reports the swept swing-low price: `swept swing low (X.XXXX)`

### SELL Conditions

```
HTF Bias:  NOT BULLISH (neutral or bearish)
─────────────────────────────────────────
STEP 1     Identify swing high of last 10 candles
STEP 2     prev.high > swingHigh              ← sweep candle pierced above the high
STEP 3     c.close   < swingHigh              ← current candle rejected back below
           c.close   < c.open                  ← bearish close
           bodyStr   > 40 %
```

Signal ID in reason string: **`"Liquidity Sweep SELL"`**  
Reason reports: `swept swing high (X.XXXX)`

---

## 6 · Setup 3 — EMA Rejection

**Concept:** A high-quality wick rejection directly off the 20 EMA — not just a touch, but a notable wick with a clean close on the correct side, and the EMA must have a directional slope (not flat/sideways).

### BUY Conditions

```
HTF Bias:  BULLISH
─────────────────────────────────────────
FILTER 1   c.low ≤ ema × 1.002               ← candle wick reached EMA (within 0.2% above)
           c.low ≥ ema × 0.993               ← but not more than 0.7% below EMA
FILTER 2   c.close > ema                     ← close above EMA
FILTER 3   lowerWick > body × 1.2            ← wick length > 120% of body
           lowerWick / range > 30 %          ← wick uses > 30% of total candle range
FILTER 4   c.close > c.open                  ← bullish candle
FILTER 5   |ema − ema[i−5]| / ema[i−5]      ← EMA slope over 5 bars
           > 0.05% (0.0005)                  ← NOT flat/sideways
```

Signal ID in reason string: **`"EMA Rejection BUY"`**  
Reason reports EMA value: `strong lower wick off EMA20 (X.XXXX), close above EMA`

### SELL Conditions

```
HTF Bias:  BEARISH
─────────────────────────────────────────
FILTER 1   c.high ≥ ema × 0.998             ← wick reached EMA zone (within 0.2% below)
           c.high ≤ ema × 1.007             ← not more than 0.7% above EMA
FILTER 2   c.close < ema                    ← close below EMA
FILTER 3   upperWick > body × 1.2
           upperWick / range > 30 %
FILTER 4   c.close < c.open                 ← bearish candle
FILTER 5   EMA slope > 0.05%               ← NOT flat
```

Signal ID in reason string: **`"EMA Rejection SELL"`**  
Reason reports: `strong upper wick off EMA20 (X.XXXX), close below EMA`

---

## 7 · Stop-Loss, Break-Even & Target Logic

Every signal — regardless of setup — goes through the same **forward simulation** engine.

### Entry

`entry = close of the signal candle`

### Stop-Loss Calculation

```
BUY   swingLow  = min(low) of last 3 candles (null-safe)
      stopLoss  = swingLow × 0.999          ← 0.1% buffer below swing low
      fallback  = entry × 0.99              ← if risk would be ≤ 0

SELL  swingHigh = max(high) of last 3 candles
      stopLoss  = swingHigh × 1.001
      fallback  = entry × 1.01
```

`risk = |entry − stopLoss|`

### Levels

| Level         | Formula            | Meaning                     |
| ------------- | ------------------ | --------------------------- |
| `stopLoss`    | entry ∓ risk × 1.0 | Initial hard stop           |
| `target1R`    | entry ± risk × 1.0 | 1 : 1 — triggers Break-Even |
| `target` (2R) | entry ± risk × 2.0 | 1 : 2 — final take-profit   |

### Break-Even Trail

```
Phase 1 (before 1R hit):
  trade open, trailingSL = stopLoss

Phase 2 (after 1R touched by any forward candle):
  beActivated = true
  trailingSL  = entry   ← SL moves to cost price

Phase 3 (outcome):
  forward candle hits trailingSL while beActivated  → outcome = BE  (0 R)
  forward candle hits target2R                      → outcome = TARGET (+2 R)
  forward candle hits trailingSL before beActivated → outcome = SL  (−1 R)
  no forward candle closes the trade                → outcome = OPEN (unrealised)
```

### P&L Calculation

```
refPrice  = exitPrice  (if closed) | last candle close (if OPEN)
pnlPoints = refPrice − entry   (BUY)  | entry − refPrice  (SELL)
pnlPct    = (pnlPoints / entry) × 100
```

---

## 8 · Signal Reason String Reference

Each row in the trade-finder table shows a **Reason** column. Use this table to decode it:

| Reason prefix                                                                        | Setup           | Direction | Key data encoded                                       |
| ------------------------------------------------------------------------------------ | --------------- | --------- | ------------------------------------------------------ |
| `Trend Pullback BUY: HTF bullish, pulled back to EMA20 (X.XXXX), engulfing`          | Trend Pullback  | Long      | EMA20 value at signal candle; confirmation = engulfing |
| `Trend Pullback BUY: HTF bullish, pulled back to EMA20 (X.XXXX), wick rejection`     | Trend Pullback  | Long      | confirmation = strong lower wick                       |
| `Trend Pullback SELL: HTF bearish, pulled back to EMA20 (X.XXXX), engulfing`         | Trend Pullback  | Short     | EMA20 at signal; confirmation = engulfing down         |
| `Trend Pullback SELL: HTF bearish, pulled back to EMA20 (X.XXXX), wick rejection`    | Trend Pullback  | Short     | confirmation = strong upper wick                       |
| `Liquidity Sweep BUY: swept swing low (X.XXXX), reclaimed with strong bullish body`  | Liquidity Sweep | Long      | The exact swing-low level that was swept               |
| `Liquidity Sweep SELL: swept swing high (X.XXXX), rejected with strong bearish body` | Liquidity Sweep | Short     | The exact swing-high level that was swept              |
| `EMA Rejection BUY: strong lower wick off EMA20 (X.XXXX), close above EMA`           | EMA Rejection   | Long      | EMA20 value; wick + close confirmed                    |
| `EMA Rejection SELL: strong upper wick off EMA20 (X.XXXX), close below EMA`          | EMA Rejection   | Short     | EMA20 value; wick + close confirmed                    |

---

## 9 · Candle Log — How to Read a Signal Row

Below is an annotated example of what each column means when you see a SCALPING signal in the trade-finder table:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ #   Entry Time           Signal  Entry $   SL $       1R/BE $   Target(2R)$ │
│ 1   2026-03-10 09:15 UTC  BUY    2.4820    2.4571      2.5069    2.5318     │
│                                   └──▲──┘  └──▲──┘    └──▲──┘   └──▲──┘   │
│                                  close     swing      +1×risk   +2×risk    │
│                                  of sig.   low × 0.999            (target) │
│                                  candle                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Outcome  Exit $   Exit Time            P&L $   P&L %   Reason              │
│ TARGET   2.5318   2026-03-10 11:45 UTC +0.0498  +2.00%  Trend Pullback BUY:│
│                                                          HTF bullish,       │
│                                                          pulled back to     │
│                                                          EMA20 (2.4795),    │
│                                                          engulfing          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Column-by-column decoder

| Column            | What it shows                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **Entry Time**    | ISO timestamp of the 5m candle that triggered the signal                                                     |
| **Signal**        | `BUY` (long) or `SELL` (short)                                                                               |
| **Entry $**       | `close` price of the signal candle — this is your trade entry                                                |
| **Stop Loss $**   | Hard stop = swing extreme of last 3 candles ± 0.1% buffer                                                    |
| **1R/BE Level $** | Once price reaches this level, SL automatically moves to entry (break-even)                                  |
| **Target (2R) $** | Final take-profit at 2× risk from entry                                                                      |
| **Outcome**       | `TARGET` hit 2R ✓ · `SL` stopped out full loss · `BE` stopped at entry (0 loss) · `OPEN` trade still running |
| **Exit $**        | Price at which the trade was closed by the simulation; `—` if OPEN                                           |
| **Exit Time**     | Timestamp of the forward candle that closed the trade                                                        |
| **P&L $**         | `exitPrice − entry` (BUY) or `entry − exitPrice` (SELL); unrealised if OPEN                                  |
| **P&L %**         | Same, expressed as a percentage of entry price                                                               |
| **Reason**        | Encoded string — see § 8 for full decode table                                                               |

---

## 10 · Outcome Badge Colour Key

| Badge    | Colour | Meaning                                                                 |
| -------- | ------ | ----------------------------------------------------------------------- |
| `TARGET` | Green  | Hit 2R take-profit. Full win.                                           |
| `SL`     | Red    | Hit initial stop-loss before 1R was reached. Full loss.                 |
| `BE`     | Blue   | Hit 1R first (SL moved to entry), then stopped at entry. Scratch trade. |
| `OPEN`   | Yellow | No exit found within the scanned date range. P&L is unrealised.         |

---

## 11 · Setup Comparison Matrix

|                           | Trend Pullback                      | Liquidity Sweep                  | EMA Rejection                  |
| ------------------------- | ----------------------------------- | -------------------------------- | ------------------------------ |
| **HTF bias required**     | Strict (BULLISH or BEARISH only)    | Relaxed (neutral allowed)        | Strict                         |
| **Entry trigger**         | Confirmation candle after EMA touch | Reclaim candle after sweep       | Wick rejection candle FROM EMA |
| **Key signal candle**     | Current `i`                         | Current `i` (prev `i-1` = sweep) | Current `i`                    |
| **Body strength needed?** | No                                  | Yes (> 40%)                      | No                             |
| **Wick strength needed?** | Optional (confirmation option)      | No                               | Yes (wick > 120% of body)      |
| **EMA slope filter?**     | No                                  | No                               | Yes (> 0.05% over 5 bars)      |
| **Best market condition** | Clean trending market               | Sudden spike/stop-hunt reversal  | Trending with EMA tests        |

---

## 12 · Recommended Use

- Run on **5 m interval** with a lookback of **7–14 days** to get a meaningful sample.
- Symbols with best results: **XRPUSD**, **SOLUSD** (designed for these), also **BTCUSD**, **ETHUSD**.
- Filter out `OPEN` outcomes when analysing performance (they distort win rate).
- Win rate benchmark: 45–55% expected; a good day-trading strategy with 1:2 RRR breaks even at 34% win rate.
- Use **Summary Cards** on the page to compare Win Rate % and Total P&L % across strategies and symbols.

---

## 13 · Parameters Reference

| Parameter                 | Default           | Location                              | Effect                        |
| ------------------------- | ----------------- | ------------------------------------- | ----------------------------- |
| HTF group size            | 3                 | `SCALPING` block                      | 3 × 5m = 15m HTF              |
| EMA period (5m & 15m)     | 20                | `calcEMA(closes, 20)`                 | Pullback / rejection level    |
| ATR period                | 14                | `calcATR(candles, 14)`                | Volatility filter             |
| ATR chop threshold        | 0.1% of price     | `atr < closes[i] * 0.001`             | Skip silent markets           |
| Liquidity sweep lookback  | 10 bars           | `checkLiquiditySweep(…, lookback=10)` | Swing high/low window         |
| EMA near-zone (pullback)  | ±0.3%             | `emaP × 0.997 … 1.003`                | How close prev candle must be |
| EMA near-zone (rejection) | −0.7% to +0.2%    | `ema × 0.993 … 1.002`                 | Candle wick touch zone        |
| EMA slope min (rejection) | 0.05% over 5 bars | `emaSlope < 0.0005` → skip            | Avoid flat EMA entries        |
| SL swing lookback         | 3 candles         | `candles.slice(i-2, i+1)`             | Determines risk distance      |
| SL buffer                 | 0.1%              | `swingLow × 0.999`                    | Below/above swing             |
| RRR                       | 1 : 2             | `risk * 2`                            | Target = 2× risk from entry   |
| BE trigger                | 1R                | `fc.high >= target1R`                 | Move SL to entry              |
| Min candle start          | i ≥ 30            | loop start in SCALPING block          | Warmup period                 |

---

_Generated: 2026-03-16 — auto-trade / docs / deltaexchange_

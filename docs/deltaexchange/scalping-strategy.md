You are a senior quantitative trading system developer and Node.js algo architect.

I already have my own local algo trading infrastructure built using the Delta Exchange API in Node.js. Do NOT build a Pine Script strategy. Do NOT build a TradingView-only script. I need a real rule-based strategy module that can be implemented inside my existing Node.js trading bot.

Your task is to design and code a complete intraday crypto scalping strategy for XRPUSD and SOLUSD using these 3 core setups:

1. Trend + Pullback
2. Liquidity Sweep
3. Strong 20 EMA Rejection

The strategy must support both:

- Buy / Long
- Sell / Short

The output must be practical, automation-friendly, and directly usable in a Node.js algo trading environment.

---

## PROJECT CONTEXT

I already have:

- Delta Exchange API integration
- live market data handling
- candle generation
- order execution
- position management
- stop-loss / target handling framework

So do NOT waste time explaining exchange setup or generic API connection code unless needed for the strategy module.

What I need from you is:

- the full strategy logic
- rule-based buy/sell conditions
- filters to avoid bad trades
- confirmation logic
- stop-loss logic
- take-profit logic
- Node.js strategy code structure
- reusable functions
- config-driven parameters

---

## MAIN GOAL

Build a robust scalping strategy for XRPUSD and SOLUSD that:

- works on low timeframes
- avoids choppy entries
- is based on trend, pullback, liquidity, and rejection
- is strict enough for automation
- minimizes false signals
- is suitable for live deployment in Node.js

---

## TIMEFRAME LOGIC

Use this structure:

- Higher timeframe bias: 15m
- Entry timeframe: 5m

If necessary, make timeframes configurable.

The 15m chart should decide market bias.
The 5m chart should decide entry execution.

---

## SETUP 1: TREND + PULLBACK

Define strict rules for trend + pullback.

BUY RULES:
A buy setup should happen only when:

- 15m bias is bullish
- price is above 20 EMA on 15m OR bullish market structure is confirmed
- bullish structure means higher highs and higher lows
- on 5m, price pulls back toward one of these:
  - 20 EMA
  - recent breakout area
  - local support
  - optional VWAP if included
- after pullback, bullish confirmation must appear

Valid bullish confirmations:

- bullish engulfing candle
- strong lower wick rejection
- close back above 20 EMA
- momentum continuation candle after retracement

SELL RULES:
A sell setup should happen only when:

- 15m bias is bearish
- price is below 20 EMA on 15m OR bearish structure is confirmed
- bearish structure means lower highs and lower lows
- on 5m, price pulls back toward one of these:
  - 20 EMA
  - recent breakdown area
  - local resistance
  - optional VWAP if included
- after pullback, bearish confirmation must appear

Valid bearish confirmations:

- bearish engulfing candle
- strong upper wick rejection
- close back below 20 EMA
- momentum continuation candle after retracement

---

## SETUP 2: LIQUIDITY SWEEP

Define strict rules for liquidity sweep entries.

BUY LIQUIDITY SWEEP:
A long sweep setup should happen when:

- market is bullish or neutral-to-bullish on 15m
- price sweeps a recent swing low / local support / day low / liquidity pool
- after the sweep, price reclaims the level quickly
- reclaim candle closes bullish
- entry should happen only after confirmation, not blindly on the sweep

Filters:

- avoid taking long sweeps if 15m trend is strongly bearish
- sweep should have visible wick or fake breakdown behavior
- reclaim should show body strength
- optional volume expansion confirmation

SELL LIQUIDITY SWEEP:
A short sweep setup should happen when:

- market is bearish or neutral-to-bearish on 15m
- price sweeps a recent swing high / local resistance / day high / liquidity pool
- after the sweep, price rejects and closes back below the level
- bearish confirmation candle should appear before entry

Filters:

- avoid taking short sweeps if 15m trend is strongly bullish
- sweep should show fake breakout or long wick
- confirmation candle should close bearish and ideally below rejection area

---

## SETUP 3: STRONG 20 EMA REJECTION

This is NOT a simple EMA touch strategy.

I only want high-quality EMA rejection entries.

BUY EMA REJECTION:
A valid bullish EMA rejection should include most of these:

- bullish 15m context
- on 5m, price pulls back near 20 EMA
- candle touches or slightly pierces EMA
- candle rejects strongly from EMA
- lower wick is visible
- candle closes bullish
- preferably closes above EMA
- next candle confirms continuation, OR entry on rejection candle close if strength is high
- avoid if EMA is flat and market is sideways

SELL EMA REJECTION:
A valid bearish EMA rejection should include most of these:

- bearish 15m context
- on 5m, price pulls back near 20 EMA
- candle touches or slightly pierces EMA
- candle rejects strongly from EMA
- upper wick is visible
- candle closes bearish
- preferably closes below EMA
- next candle confirms downside continuation, OR entry on rejection candle close if strong
- avoid if EMA is flat and market is sideways

---

## MARKET STRUCTURE RULES

Create practical, codeable market structure logic for:

- higher high / higher low detection
- lower high / lower low detection
- recent swing high / swing low detection
- local support / resistance
- optional previous day high / previous day low

Do not use vague discretionary logic.
Use clear pivot/swing rules with configurable lookback length.

---

## ENTRY CONFIRMATION RULES

For each setup type, define:

- exact long entry trigger
- exact short entry trigger
- whether entry happens on candle close or next candle break
- what counts as valid confirmation
- how to prevent duplicate signals on same candle
- how to ensure one trade per setup

The rules must be clear enough to code directly.

---

## STOP LOSS RULES

Create clean SL logic for each setup.

Examples:

- trend + pullback long = stop below pullback swing low
- trend + pullback short = stop above pullback swing high
- liquidity sweep long = stop below sweep wick low
- liquidity sweep short = stop above sweep wick high
- EMA rejection long = stop below rejection candle low
- EMA rejection short = stop above rejection candle high

Also support:

- ATR-based buffer
- configurable extra tick/price buffer

---

## TARGET / EXIT RULES

Define proper exit logic for scalping.

Include:

- fixed RR targets: 1R, 1.5R, 2R
- optional partial booking at 1R
- optional trailing after 1R
- optional exit on opposite signal
- optional exit on EMA failure
- optional exit before strong opposing level

Recommend the best default exit style for XRPUSD and SOLUSD separately.

---

## TRADE FILTERS

Add strong filters to reduce bad trades:

- avoid low-volatility chop
- avoid overlapping candles / messy structure
- avoid flat EMA
- avoid long into nearby resistance
- avoid short into nearby support
- optional ATR filter
- optional volume filter
- optional session filter
- optional trend strength filter
- no-trade zone around EMA when price is directionless

---

## RISK MANAGEMENT RULES

Include strategy-level protections:

- one open trade at a time per symbol
- optional cooldown after stop-loss
- optional max consecutive loss filter
- optional minimum RR check before taking trade
- prevent revenge entries
- prevent duplicate entry on same setup

---

## NODE.JS IMPLEMENTATION REQUIREMENTS

Generate this for a Node.js trading bot.

I want production-style JavaScript code, not pseudocode only.

Requirements:

- modular code
- clean function separation
- reusable logic
- readable naming
- config-driven parameters
- no future leak
- no repaint-like logic
- candle-close based confirmation where appropriate
- strategy should work on already-formed candle arrays
- logic should return structured signal objects

Use a structure like:

- strategy config
- indicator helpers
- market structure helpers
- trend detection
- pullback detection
- liquidity sweep detection
- EMA rejection detection
- entry validation
- stop-loss calculation
- target calculation
- final signal generator

---

## EXPECTED SIGNAL OUTPUT FORMAT

The strategy should return a structured object like:

{
symbol: "XRPUSD",
timeframe: "5m",
signal: "BUY" or "SELL" or "NONE",
setupType: "TREND_PULLBACK" or "LIQUIDITY_SWEEP" or "EMA_REJECTION",
entryPrice: number,
stopLoss: number,
targetPrice: number,
rr: number,
reason: string,
context: {
trend15m: "BULLISH" or "BEARISH" or "NEUTRAL",
ema20Direction: "UP" or "DOWN" or "FLAT",
structure: "HH_HL" or "LH_LL" or "RANGE",
sweepDetected: boolean,
rejectionDetected: boolean
}
}

---

## INPUTS / CONFIG

Include configurable parameters for:

- EMA length default 20
- higher timeframe
- entry timeframe
- swing lookback
- ATR length
- ATR multiplier or buffer
- wick ratio threshold
- minimum candle body strength
- EMA slope threshold
- minimum RR
- volume filter on/off
- ATR filter on/off
- countertrend sweep mode on/off
- cooldown bars after stop-loss
- max nearby resistance/support distance filter

---

## OUTPUT FORMAT I WANT

Respond in this exact order:

1. High-level strategy explanation
2. Exact rules for Trend + Pullback Buy/Sell
3. Exact rules for Liquidity Sweep Buy/Sell
4. Exact rules for Strong 20 EMA Rejection Buy/Sell
5. Filters to avoid bad trades
6. Stop-loss and target rules
7. Full Node.js strategy code
8. Example of how to call the strategy with candle data
9. Suggestions to optimize separately for XRPUSD and SOLUSD

---

## IMPORTANT INSTRUCTIONS

- Do not give vague theory.
- Do not say “use discretion”.
- Convert the strategy into strict rule-based logic.
- Prioritize signal quality over frequency.
- Do not create a weak strategy that enters on every EMA touch.
- Make it realistic for live automated trading.
- Keep it robust, not overfitted.
- Do not build only indicators; build the actual strategy engine logic.
- Make the Node.js code as close to deployable as possible.

Now generate the complete strategy design and the full Node.js implementation for this system.

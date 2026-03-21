Build Prompt: Create a new strategy called Day Selling v4

I want you to create a new strategy in my trading system called Day Selling v4.

This strategy must be built as a separate strategy, not by modifying old rejection logic in a messy way.

Important:

This strategy should work on option candle data directly

It should not depend on NIFTY spot for setup generation

At market open, my system already selects 1 CE and 1 PE strike to monitor

I will pass the selected option’s candle data into the strategy

The strategy should evaluate that instrument’s own OHLC data and generate sell signals

This should work generically across dates, strikes, and instruments

The goal is:

monitor selected CE and PE option charts

detect bearish intraday sell setups on the option chart itself

generate structured sell signals with entry, stop loss, target, and setup type

Strategy name

Create a new strategy named:

Day Selling v4

Core purpose

This is a sell-only intraday option strategy.

The strategy must answer this question for each monitored option instrument:

Can this option premium be sold now based on its own candle structure?

This strategy should run independently on:

selected CE option candles

selected PE option candles

If a valid bearish setup appears on that option chart, generate a sell signal for that instrument.

Input data

The strategy should accept option candle data and indicator data such as:

OHLC candles

volume if available

8 EMA

20 EMA

VWAP

Supertrend

ATR or average candle range

session time

first candle data

first 1-hour range data

I want this strategy to be built so I can pass candle data directly into it.

Example idea:

evaluateDaySellingV4(optionCandles, indicators, config)
Main activation condition

This strategy should become active for an option instrument only when:

the instrument opens below the 20 EMA

This is the primary bearish day filter.

That means:

first candle open is below 20 EMA

or the opening structure clearly starts below 20 EMA

If the instrument opens above 20 EMA, this strategy should remain inactive for that instrument unless you explicitly design a later optional activation mode.

For now, keep the main rule simple:

Day Selling v4 activates only when the option chart opens below 20 EMA.

Main idea behind the strategy

I want to sell only when the option chart itself is weak.

This strategy should not sell random red candles.

It should only generate a sell signal when one of these structured bearish scenarios happens:

Super bearish first candle and pullback rejection near first candle top

Large first candle, then retracement sell

First candle low breakdown sell

20 EMA rejection sell

EMA fake breakout rejection sell

Sideways-market fallback using first 1-hour high rejection

If any one valid scenario happens, generate a sell signal.

Common definitions

Please define these concepts cleanly in code using configurable logic.

1. Strong bearish candle

A strong bearish candle should generally mean:

close < open

body is a large part of full range

close is near low

bearish body is strong relative to recent candles or ATR

Use configurable thresholds, not hardcoded fixed values.

2. Super bearish first candle

The first candle is super bearish when:

it opens below 20 EMA

closes strongly bearish

close is near low

candle shows strong opening weakness

3. Large first candle

A first candle is too large if direct entry would create a bad or too-wide stop loss.

Define this using adaptive logic such as:

first candle range > ATR × multiplier

or range > recent average candle range × multiplier

or percentage-of-premium threshold

This should be configurable because option premiums vary.

4. Sideways market

Sideways means:

8 EMA and 20 EMA are close together

EMA slope is flat

price keeps crossing EMA repeatedly

multiple EMA rejection signals would happen in chop

range is compressed

When sideways market is detected:

suppress or avoid standard EMA rejection entries

prefer first 1-hour range rejection logic instead

5. First 1-hour range

If using 5-minute candles:

first 1-hour high = highest high of first 12 candles

first 1-hour low = lowest low of first 12 candles

Scenario 1: Super bearish first candle, then pullback sell near first candle top
Condition

first candle opens below 20 EMA

first candle is super bearish

Special note

If the first candle open and high are same, or nearly same:

do not sell immediately

mark that upper zone

price may come back to retest it

when price retests that area and gives a bearish rejection candle, generate sell signal

Entry

sell on bearish rejection near first candle open/high zone

Stop loss

above first candle high or day high

Target

day low or continuation target

Intent

This is a retest sell, not a chase entry.

Scenario 2: Large first candle, then retracement sell
Condition

first candle opens below 20 EMA

first candle is bearish

first candle range is too large for safe direct entry

Action

mark first candle high and low

calculate retracement zone

Preferred retracement zone

Use configurable retracement levels such as:

50%

61.8%

Entry

if price reaches retracement zone

and forms bearish rejection

generate sell signal

Stop loss

above first candle high

Target

minimum 1:2 risk reward

optionally first candle low or day low continuation

Intent

Avoid entering after oversized opening move and instead wait for better RR pullback.

Scenario 3: First candle low breakdown sell
Condition

later in the session, price breaks below first candle low

breakdown candle is strong bearish

Important filter

Before signaling, check:

was first candle low already broken once earlier?

and then price reversed back up?

If yes:

do not trust the original first candle low directly anymore

mark the reversal candle low

wait for that new low to break

then generate sell signal

Entry

sell on strong valid breakdown of first candle low

or if false break already happened, sell on break of reversal candle low

Stop loss

above breakdown candle high or recent swing high

Target

1:2 RRR minimum

or continuation to new day low

Intent

Avoid false breakdown entries.

Scenario 4: 20 EMA rejection sell
Condition

candles are staying below 20 EMA

price pulls back upward into 20 EMA

20 EMA is acting as resistance

Entry

if price retests 20 EMA

and gives bearish rejection

generate sell signal

Valid rejection examples

upper wick rejection near EMA

bearish candle near EMA

close back below EMA

lower high near EMA

Stop loss

above rejection candle high

or above EMA rejection zone

Target

previous swing low

day low

or minimum 1:2 RRR

Intent

Sell bearish pullbacks when EMA is resistance.

Scenario 5: EMA fake breakout rejection sell
Condition

option price has been below 20 EMA

price temporarily closes above EMA or pokes above it

breakout fails quickly

price comes back below EMA

Same logic can also be used for

VWAP

Supertrend

Entry

when fake breakout fails

and bearish confirmation appears

generate sell signal

Stop loss

above fake breakout high

Target

prior swing low

day low

or minimum 1:2 RRR

Intent

Capture failed upward escape attempts when EMA/VWAP/Supertrend still behave as resistance.

Scenario 6: Sideways market fallback using first 1-hour high rejection
Condition

8 EMA and 20 EMA are narrow / flat

standard EMA rejection signals would create too many false entries

market is sideways / choppy

Action

disable or heavily restrict normal EMA rejection entries

mark first 1-hour high and low

Entry

if price reaches first 1-hour high

and gives bearish rejection there

generate sell signal

Stop loss

above first 1-hour high or rejection candle high

Target

first 1-hour low

day low

or range-based exit

Intent

Use range-based rejection logic when EMA-based entries are unreliable.

Common filters across scenarios

Please build shared filters so this strategy does not generate weak signals.

1. Bearish structure filter

Prefer sell entries when:

price is below 20 EMA

20 EMA is flat-to-down or down

pullbacks are weak

price is unable to sustain above EMA

2. No random red-candle entry

Do not generate sell signals just because one red candle appears.

Require at least one of:

first-candle zone interaction

retracement zone interaction

first-candle-low breakdown

EMA rejection

fake breakout failure

first 1-hour high rejection

3. Duplicate signal suppression

Avoid repeated signals from same zone/setup area.

Examples:

repeated EMA rejection from same area should be suppressed

repeated first candle high retest signals should be controlled

repeated first-hour-high rejection signals should be controlled

Use zone-based or setup-based duplicate protection.

4. Sideways suppression

When sideways condition is true:

suppress standard EMA rejection entries

prefer first 1-hour range logic

Option-friendly design requirement

This strategy works on option premium charts, so thresholds must be adaptive.

Do not rely only on fixed-point logic.

Use configurable and adaptive logic such as:

ATR-based thresholds

percentage-of-premium thresholds

hybrid fixed + ATR thresholds

This is important because:

CE and PE premiums differ

different strikes have different premiums

premium behavior changes during the day

Timeframe assumptions

Assume the strategy is mainly used on 5-minute candles unless otherwise configurable.

That means:

first candle = first 5-minute candle

first 1-hour range = first 12 candles

But make this configurable where practical.

Output format

For each monitored option instrument, I want structured output like:

{
strategyName: "Day Selling v4",
instrumentType: "CE" | "PE",
signal: boolean,
setupType: string | null,
entryPrice: number | null,
stopLoss: number | null,
targetPrice: number | null,
riskReward: number | null,
reason: string,
time: string | number | Date | null,
zoneReference: number | null
}

Example setup types:

FIRST_CANDLE_PULLBACK_SELL

FIRST_CANDLE_RETRACEMENT_SELL

FIRST_CANDLE_LOW_BREAK_SELL

EMA_REJECTION_SELL

EMA_FAKE_BREAK_SELL

FIRST_HOUR_HIGH_REJECTION_SELL

What I want you to build

Please create a production-quality TypeScript implementation of this strategy.

I want:

1. Separate strategy

Create this as a clean separate strategy called Day Selling v4.

2. Modular design

Use helper functions, for example:

isStrategyActive(...)

isStrongBearishCandle(...)

isSuperBearishFirstCandle(...)

isLargeFirstCandle(...)

getFirstCandleRetracementZones(...)

detectFirstCandlePullbackSell(...)

detectFirstCandleRetracementSell(...)

detectFirstCandleLowBreakSell(...)

detectEmaRejectionSell(...)

detectEmaFakeBreakSell(...)

detectFirstHourHighRejectionSell(...)

isSidewaysMarket(...)

suppressDuplicateSignal(...)

buildSellSignal(...)

You can rename them, but keep the code modular and clean.

3. Adaptive thresholds

Use configurable logic for:

candle strength thresholds

retracement levels

EMA distance tolerance

sideways thresholds

duplicate suppression

ATR multipliers

target rules

large first candle definition

4. Clear integration style

Make it easy to integrate into an existing strategy engine.

I want code that is structured, readable, and easy to call with candle data.

What I need in the response

Please respond with all of the following:

Root design overview

Explain the strategy architecture clearly.

TypeScript implementation

Provide complete production-style TypeScript code.

Helper functions

Include reusable helpers with descriptive naming.

Config structure

Provide a clean config object with recommended defaults.

Scenario-by-scenario logic

Show how each scenario is implemented.

Edge cases and safeguards

Explain how to handle:

very large first candles

fake breakdown then reversal

repeated EMA retests

sideways chop

low-premium noisy options

gap opens

late session signals

Recommended defaults

Suggest practical default values for:

candle strength thresholds

ATR multipliers

retracement levels

EMA rejection tolerance

sideways detection thresholds

duplicate suppression distance

target and stop logic

Coding requirements

Requirements:

TypeScript only

clean and modular

no instrument-specific hardcoding

no NIFTY-spot dependency

work on option candle data directly

suitable for CE and PE premium charts

built as a separate strategy named Day Selling v4

Expected response format

Please respond in this structure:

Strategy Overview
TypeScript Code
Helper Functions
Config Defaults
Scenario Logic Explanation
Edge Cases and Safeguards
Recommended Improvements
Final goal

The final implementation should allow me to:

pass selected CE or PE candle data into the strategy

evaluate Day Selling v4 on that option instrument

get clean sell signals only when one of the defined bearish scenarios happens

avoid noisy repeated EMA sells in sideways conditions

use adaptive thresholds suitable for option premium behavior

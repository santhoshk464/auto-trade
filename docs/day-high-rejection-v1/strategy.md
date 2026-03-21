Build Prompt: Create only a minimal standalone Day High Rejection strategy

I want you to create only one small standalone strategy for Day High Rejection.

Important:

Do not touch my existing strategies

Do not integrate with the current big engine

Do not add EMA rejection, Setup A, sweep engine, first-hour range engine, or any other setup family

Do not create cross-dependencies with existing code

Keep this as a small separate module

We will add enhancements later

This must be:

simple

focused

easy to test

easy to debug

general across instruments and dates

Main goal

Create a new standalone function like:

detectDayHighRejectionOnly(candles, config)

This strategy should do only one job:

Detect a Day High Rejection sell setup from candle data.

Nothing else.

Scope

This version should support only:

1. Intraday day high reference

Use only:

previous known intraday rolling high

Important:

do not use current candle high before evaluation

the current candle should be tested against the previous known day high

So the logic should be:

const prevRollingHigh = rollingHigh;
const intradayDayHigh = prevRollingHigh;

// evaluate current candle against intradayDayHigh

if (candle.high > rollingHigh) rollingHigh = candle.high;
Setup type

Only one setup type for now:

DAY_HIGH_REJECTION

Do not add subtypes yet.
Do not add liquidity sweep as a separate strategy yet.
Do not add EMA logic yet.
Do not add inherited bearish bias yet.

Keep it minimal.

Trigger logic

I want a simple Day High Rejection definition:

A candle should qualify if:

it reaches near the previous intraday day high

or touches that high

or slightly exceeds it within a small configurable tolerance

then rejects that zone

Rejection can mean:

upper wick is meaningful

close is weak relative to the candle range

or candle closes back below the day-high zone

or bearish candle after touching the zone

Keep this logic simple and readable.

Optional confirmation

This minimal version may support one simple confirmation rule:

Either

direct trigger on the same candle if rejection is strong enough

Or

optional next-candle confirmation:

next candle closes below setup candle midpoint

or next candle breaks setup candle low

Keep this optional and simple.
Do not build a large pending queue system.
If needed, use only one simple pending DHR candidate for this standalone strategy.

What this strategy should NOT include

Do not include:

EMA filters

previous day high

first hour high

first candle high

swing highs

liquidity sweep as separate setup family

inherited bearish continuation

market state engine

duplicate suppression across many setup types

giant pending sequence architecture

integration into existing combined strategy

This should be a minimal isolated module.

Function behavior

The function should:

loop through candles

maintain previous rolling high

test each candle for day-high rejection

optionally test one simple next-candle confirmation

return signals only for this one setup

Output format

Return clean structured signals like:

{
strategyName: "Day High Rejection Only",
signal: true,
setupType: "DAY_HIGH_REJECTION",
entryPrice: number,
stopLoss: number,
zoneReference: number,
setupIndex: number,
confirmIndex: number | null,
reason: string,
}

You can refine the shape, but keep it simple.

Logging

Add simple logs only for:

previous rolling high used

candle near/touch/high interaction

rejection accepted or rejected

direct entry fired

confirmation entry fired

reason for rejection

Keep logs readable and minimal.

Config

Provide a small config object only for DHR, such as:

day high tolerance

wick threshold

weak close threshold

direct trigger threshold

confirmation enabled

confirmation window

midpoint-break confirmation option

setup-low-break confirmation option

stop-loss buffer

Keep defaults general.
Do not hardcode any instrument-specific values.

Coding requirements

TypeScript only

standalone file/module

no integration with existing strategies

no side effects on other code

no large abstractions

keep it small and readable

What I need in the response

Please provide:

1. Strategy Overview

Explain the minimal Day High Rejection logic.

2. TypeScript Code

Provide the full standalone implementation.

3. Config Defaults

Provide a small config object with suggested defaults.

4. Logging Design

Show the log points.

5. Behavior Explanation

Explain:

direct rejection

optional confirmation rejection

6. Safeguards

Explain how this avoids conflict with existing strategies and stays minimal.

Expected response format

Please respond in this structure:

Strategy Overview
TypeScript Code
Config Defaults
Logging Design
Behavior Explanation
Safeguards
Final goal

I want a minimal standalone Day High Rejection strategy only that:

uses only previous intraday rolling high

checks only one setup family

stays isolated from existing strategies

is easy to test before adding any future enhancements

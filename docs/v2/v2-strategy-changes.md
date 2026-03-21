Build Prompt: Upgrade v2 strategy using the strongest filters from v4

I want you to upgrade my existing v2 strategy by selectively integrating the strongest filtering ideas from v4.

Important:

Do not rewrite v2 completely from scratch

Do not turn v2 into v4

Keep v2 as the main base strategy

Only port the best v4 filters and controls into v2

Goal is to improve accuracy, reduce bad sell entries, and improve winning rate

This should work generically across instruments, dates, and candle data

The strategy should work directly on the candle data passed into it

Main goal

I want to create an improved version of v2, something like:

v2 enhanced or v2.5

The main idea is:

keep the useful structure and setups from v2

add the strongest quality filters from v4

especially:

20 EMA bearish activation filter

sideways market detection

first 1-hour high/low fallback logic in sideways market

master EMA-resistance filter for sell entries

duplicate signal suppression / used zone control

The purpose is to make v2 more selective and reduce low-quality sell signals.

What I want preserved from v2

Please preserve the main v2 structure and its core sell logic where it is already working well.

Especially preserve:

first-candle-low breakdown logic

EMA rejection logic

structure-based bearish entries

existing risk-management style where possible

any good state handling already present in v2

I do not want to lose the useful logic that already makes v2 look good.

What I want ported from v4 into v2

1. Add v4-style session activation using 20 EMA

I want a strong bearish day bias filter added into v2.

Preferred rule

Only allow normal sell-side v2 logic when the instrument opens below 20 EMA.

In simple form:

if first candle open is below 20 EMA, v2 sell engine is active

if first candle open is above 20 EMA, either:

keep v2 inactive for the session, or

use a configurable delayed activation rule

Better design

Make this configurable.

Suggested config ideas:

requireOpenBelow20Ema: true

allowDelayedActivation: boolean

delayedActivationLookback

delayedActivationNeedsBelowCloses

delayedActivationNeedsEmaSlopeDown

Delayed activation option

If you support delayed activation, allow v2 to activate later only when:

enough candles close below 20 EMA

EMA slope turns down

price is mostly below EMA

bearish structure is visible

But keep this optional. Main rule should still be:

No normal sell setups unless 20 EMA is overhead and bearish bias is active.

2. Add master EMA-resistance filter to all v2 sell setups

This is very important.

I do not want only one setup to check EMA properly while other bearish branches still sell into EMA support.

I want a shared filter that says:

For most bearish setups, only allow sell if 20 EMA is acting as resistance

Examples of what this should mean:

close is below EMA

EMA is above price or near overhead

EMA slope is flat-to-down or down

recent candles are mostly below EMA

price is not strongly reclaiming EMA

Suggested shared helper

Something like:

canUseSellSetupWithEmaBias(...)

or

isBearishEmaContext(...)

This should be used across v2 sell branches, not only one branch.

Intent

Do not sell when EMA is still supporting price.

3. Add sideways market detection from v4

I want the v4-style sideways filter integrated into v2.

The idea is:

when 8 EMA and 20 EMA are too close

EMA slope is flat

price crosses back and forth too many times

market is choppy

then normal EMA rejection sells become noisy and should be restricted.

Sideways detection should consider things like:

narrow gap between 8 EMA and 20 EMA

repeated EMA crossings in lookback window

compressed price range

flat EMA movement

Suggested config ideas

sidewaysEmaGapPct

sidewaysLookback

sidewaysCrossings

sidewaysRangeCompressionThreshold

Intent

Detect chop and avoid repeated weak EMA signals.

4. In sideways market, suppress standard EMA rejection logic

When sideways condition is true:

suppress or heavily restrict standard EMA rejection sells

reduce confidence on weak breakdowns or weak rejection setups

do not allow repeated EMA sells from every small touch

This is a very important improvement.

I want the strategy to understand:

EMA rejection works best when EMA is true resistance, not when price is chopping around it.

5. Add first 1-hour range high/low fallback from v4

In sideways market, I want v2 to use first 1-hour range logic from v4.

First 1-hour range

If using 5-minute candles:

first 1-hour high = highest high of first 12 candles

first 1-hour low = lowest low of first 12 candles

Make this configurable.

Desired use in sideways market

When sideways is true:

avoid normal EMA sell noise

instead use:

first 1-hour high rejection sell

optional range-based breakdown continuation logic if suitable

Main sell rule

If price reaches the first 1-hour high in sideways conditions and gives a bearish rejection candle, allow sell signal.

Stop-loss

above first 1-hour high or rejection candle high

Target

first 1-hour low

day low

or configurable RR target

Intent

In chop, range edges are more reliable than EMA touch signals.

6. Add zone usage memory / duplicate suppression from v4

I want improved suppression of repeated entries from the same area.

Examples:

repeated EMA rejection signals from the same zone should be suppressed

repeated first-hour-high rejection from the same level should be suppressed

repeated first-candle zone signals should be controlled

once a zone is used, strategy should avoid spamming repeated signals unless re-armed by fresh structure

Suggested concepts

usedZones

lastSignalPrice

duplicateDistanceThreshold

duplicateCooldownCandles

rearmOnlyAfterMoveAway

Intent

Improve signal quality by avoiding overtrading the same level.

7. Keep first-candle-low breakdown logic, but strengthen it with EMA context

I want to keep v2’s first-candle-low breakdown logic because it is useful.

But I want it upgraded so that:

breakdown sells are allowed only if bearish EMA context is valid

do not sell breakdown if price is reclaiming EMA strongly

after false break and reversal, require fresh low break before re-entry

if sideways is true, make first-candle-low breakdown stricter

Intent

Preserve the good v2 breakdown idea, but avoid weak breakdown sells.

8. Keep EMA rejection logic, but allow it only in the right context

I want to keep v2 EMA rejection because it is one of the core setups.

But I want it upgraded so that:

EMA rejection is allowed only when EMA is true resistance

not when market is sideways and EMAs are compressed

not when price is repeatedly bouncing around EMA

not when bullish reclaim is happening

optional requirement:

recent closes mostly below EMA

EMA slope down or at least not rising

pullback is weak

bearish candle confirms rejection

Intent

Make EMA rejection high quality, not frequent.

9. Use v4 filters without over-restricting v2 too much

This is important.

I do not want the upgraded v2 to become so restrictive that it stops giving useful signals entirely.

Please design it in a balanced way:

v2 remains the main strategy

v4 concepts act as quality filters

use config flags so I can tune the strictness

Example config ideas

useV4OpenBelow20EmaFilter

useV4SidewaysFilter

useFirstHourRangeFallback

useMasterEmaResistanceFilter

strictMode

What I need you to build

Please implement an upgraded version of v2 that:

keeps the good structure of v2

integrates v4’s bearish day activation filter

integrates v4’s sideways detector

suppresses normal EMA rejection in sideways conditions

adds first 1-hour high rejection logic in sideways market

adds master EMA-resistance filter for sell setups

improves duplicate suppression / zone reuse control

remains configurable and production-friendly

Coding requirements

Please provide a production-quality TypeScript implementation.

Requirements:

modular code

easy to integrate into the existing engine

descriptive helper names

no instrument-specific hardcoding

work on candle data directly

generic across dates and instruments

Suggested helper functions

Please use clean helper functions such as:

isV2SessionActive(...)

isBearishEmaContext(...)

isSidewaysMarket(...)

getFirstHourRange(...)

detectFirstHourHighRejectionSell(...)

shouldSuppressEmaRejectionInSideways(...)

isDuplicateZoneSignal(...)

markZoneUsed(...)

canUseBreakdownSetup(...)

canUseEmaRejectionSetup(...)

buildV2EnhancedSellSignal(...)

You can rename them, but keep the design clean.

Config structure I want

Please provide a clean config object for the upgraded v2.

Suggested config areas:

EMA activation / bias

requireOpenBelow20Ema

allowDelayedActivation

delayedActivationLookback

delayedActivationBelowCloseCount

delayedActivationEmaSlopeThreshold

EMA resistance filter

emaResistanceLookback

minBelowEmaCloses

maxAllowedAboveEmaCloses

emaSlopeDownRequired

emaTolerancePct

Sideways filter

sidewaysEmaGapPct

sidewaysLookback

sidewaysCrossings

sidewaysCompressionThreshold

First hour range

firstHourCandles

enableFirstHourHighRejection

firstHourZoneTolerancePct

Duplicate suppression

duplicateCooldownCandles

duplicateDistancePct

moveAwayToRearmPct

Risk logic

defaultRiskReward

slBufferPct

atrStopMultiplier

What I need in the response

Please respond with all of the following:

1. Upgrade overview

Explain how v2 is being enhanced using v4 filters.

2. Integration plan

Show exactly where in v2 the new filters should be inserted:

session activation

EMA master filter

sideways suppression

first-hour-high fallback

duplicate suppression

3. TypeScript code

Provide clean implementation code for upgraded v2.

4. Helper functions

Include all helper functions needed.

5. Config defaults

Provide recommended default values.

6. Scenario behavior explanation

Explain how upgraded v2 behaves in:

bearish trending sessions

sideways sessions

fake breakdown sessions

repeated EMA-touch sessions

7. Edge cases and safeguards

Explain handling for:

large opening candles

gap sessions

sideways chop

late session weak setups

repeated retests of same zone

low premium noisy options

Expected response format

Please respond in this structure:

Upgrade Overview
Integration Plan
TypeScript Code
Helper Functions
Config Defaults
Behavior by Market Type
Edge Cases and Safeguards
Final goal

The final upgraded v2 should:

keep the useful strengths of v2

borrow the strongest filters from v4

avoid selling when 20 EMA is not true resistance

avoid noisy EMA rejection signals in sideways market

use first 1-hour range rejection logic in chop

reduce duplicate signals from the same zone

improve overall signal quality and accuracy

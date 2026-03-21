Focused Patch Prompt: Add narrow-range / room-to-move filter to the standalone Day High Rejection strategy

I want you to patch my current standalone Day High Rejection strategy.

Important:

Do not redesign the strategy

Do not merge it with the large combined engine

Do not add unrelated setup families

Keep this as the same standalone DHR module

This must be a focused context-quality patch

Keep it general across instruments and dates

Main problem

The current DHR engine is detecting valid high-rejection patterns, but some sessions behave like narrow range / compressed days.

On those days:

day high acts as resistance

day low acts as support

price keeps rotating inside the session range

there is not enough room for the short trade to expand

So even if DHR detection is technically correct, the trade can still be low quality because the market has no room to move.

This is what I want to reduce.

Main goal

Add a narrow-range / room-to-move filter so that the strategy can avoid taking DHR signals when:

the session is compressed / range-bound

there is not enough room below entry to current day low / nearest support

the market is likely trapped between day high resistance and day low support

This should stay general and not rely on one specific date or instrument.

What I want changed

1. Add a “room to move” filter before final DHR entry

This is the most important part.

Before allowing a DHR signal, check whether the trade has enough downside room.

Example idea

Compare:

proposed entry price

current day low / nearest support reference

stop-loss distance / risk

ATR if useful

Goal

If the trade is too close to current session low or support, skip it.

Suggested helper

hasEnoughRoomToMove(...)
or equivalent

Possible logic

Require one or more of:

distance from entry to current day low >= minimum fixed points

distance from entry to current day low >= ATR fraction

distance from entry to current day low >= minimum multiple of stop/risk

Keep this configurable and general.

2. Add a session compression / narrow-range filter

I want the strategy to detect when the day is behaving like a compressed range rather than a good expansion day.

Generic signs of compression

Use configurable logic such as:

first-hour range is relatively narrow

recent candles overlap heavily

recent session range relative to ATR is too small

repeated reversals are happening inside a bounded range

price is not expanding away after previous setups

Suggested helper

isSessionCompressed(...)
or equivalent

Goal

If the session is compressed, later DHR trades should be restricted unless there is strong evidence of a real breakdown or breakout-failure with enough room.

3. Do not rely only on first candle narrowness

I do not want the patch to depend only on:

“first candle is narrow”

That is too simplistic.

A session can start narrow and later trend strongly.

So instead, use broader session logic:

first-hour range

current range vs ATR

overlap / compression behavior

distance to support

Goal

Make this a general session-quality filter.

4. Keep strong DHRs when there is real room

I do not want to block all DHRs on quiet days.

If:

DHR is strong

there is enough downside room

and session is not overly compressed

then the trade should still be allowed.

Goal

This should filter low-quality range-bound DHRs, not all DHRs.

5. Optional: restrict later repeated DHRs more on compressed sessions

If the session is compressed and multiple DHRs already happened, later DHRs should be much harder to allow.

Example idea

If:

isSessionCompressed === true

and there was already a prior DHR trade in the same session

and price is still within the same broad range

then either:

block additional DHRs

or require stronger room-to-move and stronger rejection quality

Goal

Reduce repeated mean-reversion trades inside narrow range behavior.

What I want to keep

Please keep:

current DHR detection

current direct / sweep / confirmation logic

current rolling-high logic

current cooldown/rearm logic unless a small adjustment is needed

current 1-minute confirmation mode if already added

This patch should only improve:

session context quality

room-to-move filtering

Exact behavior I want after patch
Allow DHR when:

strong DHR setup exists

session is not overly compressed

there is enough room below entry to move toward current day low / nearest support

Skip DHR when:

session is trapped in a narrow range

current day low / support is too close

trade does not have enough downside room

repeated intraday reversals are happening inside the same broad range

What I need in the response

Please provide all of the following:

1. Patch summary

Explain clearly why the current strategy can still lose on narrow range / compressed sessions and how this filter helps.

2. Exact overwrite plan

Show exactly:

where room-to-move check should be inserted

where session compression logic should be inserted

how this should affect final signal acceptance

what should remain unchanged

3. Updated TypeScript code

Provide production-style TypeScript code for:

hasEnoughRoomToMove(...)

isSessionCompressed(...)

integration into final DHR signal acceptance

4. Updated helper functions

If needed, include helpers such as:

getCurrentDayLow(...)

getSessionCompressionScore(...)

hasEnoughDistanceToSupport(...)

You can rename them, but keep the logic clear.

5. Config updates

Provide recommended config updates for:

minimum room-to-move threshold

ATR-based room threshold

compression threshold

overlap / narrow-range threshold

repeated compressed-session DHR restriction

6. Behavior explanation

Explain how the patched strategy behaves for:

trending bearish sessions with plenty of room

narrow-range sessions

compressed first-hour sessions

repeated same-session DHR attempts when support is near

7. Safeguards

Explain how this avoids:

blocking all DHRs

overfitting to one instrument/date

relying only on narrow first candle logic

becoming too complex

Important constraints

General fix only

No instrument-specific tuning

No date-specific tuning

Patch only the standalone DHR strategy

Keep the strategy small and isolated

Expected response format

Please respond in this exact structure:

Patch Summary
Exact Overwrite Plan
Updated TypeScript Code
Updated Helper Functions
Config Updates
Behavior by Session Compression / Room-to-Move Type
Safeguards Against Over-Filtering
Final goal

After this patch, I want the standalone DHR strategy to:

avoid low-quality DHR trades on narrow/compressed sessions

avoid trades with no real room to move before support/day low

keep valid DHRs on sessions that still have real downside opportunity

improve trade quality without turning the code into another giant engine

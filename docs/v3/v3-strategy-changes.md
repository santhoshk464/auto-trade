Task: Polish my existing Day Selling V1 strategy without changing its core trading philosophy.

Core rule:
Keep the current `if / else-if` execution style.
My trading logic is:

- if any valid bearish pattern meets the condition, take the trade
- first valid pattern wins
- do NOT convert the strategy into score-only ranking logic

Important:

- Preserve the current pattern-first design
- Preserve the current `if / else-if` flow
- Do NOT redesign the whole strategy
- Do NOT over-optimize for one chart or one date
- Make the code cleaner, easier to debug, and easier to maintain for future days

Goals:

1. Keep existing behavior as much as possible
2. Reduce condition overlap
3. Improve pattern grouping
4. Improve naming clarity
5. Add structured diagnostics
6. Add only missing structural setup(s), not random tweaks

Required refactor:

1. Keep if / else-if architecture
   Do not replace my pattern-first logic with a score-only framework.
   It is okay to compute helper booleans, but final signal selection should remain:

- first valid pattern wins
- if / else-if priority flow

2. Group the strategy into clean engine families
   Refactor conditions into clear sections:

Priority 1: Key resistance rejection family

- Day High Rejection
- Yesterday High Rejection
- Prev Day Close Rejection
- Opening Range Rejection
- Swing High Rejection

Priority 2: EMA rejection family

- Bearish Open @ EMA Rejection
- EMA Fake Break Rejection

Priority 3: Broken support retest family

- Broken First Candle Low Retest Rejection
- future similar broken-support retests can belong here

Priority 4: Lower High Breakdown

Priority 5: First Candle Low Breakdown

3. Preserve existing pattern variants inside each family
   Inside a family, it is okay to detect sub-patterns like:

- shooting star
- bearish engulfing
- strong bearish close
- weak close
- doji rejection
  But keep them inside the correct family.

4. Improve signal naming
   Do not label all resistance signals as “Day High Rejection”.
   Use accurate reason labels based on actual zone:

- Day High Rejection
- Yesterday High Rejection
- Prev Day Close Rejection
- Opening Range Rejection
- Swing High Rejection
- EMA Rejection
- Broken First Candle Low Retest Rejection
- Lower High Breakdown
- First Candle Low Breakdown

5. Add structured diagnostics
   Add a reusable diagnostic logger for every candidate candle.
   For each engine/family, log:

- candle time
- matched zone
- matched pattern
- important booleans
- pass/fail
- fail reasons

Example diagnostic fields:

- nearDayHighZone
- nearYesterdayHigh
- nearPrevDayClose
- nearFirstCandleHigh
- nearEMA
- firstCandleLowBrokenEarlier
- lowerHighForming
- emaSupportBounces
- bearishRegime / bullishRegime if used
- final reason why signal passed or failed

6. Add missing engine: Broken First Candle Low Retest Rejection
   Add a separate engine for:

- first candle low already broken earlier
- later price retests that broken low from below
- rejection happens
- candle closes back below
- bearish continuation context exists

Keep this as its own engine, not mixed into EMA rejection.

7. Do not over-tighten valid V1 behavior
   Do not add unnecessary strict filters that remove valid existing signals.
   This is a polish/refactor task, not a strategy rewrite.

8. Keep risk logic intact
   Do not change:

- stop loss framework
- max risk logic
- target logic
- result object structure
  unless absolutely necessary for consistency

Expected output:

1. cleaner V1 code structure
2. same if / else-if philosophy preserved
3. better naming
4. diagnostic logging added
5. missing retest engine added
6. easier debugging for future days

After implementing, return:

1. polished code
2. summary of engine order
3. list of reason labels
4. diagnostics added
5. explanation of what was preserved vs improved

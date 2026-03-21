Update my Day Low Break (DLB) strategy with the following exact logic.

Strategy name:
Day Low Break Selling (DLB)

Timeframes:

- Reference level from first 5-minute candle
- Breakdown detection on 5-minute candles
- Entry confirmation on 1-minute candles

Important note:

- All numeric values used in examples below are ONLY FOR REFERENCE / EXPLANATION
- They are NOT hard-coded values
- Do not hard-code example values like 450 or 435 into the strategy
- Always calculate levels dynamically from live candle data

Core reference:

- Mark the first 5-minute candle low of the day as `dayFirst5mLow`

Reference example only (not hard-coded):

- first candle high = 500
- first candle low = 450
- first candle close = 475

Base DLB logic:

1. A normal DLB setup starts only when a later 5-minute candle breaks below `dayFirst5mLow`.
2. Do not use RSI in this strategy.
3. If the 5-minute breakdown is clean and bearish, then use 1-minute confirmation for entry.

Important failed-break / reversal logic:

1. If a 5-minute candle breaks `dayFirst5mLow`, makes a new low, but then reverses and closes back ABOVE `dayFirst5mLow`, treat this as a FAILED BREAKDOWN.
2. Reference example only (not hard-coded):
   - `dayFirst5mLow = 450`
   - later candle breaks 450
   - makes low = 435
   - then reverses and closes above 450
3. In this case:
   - do NOT continue taking fresh sells just because price again breaks the first candle low
   - store this failed-break candle low as `failedBreakLow`
   - store this candle high as `failedBreakHigh`
   - move strategy state to: `WAITING_FOR_FAILED_BREAK_LOW_REBREAK`

New trigger after failed breakdown:

1. Once a failed breakdown happens, the first candle low is no longer the main trigger for immediate re-entry.
2. The new important trigger becomes `failedBreakLow`.
3. Ignore new sell entries triggered only by re-breaking `dayFirst5mLow`.
4. Wait until price breaks below `failedBreakLow`.

Re-break entry rule:

1. After failed breakdown, allow a new bearish setup only when a later candle breaks below `failedBreakLow`.
2. This re-break should be strong bearish:
   - candle body should be decent
   - close should be near the low
   - lower wick should not be too large
3. After this re-break, use 1-minute confirmation:
   - the next completed 1-minute candle must also close below `failedBreakLow`
4. Entry options:
   - conservative: enter at next candle open after 1-minute confirmation close
   - aggressive: enter on break of the confirming 1-minute candle low

Minimum RR filter instead of hard-coded point distance:

1. Do NOT use a fixed `minBreakDistancePts` as the main filter.
2. Instead, before taking any entry after failed-break re-break logic, calculate whether the trade has minimum Risk:Reward of 1:1.5.
3. Define:
   - `entryPrice`
   - `stopLossPrice`
   - `risk = stopLossPrice - entryPrice` for sell
   - `nearestSupportBelow` or nearest realistic downside target
   - `reward = entryPrice - nearestSupportBelow`
   - `rr = reward / risk`
4. Only allow entry if `rr >= 1.5`
5. If there is not enough room to the next downside support, skip the trade.

Stop loss logic:

1. For normal clean DLB:
   - SL can be above 1-minute confirmation candle high
   - or safer above 5-minute breakdown candle high
2. For failed-break re-break trade:
   - use `failedBreakHigh` as primary SL reference
   - optionally use max of failedBreakHigh and confirmation high plus buffer

Entry improvement filters:

1. Skip if 1-minute confirmation candle has a strong lower wick rejection
2. Skip if re-break candle is weak or closes far from its low
3. Skip if entry is too extended after the breakdown
4. Skip if broken level is reclaimed immediately after trigger
5. Prefer trades where bearish continuation is clean and momentum is obvious

State machine requirements:
Please refactor the DLB logic into a proper state machine with clear transitions. Suggested states:

- `WAITING_FOR_DAY_LOW_BREAK`
- `WAITING_FOR_1M_CONFIRMATION`
- `FAILED_BREAKDOWN_DETECTED`
- `WAITING_FOR_FAILED_BREAK_LOW_REBREAK`
- `WAITING_FOR_REBREAK_1M_CONFIRMATION`
- `TRADE_TRIGGERED`
- `SETUP_INVALIDATED`

Detailed behavior:

1. Initial state: `WAITING_FOR_DAY_LOW_BREAK`
2. If a 5-minute candle closes below `dayFirst5mLow` cleanly:
   - go to `WAITING_FOR_1M_CONFIRMATION`
3. If a 5-minute candle breaks below `dayFirst5mLow` but closes back above it:
   - set `failedBreakLow = candle.low`
   - set `failedBreakHigh = candle.high`
   - state = `WAITING_FOR_FAILED_BREAK_LOW_REBREAK`
4. In `WAITING_FOR_FAILED_BREAK_LOW_REBREAK`:
   - ignore fresh entries based only on first candle low
   - wait for a later break of `failedBreakLow`
5. Once `failedBreakLow` breaks with strong bearish structure:
   - state = `WAITING_FOR_REBREAK_1M_CONFIRMATION`
6. Then require next 1-minute candle close below `failedBreakLow`
7. Before triggering entry, calculate minimum RR = 1.5
8. If RR is insufficient, skip and log the reason
9. After one valid trade, avoid repeated low-quality re-signals from the same structure unless explicitly designed

Implementation requirements:

1. Keep code modular and readable
2. Separate:
   - level marking
   - 5-minute structure detection
   - failed breakdown detection
   - 1-minute confirmation
   - RR calculation
   - entry validation
   - stop-loss selection
3. Avoid duplicate or repeated signals from the same broken day-low structure
4. Add configurable thresholds for:
   - minimum bearish body ratio
   - maximum lower wick %
   - close-near-low threshold
   - minimum RR ratio (default 1.5)
   - entry extension threshold
   - SL buffer

Logging requirements:
Add detailed logs for every decision:

- "DLB: First 5-minute day low marked"
- "DLB: Clean day-low breakdown detected"
- "DLB: Waiting for 1-minute confirmation"
- "DLB: Failed breakdown detected, close reclaimed above day low"
- "DLB: Failed-break low stored"
- "DLB: Waiting for failed-break low re-break"
- "DLB: Failed-break low re-broken"
- "DLB: Waiting for 1-minute confirmation below failed-break low"
- "DLB: Skipped due to insufficient RR (< 1.5)"
- "DLB: Skipped due to lower wick rejection"
- "DLB: Skipped due to weak bearish re-break candle"
- "DLB: Sell triggered"
- "DLB: Setup invalidated due to reclaim"

Expected outcome:
This DLB strategy should stop taking repeated low-quality sells after a failed first break of day low. If price breaks day low, reverses, and closes back above it, the system must wait for the low of that failed-break candle to break again. Even then, it should only enter if the re-break is strong and the trade has at least 1:1.5 RR.

Again, all numeric examples in this prompt are only for explanation and should not be hard-coded. Please implement the logic dynamically from actual market candles in my TypeScript strategy file while preserving the existing architecture as much as possible.

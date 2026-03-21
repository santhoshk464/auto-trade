Create 20 EMA Rejection Selling strategy for intraday trading using reference-based logic only, not hardcoded candle-count assumptions, similar in discipline to DHR and DLB strategies.

Strategy goal:
Identify bearish continuation trades when the market is weak relative to the 20 EMA, then pulls back toward the EMA, fails to sustain above it, and resumes downside movement.

Core bearish context:
A sell setup is valid only when bearish context is already present. Use these as references, not fixed hardcoded rules:

- Market opens below the 20 EMA
- Day first candle opens above the 20 EMA but closes below the 20 EMA

Both cases indicate that price is weak relative to the 20 EMA and selling opportunities can be considered on pullbacks.

Entry idea:
After bearish context is confirmed:

- price moves from lower levels toward the 20 EMA
- price touches, approaches, enters, or slightly moves above the 20 EMA zone
- then shows rejection or failure
- after bearish confirmation, take sell entry

The strategy should treat the 20 EMA as a rejection zone, not as a single exact line.

Important fake breakout handling:
Do not hardcode that fake breakout must fail in exactly the next candle.

Sometimes price may:

- touch the 20 EMA
- move slightly above it
- remain above it for 1 or 2 candles, sometimes a little more
- then fail and reverse down

This can still be a valid bearish rejection as long as price does not sustain bullish continuation and later reclaims back below the 20 EMA with bearish confirmation.

So the strategy must use failure-to-sustain-above-EMA logic, not strict one-candle-only logic.

Valid rejection behavior:
Treat the following as potentially valid bearish rejection patterns near the 20 EMA zone:

- direct rejection from below the EMA
- wick rejection near the EMA
- bearish candle formation at the EMA zone
- slight breakout above EMA followed by failure
- 1 to 2 candles temporarily holding around or above EMA, then losing strength
- reversal candle closing back below EMA
- renewed bearish momentum after EMA failure

Invalid or avoid conditions:
Skip or avoid sell entries when pullback into 20 EMA shows actual bullish acceptance rather than rejection. Examples:

- strong bullish candles continue closing above 20 EMA
- price sustains above EMA cleanly
- EMA slope becomes flat or starts turning up
- market structure shifts from lower highs to higher highs
- pullback is too deep and looks like reversal instead of rejection
- price becomes sideways and choppy around EMA without clear rejection
- stop-loss becomes too wide compared to target opportunity
- narrow range or compressed candles suggest no room for move

Confirmation logic:
The strategy should confirm that the move above or near 20 EMA was a failed bullish attempt, not a true breakout.

Possible confirmation ideas:

- bearish close back below 20 EMA
- breakdown of rejection candle low
- lower high near 20 EMA
- bearish momentum expansion after weak pullback
- rejection happening near resistance, day structure, or intraday swing level

Do not hardcode only one confirmation method unless necessary. Build it with structured but flexible logic.

Desired behavior:

1. Confirm bearish market context first
2. Wait for pullback toward 20 EMA
3. Detect whether price is being rejected from the EMA zone
4. Allow temporary fake breakout above EMA if breakout fails
5. Enter only after bearish confirmation
6. Avoid entries during bullish acceptance or sideways chop
7. Prefer setups where downside room is available and risk-reward is reasonable

Key implementation guidance:
Please implement this as rule-based trading logic, but keep all thresholds as reference parameters, not hardcoded fixed truths.

Examples of reference-style variables:

- emaTouchBufferPts
- emaBreakTolerancePts
- maxFakeBreakCandlesReference
- minRejectionStrengthReference
- minDownsideRoomReference
- minRiskRewardReference
- maxAllowedSLReference
- minEMASlopeReference
- chopFilterReference

These are references for tuning, not rigid mandatory values.

What to produce:
Please provide:

- full strategy logic
- entry conditions
- fake breakout handling logic
- confirmation logic
- invalid or skip conditions
- optional filters to improve win rate
- pseudocode or Node.js-compatible logic if possible

Important:

- treat screenshots and examples only as behavioral references
- do not hardcode exact values just because a screenshot shows a certain shape
- do not assume fake breakout must fail in exactly one candle
- build it to recognize failed EMA acceptance, not just candle-count reversal

Reference examples:
Use concepts like these only as references, not hardcoded cases:

- market opens below 20 EMA, pulls back to EMA, rejects, then falls
- first candle opens above 20 EMA and closes below it, later pullback to EMA fails
- price temporarily trades above EMA for 1 to 2 candles, but cannot sustain and then breaks back down
- rejection near EMA happens after lower-high formation and bearish continuation starts

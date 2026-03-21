You are updating an existing Node.js / TypeScript crypto scalping strategy inside my local Delta Exchange algo.

Important:

- Do not redesign the whole system.
- Do not rewrite unrelated code.
- Do not give theory only.
- Do not return pseudocode.
- I want exact TypeScript code changes I can paste into my existing `delta.service.ts`.
- Preserve the current architecture:
  - 1m entry timeframe
  - 5m higher timeframe bias
  - setup priority
  - mutual exclusivity
  - cooldown
  - setup-level and side-level leg lock
  - structural re-arm
  - setup-specific stop loss
  - symbol-specific config support
  - retracement-entry / skip-stretched-trade logic
  - current partial / runner / trade-management logic

---

## MAIN GOAL

I want to add a softer secondary EMA rejection mode so the strategy can catch clean continuation-type EMA rejections that are visually valid but do not have a huge wick.

Current issue:

- strict EMA rejection is skipping some good continuation entries
- especially when HTF bias is already strong
- and the candle touches/pierces EMA then closes back on the correct side
- but the upper/lower wick is not large enough to pass the current strict rejection rules

I do NOT want to weaken the whole strategy.
I want a targeted extension:

- keep current strong EMA rejection logic as the primary/A+ setup
- add a softer secondary EMA rejection continuation mode

---

## CURRENT PROBLEM

The current EMA rejection logic is too dependent on strong wick rejection structure.

This means some valid candles are skipped, even when:

- HTF bias is already aligned
- EMA slope is aligned
- candle touches/pierces EMA
- candle closes back on the correct side of EMA
- body is decent
- but wick is only moderate, not large

I want to capture those without opening the floodgates.

---

## WHAT MUST BE CHANGED

1. KEEP CURRENT STRICT EMA REJECTION
   Do not remove or weaken the current strict EMA rejection logic.

That should remain the high-confidence / strong-wick version.

---

2. ADD SOFT EMA REJECTION CONTINUATION MODE
   Create a second EMA rejection mode that can trigger when strict EMA rejection does not.

This new mode should still be selective.

For SELL soft EMA rejection:

- HTF bias must be BEARISH
- EMA slope must be bearish enough
- candle high must touch or slightly pierce EMA
- candle must close below EMA
- candle must be bearish
- body strength must be decent
- wick can be moderate instead of very strong
- still reject messy doji-like candles

For BUY soft EMA rejection:

- HTF bias must be BULLISH
- EMA slope must be bullish enough
- candle low must touch or slightly pierce EMA
- candle must close above EMA
- candle must be bullish
- body strength must be decent
- wick can be moderate instead of very strong
- still reject messy doji-like candles

This should be a continuation-style EMA rejection, not just any EMA touch.

---

3. STRICT MODE SHOULD HAVE PRIORITY
   If strict EMA rejection matches, use that.
   Only use soft EMA rejection if strict EMA rejection does not match.

So the flow should be:

- check strict EMA rejection first
- if no strict match, then check soft EMA rejection
- if soft matches, emit EMA rejection signal with a reason that makes it clear it is a softer continuation-style rejection

---

4. KEEP HTF ALIGNMENT MANDATORY FOR SOFT MODE
   Do not allow soft EMA rejection in neutral HTF.

Soft mode should only work when:

- BUY -> HTF bullish
- SELL -> HTF bearish

This is important so it does not become noisy.

---

5. KEEP BODY-QUALITY FILTER
   Even soft mode should not allow poor candles.

Require:

- minimum body strength
- avoid tiny-body / doji-like candles
- avoid candles with no meaningful reclaim/reject close

If helpful, use symbol-specific profile values.

---

6. KEEP SIDE LOCK / LEG LOCK RESPECTED
   Do not bypass existing same-side / same-leg locks.

If soft EMA rejection matches:

- it must still pass the existing side-wide HTF lock and setup-level lock filters
- do not create a loophole around current lock controls

---

7. KEEP OTHER SETUPS UNCHANGED
   Do not broadly rewrite:

- Trend Pullback
- Liquidity Sweep
- trade management
- retracement-entry logic

This task is specifically about improving missed EMA continuation-style rejections.

---

8. MAKE IT CLEAN IN THE REASON / LABELING
   If soft EMA rejection is used, make the reason explicit.

Examples:

- `EMA Rejection BUY (strict wick rejection)`
- `EMA Rejection BUY (soft continuation close-back-above-EMA)`
- `EMA Rejection SELL (soft continuation close-back-below-EMA)`

Keep it readable and useful for logs/UI.

---

9. KEEP CODE CLEAN AND MINIMAL
   Very important:

- update only EMA rejection detection and any small supporting profile/config pieces
- preserve current architecture
- add only small helpers if useful
- keep changes minimal and production-friendly

---

## EXPECTED IMPLEMENTATION STYLE

I want real TypeScript code.

Likely areas to update:

- `checkEmaRejection()`
- small helper methods for strict vs soft EMA rejection
- symbol profile thresholds if needed
- reason strings / labels

You may add helpers like:

- `checkStrictEmaRejection(...)`
- `checkSoftEmaRejection(...)`
- `isValidSoftContinuationRejection(...)`

But keep naming clean and easy to follow.

---

## WHAT I WANT IN YOUR RESPONSE

Respond in this exact order:

1. Brief summary of why strict EMA rejection is missing some continuation-style EMA trades
2. Exact methods/functions/types/constants you will change
3. Updated TypeScript code for the changed methods/code blocks
4. Any new helper methods added
5. Any new config/profile values required
6. Brief explanation of how strict vs soft EMA rejection now works
7. Brief explanation of why soft EMA rejection is still controlled and not noisy

---

## IMPORTANT CODING RULES

- Output real TypeScript code
- No pseudocode
- No vague placeholders
- Keep changes minimal and clean
- Preserve current architecture
- Do not redesign the whole service
- Do not remove current protections
- Code must be paste-ready for my existing `delta.service.ts`

---

## FILES TO REFER

Please refer to:

- existing `delta.service.ts`
- latest `trade-scan-ETHUSD-SCALPING-2026-03-17.log`
- `scalping-strategy-report.md`

Use them to understand:

- strict EMA rejection is currently working
- but some visually valid continuation-style EMA rejection candles are still being skipped
- the next step is a controlled soft EMA rejection mode, not a broad loosening

Now update the code exactly for this soft EMA rejection continuation improvement.

Now update the code exactly for this same-pattern lockout + fresh-HTF-leg re-arm improvement.

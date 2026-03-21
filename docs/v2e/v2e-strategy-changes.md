Paste this directly into your AI prompt or .md file.

Critical Fix Prompt: Replace single pendingSeq with multi-sequence pending queue and process confirmations correctly

I want you to patch my current detectDaySellSignalsV2Enhanced(...) implementation.

Do not redesign the whole strategy.
Do not change unrelated setups unless necessary.
Do not hardcode anything for one instrument, one date, or one session.

This must be a focused structural fix for the new 2-candle Day High Rejection / Liquidity Sweep model.

Main problem

The current code uses only one global pending sequence slot, something like:

let pendingSeq: PendingRejectionSetup | null = null;

Then when Setup B / B2 / E finds a new 2-candle rejection candidate, the code does:

pendingSeq = { ... }

This means every new candidate overwrites the previous one.

As a result:

a valid DHR setup can be created

then a B2 or E setup appears later

the original pending setup is lost

so the earlier setup never gets a chance to confirm

This is the main reason I still do not see meaningful change in output.

Main goal

Replace the single global pendingSeq model with a proper multi-sequence pending queue/list.

I want the strategy to be able to track multiple pending high-rejection sequences at the same time, such as:

normal Day High Rejection sequence

sweep / failed-breakout sequence

first-hour-high rejection sequence if applicable

liquidity sweep sequence

Each pending sequence must be tracked independently and evaluated independently.

What I want changed

1. Remove the single pending sequence slot

If the current code has something like:

let pendingSeq: PendingRejectionSetup | null = null;

I want that removed.

Replace with something like:
const pendingSeqs: PendingRejectionSetup[] = [];

or equivalent.

You can use your own naming, but I want a true list/queue of pending setups.

2. Add a real pending sequence structure

Each pending sequence should store enough information to be confirmed later without ambiguity.

Example idea
type PendingRejectionSetup = {
seqType: 'DHR' | 'SWEEP' | 'LIQ_SWEEP' | 'FIRST_HOUR_HIGH';
setupIndex: number;
setupTime?: string | number | Date;
zoneReference: number;
zoneType?: string;
setupHigh: number;
setupLow: number;
setupMidpoint: number;
expiryIndex: number;
marketStateAtSetup: string;
meta?: Record<string, any>;
};

You can rename fields, but this is the kind of information I want stored.

Goal

Each sequence should be independently tracked and confirmed later.

3. When B / B2 / E find a candidate, push into pending queue instead of overwriting

Right now the code probably does:

pendingSeq = { ... }

I want this changed to:

create a new pending sequence object

append it to pendingSeqs

but only if a very similar pending sequence is not already active nearby

Important

Do not create duplicate pending sequences endlessly.

So before pushing a new pending sequence:

check whether there is already a similar pending sequence of the same type near the same zone

if yes, either skip it or update/merge intelligently

Suggested helper

hasSimilarPendingSequence(...)

mergeOrAppendPendingSequence(...)

4. Process confirmations by iterating over all pending sequences

I want the confirmation logic to process every active pending sequence, not just one.

Required patch

On each candle:

iterate over pendingSeqs

for each pending sequence:

check if expired

check if invalidated

check if confirmation candle is valid

trigger signal if confirmed

remove sequence if consumed or expired

keep sequence if still active

Important

Do not stop after checking only one sequence.
Evaluate all active pending sequences properly.

5. Remove only the matched / expired / invalidated sequence, not all sequences

When one pending sequence:

confirms

expires

becomes invalid

remove only that one from pendingSeqs.

Do not clear the whole queue unless absolutely necessary.

Goal

One sequence should not destroy unrelated pending setups.

6. Keep per-sequence confirmation logic

I want each pending sequence to carry its own type and confirmation rules.

Example

For DHR:

confirm with DHR confirmation rules

For SWEEP:

confirm with sweep/failure rules

For LIQ_SWEEP:

confirm with liquidity-sweep rules

For FIRST_HOUR_HIGH if used:

confirm with range-edge rejection rules

Goal

The pending queue should not become one generic blob.
Each setup type must still behave correctly.

7. Increase confirmation window slightly

Current sequence confirmation window is too short.

If current code uses something like:

seqConfirmWindowCandles: 2

please increase it to a more practical default, for example:

3
or

4

Keep configurable.

Goal

Valid rejection sequences should get enough time to confirm.

8. Relax sequence confirmation slightly

Current confirmation may still be too strict if it only wants close below setup midpoint.

I want confirmation to allow one or more of these:

low breaks setup low

close below setup midpoint

close below setup low

strong bearish follow-through candle

weak close under rejection zone

Important

Do not make it noisy.
But do not require only one very narrow confirmation rule either.

Suggested helpers

isValidDhrConfirmationCandle(...)

isValidSweepConfirmationCandle(...)

isSequenceConfirmed(...)

9. Add invalidation rules per sequence

Each pending sequence should expire early if its premise is broken.

Example invalidation rules

For bearish rejection sequences:

price closes strongly above setup high

price accepts above swept level

zone invalidates

structure becomes bullish relative to setup premise

Suggested helper

isPendingSequenceInvalidated(...)

10. Add better debug logs for the queue lifecycle

I want clear logs for the pending sequence system.

Please add logs for:

sequence added

sequence skipped because similar pending exists

sequence confirmed

sequence expired

sequence invalidated

sequence merged/updated if you choose to do that

This is very important because I want to see whether the queue is really working.

Exact behavior I want after patch
When Candle A creates a Day High Rejection candidate

add a DHR pending sequence to the queue

do not destroy other pending sequences

When Candle A creates a Sweep candidate

add a sweep pending sequence to the queue

do not overwrite DHR if already present

On later candles

each active sequence is checked independently

whichever one confirms should trigger

others should continue until confirmed, expired, or invalidated

What I need in the response

Please provide all of the following:

1. Patch summary

Explain clearly why using one global pendingSeq is wrong and how the queue fixes it.

2. Exact overwrite plan

Show exactly:

where single pendingSeq should be removed

where pendingSeqs should be introduced

where candidate creation should change

where confirmation loop should be rewritten

where removal/cleanup should happen

3. Updated TypeScript code

Give me production-style TypeScript code for:

multi-sequence queue structure

candidate insertion logic

confirmation processing loop

expiration/invalidation handling

cleanup logic

4. New helper functions

Include helpers such as:

hasSimilarPendingSequence(...)

addPendingSequence(...)

processPendingSequences(...)

isPendingSequenceExpired(...)

isPendingSequenceInvalidated(...)

confirmPendingSequence(...)

You can rename them, but keep the logic clear.

5. Config updates

Provide any new config fields / recommended defaults for:

sequence confirmation window

similarity tolerance for queue de-duplication

pending sequence invalidation tolerance

optional merge behavior

6. Behavior explanation

Explain how the new queue behaves for:

multiple overlapping DHR candidates

overlapping sweep and DHR candidates

sequence confirmation on later candles

expiration without destroying unrelated setups

7. Safeguards

Explain how this avoids:

one candidate overwriting another

losing good setups before confirmation

growing an unbounded noisy queue

overfitting to one chart/date

Important constraints

General fix only

No instrument-specific tuning

No date-specific tuning

Patch only the pending sequence architecture for B / B2 / E style setups

Keep the current strategy structure

Expected response format

Please respond in this exact structure:

Patch Summary
Exact Overwrite Plan
Updated TypeScript Code
Updated Helper Functions
Config Updates
Behavior by Sequence Queue Scenario
Safeguards Against Lost Pending Setups
Final goal

After this patch, I want the strategy to:

stop losing one valid DHR/sweep setup because another one appeared later

support multiple pending high-rejection sequences properly

confirm each sequence independently

finally make the 2-candle model behave like a real sequence engine

stay general across instruments, sessions, and dates

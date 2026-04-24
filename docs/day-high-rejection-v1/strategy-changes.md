Modify the existing `day-high-rejection.strategy.ts` file only. Do not create a new file.

Make these adjustments:

1. Prevent zone rearm too early
   Add a new optional config:

- `minRearmCandles?: number`
  Default it to `3`.

In cooldown logic, do NOT allow `movedAway` alone to rearm the zone immediately after 1 candle.
Change logic to:

- rearm if `candlesSinceSig >= zoneCooldownCandles`
  OR
- rearm if `candlesSinceSig >= minRearmCandles && movedAway`

This should stop rearming after just 1 candle.

2. Tighten body-only rejection quality
   Right now near-touch rejection allows:

- red candle
- close below zone
- and either strong wick OR strong bearish body

Keep wick logic.
But replace plain body-only rejection with stricter body rejection:

- bearish body ratio >= minBearishBodyRatio
- candle is red
- candle close is in bottom 25% of its total range

Add helper:

```ts
const closePositionInRange =
  totalRange > 0 ? (candle.close - candle.low) / totalRange : 1;

  Then:

const hasStrongBearishBodyRejection =
  isRedCandle &&
  bearishBodyRatio >= minBearishBodyRatio &&
  closePositionInRange <= 0.25;

Use:

const isRejection =
  isRedCandle &&
  closedBackBelowZone &&
  (hasSignificantUpperWick || hasStrongBearishBodyRejection);

Also update rejection logging to show closePositionInRange.

Tighten sweep body-only logic the same way
For sweep rejection, if wick is not strong, body-only should qualify only when close is near candle low.
Apply the same bottom-25%-of-range logic.
Add optional config to prefer wick-based rejection
Add:
preferWickRejection?: boolean
Default: false

If preferWickRejection = true, then near-touch direct entries should require hasSignificantUpperWick.
Body-only rejection may still be allowed for setup recognition when 1m confirmation mode is enabled, but not for direct entry.

Keep existing adaptive thresholds
Do not remove adaptive threshold logic.
Do not change public interfaces except adding backward-compatible optional config fields.
Preserve current structure and logs
Keep detectDayHighRejectionOnly(...).
Keep existing signal types.
Keep file standalone.

Return the full updated code and include a short summary of the changes.
```

Update the "Day Low Break Selling" strategy with the following logic:

1. Mark the low of the first 5-minute candle of the trading day as:
   - dayFirst5mLow

2. Ignore RSI completely for this setup.

3. A valid breakdown occurs only when any later 5-minute candle CLOSES below dayFirst5mLow.

4. After a valid 5-minute breakdown, do not enter immediately.

5. Move to 1-minute confirmation logic:
   - wait for the next completed 1-minute candle
   - take sell only if that 1-minute candle also CLOSES below dayFirst5mLow

6. Entry options:
   - conservative: enter at next candle open after 1-minute confirmation close
   - aggressive: enter on break of 1-minute confirmation candle low

7. Add filters:
   - price should be below 20 EMA
   - skip if 1-minute confirmation candle has a strong lower wick rejection
   - skip if entry is too far below dayFirst5mLow (configurable max distance)
   - skip if 5-minute breakdown candle is too small or weak

8. Stop loss options:
   - aggressive SL: above 1-minute confirmation candle high
   - safer SL: above 5-minute breakdown candle high

9. Add logs:
   - "Day first 5-minute low marked"
   - "5-minute day low breakdown detected"
   - "Waiting for 1-minute confirmation close"
   - "1-minute confirmation valid, sell triggered"
   - "Skipped: 1-minute rejection wick"
   - "Skipped: entry too extended"
   - "Skipped: price above 20 EMA"

10. Make all thresholds configurable:

- max confirmation wick %
- max entry distance from breakdown level
- minimum 5-minute breakdown candle body size
- EMA distance threshold

# Improved Strategy Documentation: detectDaySellSignals V2

---

# 1. Strategy Philosophy

This strategy detects **high-probability intraday SELL opportunities** in options using:

- Resistance rejection
- EMA failure
- Market structure breakdown
- Momentum exhaustion

The strategy focuses on **A+ setups only** and avoids:

- selling into support
- selling after extended drops
- selling during strong uptrends

Primary goal:

```
Sell when buyers fail at resistance.
```

---

# 2. Core Strategy Modules

The strategy contains **4 independent signal engines**.

| Engine   | Purpose                |
| -------- | ---------------------- |
| Engine 1 | First Candle Breakdown |
| Engine 2 | Resistance Rejection   |
| Engine 3 | EMA Rejection          |
| Engine 4 | Lower High Breakdown   |

Each engine can trigger **independently**.

---

# 3. Required Inputs

```
candles[]
emaValues[]
rsiValues[]
swingHighs[]
yesterdayHigh
prevDayLow
prevDayClose
superTrendData
```

---

# 4. Dynamic Parameters

### Dynamic Margin

Margin must scale with option premium.

```
marginPoints = price * 0.05
```

Example:

| Premium | Margin |
| ------- | ------ |
| 400     | 20     |
| 200     | 10     |
| 100     | 5      |

---

### Risk Limits

```
maxSellRiskPts = 35
minSellRsi = 40
```

---

# 5. Time Filters

Trade window:

```
9:25 AM – 2:45 PM
```

Avoid:

```
9:15 – 9:25 opening volatility
```

---

# 6. Market Trend Filter

Trend determined using EMA.

```
closeAboveEMA = close > EMA
closeBelowEMA = close < EMA
```

Uptrend condition:

```
last20CandlesAboveEMA > 60%
```

If true:

```
Disable all signals except resistance rejection
```

---

# 7. Engine 1: First Candle Breakdown

Purpose:

Capture **early intraday weakness**.

Trigger:

```
close < firstCandleLow
```

Breakdown candle must satisfy one:

```
1) body > 40% of range
2) bearish engulfing
3) close within bottom 20% of range
```

Stop Loss:

```
SL = candleHigh + 2
```

Risk:

```
risk <= 35
```

Support protection:

Block trade if support exists within 1R:

```
prevDayLow
intraday lows
EMA support
```

Important improvement:

```
Allow up to 3 breakdown attempts
```

---

# 8. Engine 2: Resistance Rejection

Purpose:

Sell when price fails near resistance.

Resistance sources:

```
swingHighs
yesterdayHigh
prevDayClose
dayHighZone
EMA
```

A candle is near resistance when:

```
abs(candleHigh - resistance) <= marginPoints
```

Rejection candle:

One of the following:

```
upperWick > body * 1.5
upperWick > 40% of range
shooting star
bearish engulfing
```

Confirmation:

```
close < open
```

Stop Loss:

```
SL = resistance + 2
```

---

# 9. Engine 3: EMA Rejection

Purpose:

Sell when EMA acts as resistance.

Conditions:

```
candleHigh touches EMA
close < EMA
red candle
```

Additional confirmation:

```
lower highs forming
```

Example:

```
high[i-1] < high[i-2]
```

Avoid trade if EMA recently acted as support:

```
EMA bounce count >= 3
```

Stop Loss:

```
SL = candleHigh + 2
```

---

# 10. Engine 4: Lower High Breakdown

Purpose:

Sell trend continuation after pullback.

Conditions:

```
lowerHigh formed
price rejects EMA
red candle confirmation
```

Structure:

```
high[i] < high[i-1]
high[i-1] < high[i-2]
```

Entry:

```
close below pullback candle
```

Stop Loss:

```
SL = pullbackHigh + 2
```

---

# 11. RSI Quality Filter

Avoid selling oversold moves.

```
RSI >= 40
```

Exception:

```
Resistance rejection signals
```

These can trigger even if RSI < 40.

---

# 12. SuperTrend Filter

SuperTrend acts as trend confirmation.

If:

```
superTrend = up
```

Allow only:

```
Resistance Rejection
EMA Rejection
```

Block:

```
Breakdown signals
```

---

# 13. Stop Loss Logic

Stop loss priority:

```
1) nearest swing high
2) resistance level
3) candleHigh + 2
```

Maximum allowed risk:

```
<= 35 points
```

---

# 14. Support Protection

Never sell directly into support.

Check below entry:

```
EMA
prevDayLow
recent intraday lows
```

If support distance:

```
< risk
```

Then block trade.

---

# 15. Signal Priority

When multiple patterns trigger:

```
1 Day High Rejection
2 EMA Rejection
3 Lower High Breakdown
4 Resistance Rejection
5 First Candle Breakdown
```

Only **one signal per candle** is emitted.

---

# 16. Trade Output

Each signal must return:

```
{
  candleIndex
  entryPrice
  stopLoss
  risk
  signalType
  resistanceLevel
  rsi
  ema
}
```

---

# 17. Trade Quality Score (New Feature)

Each signal receives score:

```
score = 0
```

Add points:

```
+2 resistance rejection
+2 lower high structure
+1 EMA rejection
+1 RSI > 50
+1 multiple resistance tests
```

Only trade if:

```
score >= 3
```

---

# 18. Example A+ Setup

Scenario:

```
Price near swing high
Upper wick rejection
Red candle
RSI 55
Lower high forming
EMA above price
```

Result:

```
SELL signal generated
```

---

# 19. Expected Strategy Behavior

The system should generate:

```
2–6 high quality signals per day
```

per instrument.

Low signal count = **higher quality trades**.

---

# 20. Strategy Goals

Target performance:

```
Win rate: 55–65%
Risk reward: 1:2+
Monthly accuracy improvement through journaling
```

---

# End of Strategy V2

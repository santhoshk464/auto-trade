# Automated Option Monitor - Market Hours Scheduler

## Overview

The system now runs **automatically during market hours** (9:15 AM - 2:30 PM IST, Monday-Friday) without requiring manual button clicks.

## How It Works

### 1. **Automated Scheduling**

- **Runs every 5 minutes** during market hours
- Specifically at: 15, 20, 25, 30, 35, 40, 45, 50, 55 past each hour
- Only active from **9:15 AM to 2:30 PM IST** on weekdays
- Automatically skips runs outside market hours

### 2. **Strategy**

- **Only uses DAY_SELLING strategy** for paper trading (as per requirement)
- Analyzes NIFTY options with the nearest weekly expiry
- Uses 5-minute candles for intraday analysis

### 3. **Auto-Trading**

The existing auto-trading logic is triggered automatically:

- **Max 1 active trade** at a time per day
- **Max daily loss: 35 points**
- **Stops trading** if any target hits
- Uses **earliest signal by time** across all options

### 4. **Scheduler Logs**

Watch for these log messages:

```
🔔 Market is now OPEN. Starting automated monitoring...
🤖 Auto-running Option Monitor (Market Hours)
Running for broker: [Broker Name] (User: [User ID])
✅ Completed for [Broker Name]: X options analyzed
🔔 Market is now CLOSED. Stopping automated monitoring...
```

## Configuration

### Scheduler Settings (in `kite.scheduler.ts`):

```typescript
@Cron('15,20,25,30,35,40,45,50,55 9-14 * * 1-5', {
  timeZone: 'Asia/Kolkata',
})
```

- **Interval**: Every 5 minutes
- **Hours**: 9 AM - 2 PM (covers 9:15 AM - 2:30 PM)
- **Days**: Monday-Friday (1-5)
- **Timezone**: Asia/Kolkata (IST)

### Strategy Parameters:

- **Symbol**: NIFTY
- **Exchange**: NSE (NFO for derivatives)
- **Strategy**: DAY_SELLING only
- **Interval**: 5-minute candles
- **Margin Points**: 20
- **Time**: 15:30 (market close for analysis)

## Daily Limits (per target date)

All limits are enforced **per trading day**:

1. ✅ Max 1 active trade
2. ✅ Max loss: 35 points total
3. ✅ Stop if any target hits (T1/T2/T3)
4. ✅ Risk per trade: Based on signal (typically 20-35 points)
5. ✅ Reward ratio: 1:2, 1:3, 1:4 (T1, T2, T3)

## Manual Override

You can still manually run Option Monitor through the UI:

- Navigate to `/option-monitor`
- Click "Get Options for Strategies"
- This works independently of the automated scheduler

## Disabling Automated Monitoring

To temporarily disable:

1. Comment out the `@Cron()` decorator in `kite.scheduler.ts`
2. Server will hot-reload and skip automated runs

To permanently remove:

1. Remove `KiteScheduler` from `kite.module.ts` providers
2. Delete `kite.scheduler.ts`

## Testing

To test the scheduler without waiting for market hours:

1. Modify the cron expression in `kite.scheduler.ts`
2. Example for testing (runs every minute):
   ```typescript
   @Cron('* * * * *') // Every minute
   ```
3. Add time check bypass in `runOptionMonitorDuringMarketHours()`:
   ```typescript
   // Comment out market hours check for testing
   // if (isBeforeMarketOpen || isAfterMarketClose) return;
   ```

## Troubleshooting

### Scheduler not running?

1. Check terminal for initialization: `InstanceLoader] ScheduleModule dependencies initialized`
2. Verify broker has valid access token
3. Check logs for error messages

### No trades created?

1. Verify daily limits not exceeded
2. Check if signals are being generated
3. Ensure broker is connected
4. Review logs for "Auto-trading enabled" message

### Duplicate trades?

- Scheduler prevents concurrent runs with `isRunning` flag
- Only earliest signal per run creates a trade

## Architecture

```
KiteScheduler (kite.scheduler.ts)
    ↓
    Every 5 minutes during market hours
    ↓
KiteService.optionMonitor()
    ↓
    Analyzes options with DAY_SELLING strategy
    ↓
    Auto-creates paper trade (if eligible)
    ↓
PaperTradingService.createPaperTrade()
    ↓
    Historical closure logic (if past date)
    ↓
Database (SQLite via Prisma)
```

## Next Steps

- ✅ Automated monitoring active
- ✅ DAY_SELLING strategy only
- ✅ Proper target/SL calculations based on actual risk
- ✅ Historical trade closure with candle data
- 🔜 Add email/SMS notifications for trades
- 🔜 Web dashboard for real-time monitoring
- 🔜 Export trade history to CSV

# Instruments Database

## Overview

The instruments database stores Zerodha Kite Connect's instruments master data for **historical analysis and backtesting**. The system automatically downloads and syncs instruments daily, preserving historical data for instruments that are no longer active (expired options, delisted stocks, etc.).

### Key Features

- **Historical Data Preservation**: Never deletes instruments - keeps expired/delisted instruments for backtesting
- **Daily Auto-Sync**: Automatically downloads and updates instruments every day at 7:30 AM
- **Smart Updates**: Only inserts new instruments and updates existing ones (no data loss)
- **Tracking Fields**: Records when an instrument was first seen and last seen
- **Backtesting Support**: Query instruments as they existed on any past date

## Database Schema

The `Instrument` model stores the following fields:

- **instrumentToken**: Unique identifier for the instrument
- **exchangeToken**: Exchange-specific token
- **tradingsymbol**: Trading symbol (e.g., `NIFTY26FEB25450CE`)
- **name**: Instrument name (e.g., `NIFTY`)
- **lastPrice**: Last traded price (typically 0 in master data)
- **expiry**: Expiry date in YYYY-MM-DD format
- **strike**: Strike price for options
- **tickSize**: Minimum price tick
- **lotSize**: Lot size for trading
- **instrumentType**: Type (CE, PE, FUT, EQ, etc.)
- **segment**: Market segment (NSE, NFO, BFO-OPT, etc.)
- **exchange**: Exchange name (NSE, NFO, BFO, BSE, etc.)
- **lastSeenDate**: When the instrument was last seen in daily sync (NEW)
- **firstSeenDate**: When the instrument was first added to database (NEW)

## Automated Daily Sync

### How It Works

Every day at **7:30 AM IST** (before market opens), the system:

1. Downloads the latest instruments CSV from Kite API (`https://api.kite.trade/instruments`)
2. Compares with existing database
3. **Inserts** new instruments
4. **Updates** existing instruments (price, lot size, etc.)
5. **Preserves** historical instruments (expired/delisted)
6. Updates `lastSeenDate` for all active instruments

### Scheduler Configuration

The scheduler runs automatically via `KiteScheduler.dailyInstrumentsSync()`:

- **Schedule**: `30 7 * * 1-6` (7:30 AM, Mon-Sat)
- **Time Zone**: Asia/Kolkata
- **Prevents concurrent runs**: Only one sync at a time

### Logs

Check application logs for sync status:

```
🔄 Starting daily instruments sync from Kite API...
Downloaded 5.2 MB
Parsed 167843 instruments from CSV
✅ Instruments sync complete! New: 125, Updated: 167718, Total: 167843
🆕 125 new instruments added today
```

## Manual Sync Options

### 1. Auto Sync (Download + Import)

```bash
cd apps/api
npx tsx scripts/sync-instruments.ts
```

This will:

- Download from Kite API
- Save backup to `downloads/backups/instruments_YYYY-MM-DD.csv`
- Import into database (preserving historical data)

### 2. Download Only

```bash
npx tsx scripts/sync-instruments.ts download ./my-instruments.csv
```

Downloads instruments and saves to the specified file.

### 3. Import from Local File

```bash
npx tsx scripts/sync-instruments.ts import ./my-instruments.csv
```

Imports from a local CSV file.

### 4. Legacy Import (with mode flag)

```bash
# Fresh import (clears all data)
npx tsx scripts/import-instruments.ts ./instruments.csv

# Update mode (preserves historical data)
npx tsx scripts/import-instruments.ts ./instruments.csv update
```

## Querying Instruments

### Test Queries

Run the example queries script:

```bash
cd apps/api
npx tsx scripts/query-instruments.ts
```

This demonstrates various query patterns.

### Common Query Examples

#### 1. Find Options for a Specific Expiry

```typescript
const niftyOptions = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    expiry: '2026-02-26',
    instrumentType: { in: ['CE', 'PE'] },
  },
  orderBy: [{ instrumentType: 'asc' }, { strike: 'asc' }],
});
```

#### 2. Get All Expiry Dates for an Index

```typescript
const niftyExpiries = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    instrumentType: { in: ['CE', 'PE'] },
    expiry: { not: null },
  },
  distinct: ['expiry'],
  select: { expiry: true },
  orderBy: { expiry: 'asc' },
});
```

#### 3. Find Instrument by Token

```typescript
const instrument = await prisma.instrument.findUnique({
  where: {
    instrumentToken: 256265, // NIFTY 50 index
  },
});
```

#### 4. Search by Trading Symbol Pattern

```typescript
const instruments = await prisma.instrument.findMany({
  where: {
    tradingsymbol: {
      contains: 'BANKNIFTY26FEB',
    },
    instrumentType: 'CE',
  },
  orderBy: { strike: 'asc' },
});
```

#### 5. Get ATM Options for a Strike Range

```typescript
const atmOptions = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    expiry: '2026-02-26',
    strike: {
      gte: 25400,
      lte: 25600,
    },
    instrumentType: { in: ['CE', 'PE'] },
  },
  orderBy: [{ strike: 'asc' }, { instrumentType: 'asc' }],
});
```

#### 6. Get All Futures for a Symbol

```typescript
const futures = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    instrumentType: 'FUT',
  },
  orderBy: { expiry: 'asc' },
});
```

## Use Cases for Historical Scanning

### 1. Backtesting with Historical Instruments

**Problem**: When backtesting strategies for March 3, 2026, you need the option chain and instrument tokens as they existed on that date. Current API calls only return active instruments.

**Solution**: Query instruments by `lastSeenDate` to get instruments that were active on a specific date.

```typescript
// Get all NIFTY options that were active on March 3, 2026
const targetDate = new Date('2026-03-03');
const expiry = '2026-03-06'; // Weekly expiry

const historicalOptions = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    expiry: expiry,
    instrumentType: { in: ['CE', 'PE'] },
    firstSeenDate: { lte: targetDate }, // Existed by this date
    lastSeenDate: { gte: targetDate }, // Still active on this date
  },
  orderBy: [{ strike: 'asc' }, { instrumentType: 'asc' }],
});
```

### 2. Finding Expired Instruments

```typescript
// Get all NIFTY options that expired on Dec 1, 2026
const expiredOptions = await prisma.instrument.findMany({
  where: {
    name: 'NIFTY',
    expiry: '2026-12-01',
    instrumentType: { in: ['CE', 'PE'] },
  },
});

// Even if they're no longer in current Kite API, they're in your DB!
```

### 3. Tracking Delisted Stocks

```typescript
// Find instruments not seen in last 30 days (potentially delisted)
const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

const potentiallyDelisted = await prisma.instrument.findMany({
  where: {
    instrumentType: 'EQ',
    lastSeenDate: { lt: thirtyDaysAgo },
  },
});
```

### 4. New Listings Detection

```typescript
// Find instruments added in the last 7 days
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

const newListings = await prisma.instrument.findMany({
  where: {
    firstSeenDate: { gte: sevenDaysAgo },
  },
  orderBy: { firstSeenDate: 'desc' },
});
```

### 5. Historical Option Chain Reconstruction

```typescript
// Reconstruct the option chain as it was on a specific date
async function getHistoricalOptionChain(
  symbol: string,
  expiry: string,
  date: Date,
  atmStrike: number,
  range: number = 500,
) {
  return await prisma.instrument.findMany({
    where: {
      name: symbol,
      expiry: expiry,
      instrumentType: { in: ['CE', 'PE'] },
      strike: {
        gte: atmStrike - range,
        lte: atmStrike + range,
      },
      firstSeenDate: { lte: date },
      lastSeenDate: { gte: date },
    },
    orderBy: [{ strike: 'asc' }, { instrumentType: 'asc' }],
  });
}

// Usage: Get NIFTY option chain as it was on Dec 1, 2026
const historicalChain = await getHistoricalOptionChain(
  'NIFTY',
  '2026-12-05',
  new Date('2026-12-01'),
  25500,
);
```

## Integration with Existing Code

### Example: Using in KiteService

```typescript
// apps/api/src/kite/kite.service.ts

async getOptionChainFromDB(
  symbol: string,
  expiry: string,
  minStrike?: number,
  maxStrike?: number,
) {
  const where: any = {
    name: symbol,
    expiry: expiry,
    instrumentType: { in: ['CE', 'PE'] },
  };

  if (minStrike && maxStrike) {
    where.strike = { gte: minStrike, lte: maxStrike };
  }

  return await this.prisma.instrument.findMany({
    where,
    orderBy: [
      { strike: 'asc' },
      { instrumentType: 'asc' },
    ],
  });
}
```

## Maintenance

### Checking Sync Status

```bash
# View instruments added today
cd apps/api
npx prisma studio

# Or query directly
npx prisma db execute "SELECT COUNT(*) FROM Instrument WHERE date(firstSeenDate) = date('now')"
```

### Database Size Management

The database grows over time as new instruments are added and old ones are preserved:

- **Initial size**: ~167,843 instruments (Feb 2026)
- **Growth rate**: Approximately 100-500 new instruments per month
- **Database size**: ~50-100 MB (SQLite)
- **Annual growth**: ~1,200-6,000 instruments

After 1 year: ~170,000-174,000 instruments  
After 5 years: ~180,000-200,000 instruments

### Archiving Old Data (Optional)

If you need to reduce database size, you can archive instruments not seen in 1+ years:

```typescript
// Archive instruments not seen in last 365 days
const oneYearAgo = new Date();
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

// Export to backup first
const oldInstruments = await prisma.instrument.findMany({
  where: { lastSeenDate: { lt: oneYearAgo } },
});

// Save to JSON file
fs.writeFileSync(
  `archive_${Date.now()}.json`,
  JSON.stringify(oldInstruments, null, 2),
);

// Then delete (optional - not recommended for backtesting)
// await prisma.instrument.deleteMany({
//   where: { lastSeenDate: { lt: oneYearAgo } },
// });
```

### Re-Importing from Scratch

If you need to start fresh:

```bash
# Warning: This deletes all historical data!
cd apps/api

# Method 1: Using import script
npx tsx scripts/import-instruments.ts ./instruments.csv

# Method 2: Using sync script with fresh download
# First, manually delete database or use Prisma Studio
npx tsx scripts/sync-instruments.ts auto
```

## Scripts Reference

| Script                          | Purpose                         | Usage                                                          |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `scripts/sync-instruments.ts`   | Download from Kite API and sync | `npx tsx scripts/sync-instruments.ts [auto\|download\|import]` |
| `scripts/import-instruments.ts` | Import from local CSV           | `npx tsx scripts/import-instruments.ts <csv-path> [update]`    |
| `scripts/query-instruments.ts`  | Run example queries             | `npx tsx scripts/query-instruments.ts`                         |

## Future Enhancements

- [x] Daily automated sync from Kite API
- [x] Historical data preservation
- [x] Track first seen and last seen dates
- [ ] API endpoint to query by date range
- [ ] WebSocket updates for real-time changes
- [ ] Historical snapshots (monthly archives)
- [ ] Instrument change tracking (lot size changes, etc.)
- [ ] Full-text search on trading symbols
- [ ] Statistics dashboard showing growth over time

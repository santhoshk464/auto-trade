-- CreateTable
CREATE TABLE "LiveTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "optionSymbol" TEXT NOT NULL,
    "instrumentToken" INTEGER NOT NULL,
    "strike" REAL NOT NULL,
    "optionType" TEXT NOT NULL,
    "expiryDate" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NFO',
    "lotSize" INTEGER NOT NULL DEFAULT 75,
    "strategy" TEXT NOT NULL,
    "signalId" TEXT,
    "hedgeSymbol" TEXT,
    "hedgeOrderId" TEXT,
    "hedgePrice" REAL,
    "hedgeQty" INTEGER NOT NULL DEFAULT 0,
    "hedgeFilled" BOOLEAN NOT NULL DEFAULT false,
    "entryOrderId" TEXT,
    "entryPrice" REAL,
    "entryLimitPrice" REAL,
    "entryFilledPrice" REAL,
    "entryFilledTime" DATETIME,
    "entryQty" INTEGER NOT NULL DEFAULT 0,
    "entryFilled" BOOLEAN NOT NULL DEFAULT false,
    "targetOrderId" TEXT,
    "targetPrice" REAL,
    "targetFilled" BOOLEAN NOT NULL DEFAULT false,
    "targetFilledPrice" REAL,
    "targetFilledTime" DATETIME,
    "slOrderId" TEXT,
    "slPrice" REAL,
    "slFilled" BOOLEAN NOT NULL DEFAULT false,
    "slFilledPrice" REAL,
    "slFilledTime" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING_HEDGE',
    "pnl" REAL,
    "exitPrice" REAL,
    "exitTime" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiveTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveTrade_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TradingSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "hedgeLots" INTEGER NOT NULL DEFAULT 1,
    "sellLots" INTEGER NOT NULL DEFAULT 1,
    "bufferPoints" REAL NOT NULL DEFAULT 5,
    "liveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradingSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TradingSettings" ("bufferPoints", "createdAt", "hedgeLots", "id", "sellLots", "symbol", "updatedAt", "userId") SELECT "bufferPoints", "createdAt", "hedgeLots", "id", "sellLots", "symbol", "updatedAt", "userId" FROM "TradingSettings";
DROP TABLE "TradingSettings";
ALTER TABLE "new_TradingSettings" RENAME TO "TradingSettings";
CREATE INDEX "TradingSettings_userId_idx" ON "TradingSettings"("userId");
CREATE INDEX "TradingSettings_symbol_idx" ON "TradingSettings"("symbol");
CREATE UNIQUE INDEX "TradingSettings_userId_symbol_key" ON "TradingSettings"("userId", "symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LiveTrade_userId_idx" ON "LiveTrade"("userId");

-- CreateIndex
CREATE INDEX "LiveTrade_brokerId_idx" ON "LiveTrade"("brokerId");

-- CreateIndex
CREATE INDEX "LiveTrade_status_idx" ON "LiveTrade"("status");

-- CreateIndex
CREATE INDEX "LiveTrade_optionSymbol_idx" ON "LiveTrade"("optionSymbol");

-- CreateIndex
CREATE INDEX "LiveTrade_strategy_idx" ON "LiveTrade"("strategy");

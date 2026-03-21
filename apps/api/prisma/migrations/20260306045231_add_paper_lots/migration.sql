-- CreateTable
CREATE TABLE "CandleCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentToken" INTEGER NOT NULL,
    "dateStr" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "candlesJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "paperLots" INTEGER NOT NULL DEFAULT 1,
    "bufferPoints" REAL NOT NULL DEFAULT 5,
    "liveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradingSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TradingSettings" ("bufferPoints", "createdAt", "hedgeLots", "id", "liveEnabled", "sellLots", "symbol", "updatedAt", "userId") SELECT "bufferPoints", "createdAt", "hedgeLots", "id", "liveEnabled", "sellLots", "symbol", "updatedAt", "userId" FROM "TradingSettings";
DROP TABLE "TradingSettings";
ALTER TABLE "new_TradingSettings" RENAME TO "TradingSettings";
CREATE INDEX "TradingSettings_userId_idx" ON "TradingSettings"("userId");
CREATE INDEX "TradingSettings_symbol_idx" ON "TradingSettings"("symbol");
CREATE UNIQUE INDEX "TradingSettings_userId_symbol_key" ON "TradingSettings"("userId", "symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CandleCache_instrumentToken_idx" ON "CandleCache"("instrumentToken");

-- CreateIndex
CREATE INDEX "CandleCache_dateStr_idx" ON "CandleCache"("dateStr");

-- CreateIndex
CREATE UNIQUE INDEX "CandleCache_instrumentToken_dateStr_interval_key" ON "CandleCache"("instrumentToken", "dateStr", "interval");

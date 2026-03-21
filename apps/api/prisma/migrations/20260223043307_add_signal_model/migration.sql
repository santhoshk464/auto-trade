/*
  Warnings:

  - You are about to drop the column `candleColor` on the `PaperTrade` table. All the data in the column will be lost.
  - You are about to drop the column `rsi` on the `PaperTrade` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "brokerId" TEXT,
    "symbol" TEXT NOT NULL,
    "optionSymbol" TEXT NOT NULL,
    "instrumentToken" INTEGER NOT NULL,
    "strike" REAL NOT NULL,
    "optionType" TEXT NOT NULL,
    "expiryDate" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "signalReason" TEXT NOT NULL,
    "signalTime" TEXT NOT NULL,
    "signalDate" DATETIME NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "target1" REAL NOT NULL,
    "target2" REAL NOT NULL,
    "target3" REAL NOT NULL,
    "ltp" REAL,
    "marginPoints" INTEGER,
    "interval" TEXT,
    "targetDate" TEXT,
    "tradeCreated" BOOLEAN NOT NULL DEFAULT false,
    "paperTradeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Signal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Signal_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaperTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "optionSymbol" TEXT NOT NULL,
    "instrumentToken" INTEGER NOT NULL,
    "strike" REAL NOT NULL,
    "optionType" TEXT NOT NULL,
    "expiryDate" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "signalReason" TEXT,
    "entryPrice" REAL NOT NULL,
    "entryTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "exitPrice" REAL,
    "exitTime" DATETIME,
    "stopLoss" REAL NOT NULL,
    "target1" REAL NOT NULL,
    "target2" REAL NOT NULL,
    "target3" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "pnl" REAL NOT NULL DEFAULT 0,
    "pnlPercentage" REAL NOT NULL DEFAULT 0,
    "marginPoints" INTEGER,
    "interval" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaperTrade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaperTrade_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PaperTrade" ("brokerId", "createdAt", "entryPrice", "entryTime", "exitPrice", "exitTime", "expiryDate", "id", "instrumentToken", "interval", "marginPoints", "optionSymbol", "optionType", "pnl", "pnlPercentage", "quantity", "signalReason", "signalType", "status", "stopLoss", "strategy", "strike", "symbol", "target1", "target2", "target3", "updatedAt", "userId") SELECT "brokerId", "createdAt", "entryPrice", "entryTime", "exitPrice", "exitTime", "expiryDate", "id", "instrumentToken", "interval", "marginPoints", "optionSymbol", "optionType", "pnl", "pnlPercentage", "quantity", "signalReason", "signalType", "status", "stopLoss", "strategy", "strike", "symbol", "target1", "target2", "target3", "updatedAt", "userId" FROM "PaperTrade";
DROP TABLE "PaperTrade";
ALTER TABLE "new_PaperTrade" RENAME TO "PaperTrade";
CREATE INDEX "PaperTrade_userId_idx" ON "PaperTrade"("userId");
CREATE INDEX "PaperTrade_brokerId_idx" ON "PaperTrade"("brokerId");
CREATE INDEX "PaperTrade_status_idx" ON "PaperTrade"("status");
CREATE INDEX "PaperTrade_entryTime_idx" ON "PaperTrade"("entryTime");
CREATE INDEX "PaperTrade_symbol_idx" ON "PaperTrade"("symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Signal_userId_idx" ON "Signal"("userId");

-- CreateIndex
CREATE INDEX "Signal_brokerId_idx" ON "Signal"("brokerId");

-- CreateIndex
CREATE INDEX "Signal_signalDate_idx" ON "Signal"("signalDate");

-- CreateIndex
CREATE INDEX "Signal_strategy_idx" ON "Signal"("strategy");

-- CreateIndex
CREATE INDEX "Signal_symbol_idx" ON "Signal"("symbol");

-- CreateIndex
CREATE INDEX "Signal_tradeCreated_idx" ON "Signal"("tradeCreated");

-- CreateTable
CREATE TABLE "PaperTrade" (
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

-- CreateIndex
CREATE INDEX "PaperTrade_userId_idx" ON "PaperTrade"("userId");

-- CreateIndex
CREATE INDEX "PaperTrade_brokerId_idx" ON "PaperTrade"("brokerId");

-- CreateIndex
CREATE INDEX "PaperTrade_status_idx" ON "PaperTrade"("status");

-- CreateIndex
CREATE INDEX "PaperTrade_entryTime_idx" ON "PaperTrade"("entryTime");

-- CreateIndex
CREATE INDEX "PaperTrade_symbol_idx" ON "PaperTrade"("symbol");

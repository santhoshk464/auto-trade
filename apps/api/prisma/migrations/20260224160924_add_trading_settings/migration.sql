-- CreateTable
CREATE TABLE "TradingSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "hedgeLots" INTEGER NOT NULL DEFAULT 1,
    "sellLots" INTEGER NOT NULL DEFAULT 1,
    "bufferPoints" REAL NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradingSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TradingSettings_userId_idx" ON "TradingSettings"("userId");

-- CreateIndex
CREATE INDEX "TradingSettings_symbol_idx" ON "TradingSettings"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TradingSettings_userId_symbol_key" ON "TradingSettings"("userId", "symbol");

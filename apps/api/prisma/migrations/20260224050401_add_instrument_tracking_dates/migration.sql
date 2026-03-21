-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Instrument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instrumentToken" INTEGER NOT NULL,
    "exchangeToken" INTEGER NOT NULL,
    "tradingsymbol" TEXT NOT NULL,
    "name" TEXT,
    "lastPrice" REAL NOT NULL DEFAULT 0,
    "expiry" TEXT,
    "strike" REAL NOT NULL DEFAULT 0,
    "tickSize" REAL NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "instrumentType" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "lastSeenDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Instrument" ("createdAt", "exchange", "exchangeToken", "expiry", "id", "instrumentToken", "instrumentType", "lastPrice", "lotSize", "name", "segment", "strike", "tickSize", "tradingsymbol", "updatedAt") SELECT "createdAt", "exchange", "exchangeToken", "expiry", "id", "instrumentToken", "instrumentType", "lastPrice", "lotSize", "name", "segment", "strike", "tickSize", "tradingsymbol", "updatedAt" FROM "Instrument";
DROP TABLE "Instrument";
ALTER TABLE "new_Instrument" RENAME TO "Instrument";
CREATE UNIQUE INDEX "Instrument_instrumentToken_key" ON "Instrument"("instrumentToken");
CREATE INDEX "Instrument_tradingsymbol_idx" ON "Instrument"("tradingsymbol");
CREATE INDEX "Instrument_instrumentToken_idx" ON "Instrument"("instrumentToken");
CREATE INDEX "Instrument_name_idx" ON "Instrument"("name");
CREATE INDEX "Instrument_exchange_idx" ON "Instrument"("exchange");
CREATE INDEX "Instrument_segment_idx" ON "Instrument"("segment");
CREATE INDEX "Instrument_instrumentType_idx" ON "Instrument"("instrumentType");
CREATE INDEX "Instrument_expiry_idx" ON "Instrument"("expiry");
CREATE INDEX "Instrument_strike_idx" ON "Instrument"("strike");
CREATE INDEX "Instrument_lastSeenDate_idx" ON "Instrument"("lastSeenDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

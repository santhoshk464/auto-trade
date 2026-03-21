-- CreateTable
CREATE TABLE "Instrument" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_instrumentToken_key" ON "Instrument"("instrumentToken");

-- CreateIndex
CREATE INDEX "Instrument_tradingsymbol_idx" ON "Instrument"("tradingsymbol");

-- CreateIndex
CREATE INDEX "Instrument_instrumentToken_idx" ON "Instrument"("instrumentToken");

-- CreateIndex
CREATE INDEX "Instrument_name_idx" ON "Instrument"("name");

-- CreateIndex
CREATE INDEX "Instrument_exchange_idx" ON "Instrument"("exchange");

-- CreateIndex
CREATE INDEX "Instrument_segment_idx" ON "Instrument"("segment");

-- CreateIndex
CREATE INDEX "Instrument_instrumentType_idx" ON "Instrument"("instrumentType");

-- CreateIndex
CREATE INDEX "Instrument_expiry_idx" ON "Instrument"("expiry");

-- CreateIndex
CREATE INDEX "Instrument_strike_idx" ON "Instrument"("strike");

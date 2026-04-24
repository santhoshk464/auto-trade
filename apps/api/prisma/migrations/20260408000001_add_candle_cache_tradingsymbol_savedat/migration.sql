-- AddColumn tradingsymbol to CandleCache
ALTER TABLE "CandleCache" ADD COLUMN "tradingsymbol" TEXT NOT NULL DEFAULT '';

-- AddColumn savedAt to CandleCache
ALTER TABLE "CandleCache" ADD COLUMN "savedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CandleCache_tradingsymbol_idx" ON "CandleCache"("tradingsymbol");

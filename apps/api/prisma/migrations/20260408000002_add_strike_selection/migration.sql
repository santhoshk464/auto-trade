-- CreateTable StrikeSelection (was in schema but missing from migrations)
CREATE TABLE IF NOT EXISTS "StrikeSelection" (
    "id"                TEXT    NOT NULL PRIMARY KEY,
    "brokerId"          TEXT    NOT NULL,
    "symbol"            TEXT    NOT NULL,
    "date"              TEXT    NOT NULL,
    "expiry"            TEXT    NOT NULL,
    "niftySpotAtOpen"   REAL    NOT NULL,
    "atmStrike"         INTEGER NOT NULL,
    "ceTradingSymbol"   TEXT    NOT NULL,
    "ceStrike"          INTEGER NOT NULL,
    "ceInstrumentToken" INTEGER NOT NULL,
    "peTradingSymbol"   TEXT    NOT NULL,
    "peStrike"          INTEGER NOT NULL,
    "peInstrumentToken" INTEGER NOT NULL,
    "selectedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrikeSelection_brokerId_fkey"
        FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StrikeSelection_brokerId_symbol_date_key" ON "StrikeSelection"("brokerId","symbol","date");
CREATE INDEX IF NOT EXISTS "StrikeSelection_brokerId_idx" ON "StrikeSelection"("brokerId");
CREATE INDEX IF NOT EXISTS "StrikeSelection_date_idx" ON "StrikeSelection"("date");

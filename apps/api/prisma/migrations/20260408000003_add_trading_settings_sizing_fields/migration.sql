-- AlterTable: add position-sizing and trend-filter columns to TradingSettings
ALTER TABLE "TradingSettings" ADD COLUMN "placeQtyBasedOnSL" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "TradingSettings" ADD COLUMN "perTradeLoss" REAL NOT NULL DEFAULT 20000;
ALTER TABLE "TradingSettings" ADD COLUMN "perDayLoss" REAL NOT NULL DEFAULT 40000;
ALTER TABLE "TradingSettings" ADD COLUMN "enableNiftyTrendFilter" BOOLEAN NOT NULL DEFAULT 0;

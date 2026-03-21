-- AlterTable
ALTER TABLE "TradingSettings" ADD COLUMN "minSellRsi" REAL NOT NULL DEFAULT 45;
ALTER TABLE "TradingSettings" ADD COLUMN "maxSellRiskPts" REAL NOT NULL DEFAULT 25;

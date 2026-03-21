-- Clear all paper trades
DELETE FROM PaperTrade;

-- Clear all regular trades  
DELETE FROM Trade;

-- Vacuum to reclaim space
VACUUM;

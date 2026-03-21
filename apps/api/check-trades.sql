-- Check counts
SELECT 'PaperTrade count:' as info, COUNT(*) as count FROM PaperTrade
UNION ALL
SELECT 'Trade count:' as info, COUNT(*) as count FROM Trade;

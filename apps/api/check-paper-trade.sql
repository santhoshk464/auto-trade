-- Check the paper trade details from database
SELECT 
  id,
  optionSymbol,
  signalType,
  entryPrice,
  exitPrice,
  stopLoss,
  target1,
  target2,
  target3,
  status,
  pnl,
  entryTime,
  exitTime
FROM PaperTrade
ORDER BY entryTime DESC
LIMIT 5;

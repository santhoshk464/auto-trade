"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import toast from "react-hot-toast";

interface BacktestReport {
  strategy: string;
  symbol: string;
  dateRange: { startDate: string; endDate: string };
  tradingDays: number;
  summary: {
    totalTrades: number;
    targetHits: number;
    slHits: number;
    openTrades: number;
    winRate: number;
    totalProfit: number;
    avgProfitPerTrade: number;
  };
  weeklyBreakdown: Array<{
    week: string;
    trades: number;
    profit: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  monthlyBreakdown: Array<{
    month: string;
    trades: number;
    profit: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
}

interface Broker {
  id: string;
  name: string;
  type: string;
  connectionStatus: string;
}

export default function BacktestPage() {
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [loadingBrokers, setLoadingBrokers] = useState(false);
  const [brokerId, setBrokerId] = useState("");
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([]);
  const [loadingExpiries, setLoadingExpiries] = useState(false);
  const [strategy, setStrategy] = useState("DAY_SELLING");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [interval, setInterval] = useState("5minute");
  const [marginPoints, setMarginPoints] = useState("20");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<BacktestReport | null>(null);

  // Load brokers on mount
  useEffect(() => {
    async function loadBrokers() {
      setLoadingBrokers(true);
      try {
        const res = await apiFetch<{ brokers: Broker[] }>("/brokers");
        setBrokers(res.brokers);
        if (res.brokers.length > 0) {
          setBrokerId(res.brokers[0].id);
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load brokers");
      } finally {
        setLoadingBrokers(false);
      }
    }
    loadBrokers();
  }, []);

  // Load available expiries when symbol changes
  useEffect(() => {
    async function loadExpiries() {
      if (!symbol) return;
      setLoadingExpiries(true);
      try {
        const res = await apiFetch<{ expiries: string[] }>(
          `/kite/available-expiries?symbol=${symbol}`,
        );
        setAvailableExpiries(res.expiries);
        // Auto-select the nearest future expiry
        if (res.expiries.length > 0) {
          const today = new Date().toISOString().split("T")[0];
          const futureExpiries = res.expiries.filter((e) => e >= today);
          if (futureExpiries.length > 0) {
            setExpiry(futureExpiries[0]);
          } else {
            setExpiry(res.expiries[res.expiries.length - 1]);
          }
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load expiry dates");
      } finally {
        setLoadingExpiries(false);
      }
    }
    loadExpiries();
  }, [symbol]);

  const runBacktest = async () => {
    if (!brokerId || !symbol || !expiry || !startDate || !endDate) {
      toast.error("Please fill all required fields");
      return;
    }

    setLoading(true);
    try {
      const result = await apiFetch<BacktestReport>(
        `/kite/strategy-backtest?brokerId=${brokerId}&symbol=${symbol}&expiry=${expiry}&strategy=${strategy}&startDate=${startDate}&endDate=${endDate}&interval=${interval}&marginPoints=${marginPoints}`,
      );
      setReport(result);
      toast.success("Backtest completed successfully!");
    } catch (error: any) {
      toast.error(error.message || "Failed to run backtest");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-6 text-3xl font-bold text-gray-800">
          📊 Strategy Backtesting
        </h1>

        {/* Input Form */}
        <div className="mb-6 rounded-xl border bg-white p-6 shadow-sm">
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Broker
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={brokerId}
                onChange={(e) => setBrokerId(e.target.value)}
                disabled={loadingBrokers}
              >
                {loadingBrokers ? (
                  <option>Loading brokers...</option>
                ) : brokers.length === 0 ? (
                  <option>No brokers found</option>
                ) : (
                  brokers.map((broker) => (
                    <option key={broker.id} value={broker.id}>
                      {broker.name} ({broker.type})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Symbol
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={loadingExpiries}
              >
                <option value="NIFTY">NIFTY</option>
                <option value="BANKNIFTY">BANKNIFTY</option>
                <option value="FINNIFTY">FINNIFTY</option>
                <option value="SENSEX">SENSEX</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Expiry Date
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                disabled={loadingExpiries}
              >
                {loadingExpiries ? (
                  <option>Loading expiries...</option>
                ) : availableExpiries.length === 0 ? (
                  <option>No expiries available</option>
                ) : (
                  availableExpiries.map((exp) => (
                    <option key={exp} value={exp}>
                      {new Date(exp).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Strategy
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
              >
                <option value="DAY_BUYING">Day Buying (Bullish)</option>
                <option value="DAY_SELLING">Day Selling (Bearish)</option>
                <option value="DAY_SELLING_V2">
                  Day Selling V2 (3-Setup Engine)
                </option>
                <option value="DAY_SELLING_V2_ENHANCED">
                  Day Selling V2 Enhanced (V2 + V4 Filters)
                </option>
                <option value="DAY_SELLING_V1V2">
                  Day Selling V1+V2 (Combined)
                </option>
                <option value="DAY_SELLING_V3">
                  Day Selling V3 (4-Engine)
                </option>
                <option value="SMART_SELL">
                  Smart Sell (Advanced - RSI + Volume + Time Filter)
                </option>
                <option value="20_EMA">20 EMA</option>
                <option value="PREV_DAY_HIGH_LOW">Prev Day High/Low</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Interval
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="5minute">5 Minute</option>
                <option value="15minute">15 Minute</option>
                <option value="30minute">30 Minute</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Start Date
              </label>
              <input
                type="date"
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                End Date
              </label>
              <input
                type="date"
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Margin Points
              </label>
              <input
                type="number"
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={marginPoints}
                onChange={(e) => setMarginPoints(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex items-start gap-4">
            <button
              onClick={runBacktest}
              disabled={loading || loadingBrokers || loadingExpiries || !expiry}
              className="rounded-lg bg-blue-600 px-6 py-2 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
            >
              {loading ? "Running Backtest..." : "Run Backtest"}
            </button>
            <div className="flex-1 rounded-lg bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-800">
                ℹ️ Note: Only active expiries are available for backtesting.
              </p>
              <p className="text-amber-700">
                Historical data for expired contracts is not accessible via Kite
                API. Ensure your test date range matches the selected expiry
                period.
              </p>
            </div>
          </div>
        </div>

        {/* Report */}
        {report && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-xl font-bold text-gray-800">
                📈 Summary
              </h2>
              <div className="grid grid-cols-4 gap-4">
                <div className="rounded-lg bg-blue-50 p-4">
                  <p className="text-sm text-gray-600">Total Trades</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {report.summary.totalTrades}
                  </p>
                </div>
                <div className="rounded-lg bg-green-50 p-4">
                  <p className="text-sm text-gray-600">Target Hits</p>
                  <p className="text-2xl font-bold text-green-600">
                    {report.summary.targetHits}
                  </p>
                </div>
                <div className="rounded-lg bg-red-50 p-4">
                  <p className="text-sm text-gray-600">SL Hits</p>
                  <p className="text-2xl font-bold text-red-600">
                    {report.summary.slHits}
                  </p>
                </div>
                <div className="rounded-lg bg-purple-50 p-4">
                  <p className="text-sm text-gray-600">Win Rate</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {report.summary.winRate}%
                  </p>
                </div>
                <div className="rounded-lg bg-yellow-50 p-4">
                  <p className="text-sm text-gray-600">Total P&L</p>
                  <p
                    className={`text-2xl font-bold ${report.summary.totalProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {report.summary.totalProfit >= 0 ? "+" : ""}
                    {report.summary.totalProfit.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-sm text-gray-600">Avg P&L/Trade</p>
                  <p
                    className={`text-2xl font-bold ${report.summary.avgProfitPerTrade >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {report.summary.avgProfitPerTrade >= 0 ? "+" : ""}
                    {report.summary.avgProfitPerTrade.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            {/* Weekly Breakdown */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-xl font-bold text-gray-800">
                📅 Weekly Breakdown
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Week
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Trades
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Wins
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Losses
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Win Rate
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        P&L
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.weeklyBreakdown.map((week) => (
                      <tr key={week.week} className="border-t">
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {week.week}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {week.trades}
                        </td>
                        <td className="px-4 py-2 text-sm text-green-600">
                          {week.wins}
                        </td>
                        <td className="px-4 py-2 text-sm text-red-600">
                          {week.losses}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {week.winRate}%
                        </td>
                        <td
                          className={`px-4 py-2 text-sm font-semibold ${week.profit >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {week.profit >= 0 ? "+" : ""}
                          {week.profit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Monthly Breakdown */}
            <div className="rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-xl font-bold text-gray-800">
                📆 Monthly Breakdown
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Month
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Trades
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Wins
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Losses
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        Win Rate
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700">
                        P&L
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.monthlyBreakdown.map((month) => (
                      <tr key={month.month} className="border-t">
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {month.month}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {month.trades}
                        </td>
                        <td className="px-4 py-2 text-sm text-green-600">
                          {month.wins}
                        </td>
                        <td className="px-4 py-2 text-sm text-red-600">
                          {month.losses}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-800">
                          {month.winRate}%
                        </td>
                        <td
                          className={`px-4 py-2 text-sm font-semibold ${month.profit >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {month.profit >= 0 ? "+" : ""}
                          {month.profit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

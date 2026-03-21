"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import OptionChartModal from "@/components/option-chart-modal";

type OptionData = {
  symbol: string;
  strike: number;
  optionType: "CE" | "PE" | "IDX";
  tradingsymbol: string;
  instrumentToken: number;
  signals: Array<{
    time: string;
    timestamp?: number;
    recommendation: "SELL" | "BUY";
    reason: string;
    price: number;
    stopLoss?: number;
    target1?: number;
    patternName?: string;
    outcome?: "T1" | "T2" | "T3" | "SL" | "BE" | "OPEN";
    pnl?: number;
  }>;
  ltp: number;
};

export default function OptionMonitorPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [brokers, setBrokers] = useState<any[]>([]);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>("");
  const [options, setOptions] = useState<OptionData[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string>("");
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiryDate, setExpiryDate] = useState("");
  const [expiryDates, setExpiryDates] = useState<string[]>([]);
  const [marginPoints, setMarginPoints] = useState(20);
  const [interval, setInterval] = useState("5minute"); // Candle interval
  const [strategy, setStrategy] = useState("DAY_SELLING"); // Trading strategy
  const [targetDate, setTargetDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split("T")[0];
  });
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<OptionData | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [todayStats, setTodayStats] = useState<any>(null);
  const [lockedStrike, setLockedStrike] = useState<{
    locked: boolean;
    instruments: Array<{
      tradingsymbol: string;
      strike: number;
      instrument_type: string;
    }>;
    lockedAgoMinutes?: number;
    nextRefreshInMinutes?: number;
  } | null>(null);
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  });
  const [toDate, setToDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  });
  const [spotRangeResults, setSpotRangeResults] = useState<
    Array<{ date: string; options: OptionData[] }>
  >([]);
  const [spotRangeProgress, setSpotRangeProgress] = useState("");

  const [clearingSignals, setClearingSignals] = useState(false);

  async function clearSignalCache() {
    if (!selectedBrokerId) return;
    setClearingSignals(true);
    try {
      await apiFetch(
        `/kite/signals/today?brokerId=${selectedBrokerId}&strategy=${strategy}`,
        { method: "DELETE" },
      );
      toast.success(
        "Strike cache cleared — next Find Signals will reselect ATM",
      );
    } catch (err: any) {
      toast.error(err?.message || "Failed to clear signal cache");
    } finally {
      setClearingSignals(false);
    }
  }

  // Fetch scheduler-locked strikes whenever broker/strategy changes (for today)
  useEffect(() => {
    if (!selectedBrokerId || !user) return;
    const today = new Date().toISOString().split("T")[0];
    if (targetDate !== today) {
      setLockedStrike(null);
      return;
    }
    apiFetch<any>(
      `/kite/locked-strikes?brokerId=${selectedBrokerId}&strategy=${strategy}`,
    )
      .then(setLockedStrike)
      .catch(() => setLockedStrike(null));
  }, [selectedBrokerId, strategy, targetDate, user]);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  // Load today's trading stats
  useEffect(() => {
    async function loadTodayStats() {
      if (!user) return;
      try {
        const stats = await apiFetch<any>("/paper-trading/today-stats");
        setTodayStats(stats);
      } catch (err: any) {
        console.error("Failed to load today's stats:", err);
      }
    }
    if (!loading && user) {
      loadTodayStats();
      // Refresh stats every 30 seconds
      const interval = setInterval(loadTodayStats, 30000);
      return () => clearInterval(interval);
    }
  }, [loading, user]);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch<{ brokers: any[] }>("/brokers");
        console.log("Brokers loaded:", res.brokers);
        setBrokers(res.brokers);
        if (res.brokers.length > 0) {
          const saved = window.localStorage.getItem("at.selectedBrokerId");
          const initialBrokerId = saved || String(res.brokers[0].id);
          console.log(
            "Setting initial broker ID:",
            initialBrokerId,
            "from saved:",
            saved,
            "or first broker:",
            res.brokers[0].id,
          );
          setSelectedBrokerId(initialBrokerId);
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load brokers");
      }
    }
    if (!loading && user) {
      load();
    }
  }, [loading, user]);

  useEffect(() => {
    async function loadExpiry() {
      if (!symbol) return;
      if (symbol.endsWith("_SPOT")) {
        setExpiryDates([]);
        setExpiryDate("");
        return;
      }
      try {
        // SENSEX trades on BSE, others on NSE
        const exchange = symbol === "SENSEX" ? "BSE" : "NSE";
        const res = await apiFetch<{ expiries: string[] }>(
          `/kite/expiry-dates?exchange=${exchange}&symbol=${symbol}&segment=Options`,
        );
        setExpiryDates(res.expiries || []);
        if (res.expiries && res.expiries.length > 0) {
          setExpiryDate(res.expiries[0]);
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load expiry dates");
      }
    }
    loadExpiry();
  }, [symbol]);

  function getWeekdays(from: string, to: string): string[] {
    const dates: string[] = [];
    const cur = new Date(from);
    const end = new Date(to);
    while (cur <= end) {
      const day = cur.getDay();
      if (day !== 0 && day !== 6) dates.push(cur.toISOString().split("T")[0]);
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  async function loadOptionData() {
    if (
      !selectedBrokerId ||
      !symbol ||
      (!expiryDate && strategy !== "TREND_NIFTY" && !symbol.endsWith("_SPOT"))
    ) {
      const errorMsg = "Please select broker, symbol and expiry";
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    setLoadingOptions(true);
    setError("");
    setOptions([]);
    setSpotRangeResults([]);
    setSpotRangeProgress("");

    try {
      // ── Spot date-range mode ──────────────────────────────────────────────
      if (symbol.endsWith("_SPOT")) {
        const weekdays = getWeekdays(fromDate, toDate);
        if (weekdays.length === 0) {
          toast.error("No trading days in selected range");
          return;
        }
        const rangeResults: Array<{ date: string; options: OptionData[] }> = [];
        for (let di = 0; di < weekdays.length; di++) {
          const date = weekdays[di];
          setSpotRangeProgress(
            `Scanning ${date} (${di + 1}/${weekdays.length})…`,
          );
          try {
            const res = await apiFetch<{ options: OptionData[] }>(
              `/kite/option-monitor?brokerId=${selectedBrokerId}&symbol=${symbol}&expiry=&marginPoints=${marginPoints}&targetDate=${date}&interval=${interval}&time=15:30&strategy=${strategy}`,
            );
            if (res.options && res.options.length > 0) {
              rangeResults.push({ date, options: res.options });
            }
          } catch {
            // skip failed dates silently
          }
        }
        setSpotRangeResults(rangeResults);
        setSpotRangeProgress("");
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      const res = await apiFetch<{ options: OptionData[] }>(
        `/kite/option-monitor?brokerId=${selectedBrokerId}&symbol=${symbol}&expiry=${expiryDate}&marginPoints=${marginPoints}&targetDate=${targetDate}&interval=${interval}&time=15:30&strategy=${strategy}`,
      );
      console.log("API Response:", res);
      console.log("Options count:", res.options?.length || 0);
      setOptions(res.options || []);
      setError("");

      // Reload today's stats after fetching options (auto-trade might have been created)
      const stats = await apiFetch<any>("/paper-trading/today-stats");
      setTodayStats(stats);
    } catch (err: any) {
      const errorMsg = err?.message || "Failed to load option data";
      setError(errorMsg);
      toast.error(errorMsg);
      setOptions([]);
    } finally {
      setLoadingOptions(false);
    }
  }

  if (loading) {
    return <div className="p-6">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between p-4">
          <div className="font-semibold">Trade Finder</div>
          <button
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => router.push("/dashboard")}
          >
            Back to Dashboard
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-6">
        {/* Auto-Trading Status */}
        {todayStats && (
          <div className="mb-6 rounded-xl border bg-white p-4 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  📊 Today's Auto-Trading Status
                </h3>
                <p className="text-sm text-gray-600">
                  Paper trades are automatically created when signals generate
                </p>
              </div>
              <a
                href="/paper-trading"
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                View All Trades
              </a>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-5">
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="text-xs text-gray-600">Active Trades</div>
                <div className="text-2xl font-bold text-blue-600">
                  {todayStats.activeTrades || 0}
                </div>
              </div>
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="text-xs text-gray-600">Total Today</div>
                <div className="text-2xl font-bold text-gray-900">
                  {todayStats.totalTrades || 0}
                </div>
              </div>
              <div
                className={`rounded-lg border p-3 ${(todayStats.todayPnL || 0) >= 0 ? "bg-green-50" : "bg-red-50"}`}
              >
                <div className="text-xs text-gray-600">Today P&L</div>
                <div
                  className={`text-2xl font-bold ${(todayStats.todayPnL || 0) >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  ₹{(todayStats.todayPnL || 0).toFixed(0)}
                </div>
              </div>
              <div className="rounded-lg border bg-gray-50 p-3">
                <div className="text-xs text-gray-600">Closed Trades</div>
                <div className="text-2xl font-bold text-gray-900">
                  {todayStats.closedTrades || 0}
                </div>
              </div>
              <div
                className={`rounded-lg border p-3 ${todayStats.targetHit ? "bg-yellow-50" : "bg-green-50"}`}
              >
                <div className="text-xs text-gray-600">Trading Status</div>
                <div
                  className={`text-sm font-bold ${todayStats.targetHit ? "text-yellow-600" : "text-green-600"}`}
                >
                  {todayStats.targetHit ? "🛑 Stopped" : "✅ Active"}
                </div>
                {todayStats.targetHit && (
                  <div className="text-xs text-yellow-600 mt-1">
                    Target hit - Discipline mode
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Strategy Indicator */}
        <div className="mb-6 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-blue-100">
                Active Trading Strategy
              </p>
              <h2 className="mt-1 text-2xl font-bold text-white">
                {strategy === "DAY_BUYING"
                  ? "📈 Day Buying (Bullish Patterns)"
                  : strategy === "TREND_NIFTY"
                    ? "🔍 Find Trend On Nifty (SuperTrend + VWAP)"
                    : strategy === "DAY_SELLING_V4"
                      ? "📉 Day Selling V4 (6-Setup Option Engine)"
                      : strategy === "DAY_HIGH_REJECTION"
                        ? "📉 Day High Rejection (Sell)"
                        : strategy === "DAY_LOW_BREAK"
                          ? "📉 Day Low Break (Sell)"
                          : strategy === "EMA_REJECTION"
                            ? "📉 EMA Rejection (Sell)"
                            : "📉 Day Selling (Bearish Patterns)"}
              </h2>
            </div>
            <div className="rounded-lg bg-white/20 px-4 py-2 backdrop-blur-sm">
              <p className="text-xs font-medium text-blue-100">Strategy Code</p>
              <p className="text-sm font-bold text-white">{strategy}</p>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="rounded-xl border bg-white p-6">
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Broker
              </label>
              <select
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={selectedBrokerId}
                onChange={(e) => {
                  const brokerId = e.target.value;
                  console.log("Broker selection changed to:", brokerId);
                  setSelectedBrokerId(brokerId);
                  if (brokerId) {
                    window.localStorage.setItem(
                      "at.selectedBrokerId",
                      brokerId,
                    );
                  }
                }}
              >
                {brokers.length === 0 && (
                  <option value="">Loading brokers...</option>
                )}
                {brokers.length > 0 && !selectedBrokerId && (
                  <option value="">Select a broker</option>
                )}
                {brokers.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
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
              >
                <option value="NIFTY">NIFTY</option>
                <option value="BANKNIFTY">BANKNIFTY</option>
                <option value="FINNIFTY">FINNIFTY</option>
                <option value="MIDCPNIFTY">MIDCPNIFTY</option>
                <option value="SENSEX">SENSEX</option>
                <optgroup label="Spot Index (historical testing)">
                  <option value="NIFTY_SPOT">NIFTY Spot (Index)</option>
                  <option value="BANKNIFTY_SPOT">BANKNIFTY Spot (Index)</option>
                </optgroup>
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
                <option value="DAY_BUYING">
                  Day Buying (Bullish Patterns)
                </option>
                <option value="DAY_SELLING">
                  Day Selling (Bearish Patterns)
                </option>
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
                <option value="DAY_SELLING_V4">
                  Day Selling V4 (6-Setup Option Engine)
                </option>
                <option value="TREND_NIFTY">
                  Find Trend On Nifty (SuperTrend + VWAP)
                </option>
                <option value="DAY_HIGH_REJECTION">
                  Day High Rejection (Sell)
                </option>
                <option value="DAY_LOW_BREAK">Day Low Break (Sell)</option>
                <option value="EMA_REJECTION">EMA Rejection (Sell)</option>
              </select>
            </div>

            {strategy !== "TREND_NIFTY" && !symbol.endsWith("_SPOT") && (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Expiry Date
                </label>
                <select
                  className="mt-1 w-full rounded-md border px-3 py-2"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                >
                  {expiryDates.map((exp) => (
                    <option key={exp} value={exp}>
                      {exp}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {symbol.endsWith("_SPOT") ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    From Date
                  </label>
                  <input
                    type="date"
                    className="mt-1 w-full rounded-md border px-3 py-2"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    To Date
                  </label>
                  <input
                    type="date"
                    className="mt-1 w-full rounded-md border px-3 py-2"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Weekends are skipped automatically
                  </p>
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Target Date
                </label>
                <input
                  type="date"
                  className="mt-1 w-full rounded-md border px-3 py-2"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
                <p className="mt-1 text-xs text-gray-500">
                  Select a recent weekday with full market data. Avoid today if
                  market is still open or hasn't started.
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Margin Points
              </label>
              <input
                type="number"
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={marginPoints}
                onChange={(e) => setMarginPoints(Number(e.target.value))}
                min="5"
                max="50"
                step="5"
              />
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
                <option value="minute">1 Min</option>
                <option value="5minute">5 Min</option>
                <option value="15minute">15 Min</option>
                <option value="30minute">30 Min</option>
                <option value="60minute">1 Hour</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Shows all rejection signals for the selected interval
              </p>
            </div>

            <div className="flex items-end gap-2">
              <button
                className="flex-1 rounded-md bg-black px-4 py-2 text-white disabled:opacity-50"
                onClick={loadOptionData}
                disabled={loadingOptions}
              >
                {loadingOptions ? "Loading..." : "Find Signals"}
              </button>
              <button
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                onClick={clearSignalCache}
                disabled={clearingSignals || loadingOptions}
                title="Clear today's saved strike cache so the next search reselects ATM"
              >
                {clearingSignals ? "Clearing..." : "Clear Cache"}
              </button>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && !loadingOptions && (
          <div className="mt-6 rounded-xl border-2 border-red-300 bg-red-50 p-6">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg
                  className="h-6 w-6 text-red-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-semibold text-red-800">Error</h3>
                <p className="mt-1 text-sm text-red-700">{error}</p>
                {error.includes("Authentication failed") ||
                error.includes("Access token missing") ? (
                  <button
                    className="mt-3 rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
                    onClick={() => router.push("/dashboard")}
                  >
                    Go to Dashboard to Reconnect Broker
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Progress indicator for spot range scan */}
        {loadingOptions && spotRangeProgress && (
          <div className="mt-6 rounded-xl border bg-white p-4 text-center text-sm text-gray-600">
            <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-black border-t-transparent" />
            {spotRangeProgress}
          </div>
        )}

        {/* Spot date-range results */}
        {spotRangeResults.length > 0 && !error && (
          <div className="mt-6">
            <h2 className="mb-4 text-2xl font-bold text-gray-800">
              Signals Found:{" "}
              {spotRangeResults.reduce(
                (s, d) =>
                  s + d.options.reduce((ss, o) => ss + o.signals.length, 0),
                0,
              )}{" "}
              signals across {spotRangeResults.length} day(s)
            </h2>

            {/* Pattern stats summary */}
            {(() => {
              const stats: Record<
                string,
                {
                  total: number;
                  t1: number;
                  t2: number;
                  t3: number;
                  sl: number;
                  be: number;
                  open: number;
                  totalPnl: number;
                }
              > = {};
              spotRangeResults.forEach(({ options: dayOpts }) =>
                dayOpts.forEach((opt) =>
                  opt.signals.forEach((sig) => {
                    const p = sig.patternName ?? sig.reason.split(" (Risk")[0];
                    if (!stats[p])
                      stats[p] = {
                        total: 0,
                        t1: 0,
                        t2: 0,
                        t3: 0,
                        sl: 0,
                        be: 0,
                        open: 0,
                        totalPnl: 0,
                      };
                    stats[p].total++;
                    if (sig.outcome === "T1") stats[p].t1++;
                    else if (sig.outcome === "T2") stats[p].t2++;
                    else if (sig.outcome === "T3") stats[p].t3++;
                    else if (sig.outcome === "SL") stats[p].sl++;
                    else if (sig.outcome === "BE") stats[p].be++;
                    else stats[p].open++;
                    if (sig.pnl != null) stats[p].totalPnl += sig.pnl;
                  }),
                ),
              );
              const rows = Object.entries(stats);
              if (rows.length === 0) return null;
              return (
                <div className="mb-5 overflow-x-auto rounded-xl border bg-white shadow">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50 text-left">
                        <th className="px-4 py-2 font-semibold text-gray-700">
                          Pattern
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">
                          Total
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-green-700">
                          T1
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-green-700">
                          T2
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-green-700">
                          T3
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-red-700">
                          SL
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-amber-600">
                          BE
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-500">
                          Open
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">
                          Win%
                        </th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">
                          P&amp;L
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map(([pattern, s]) => {
                        const winCount = s.t1 + s.t2 + s.t3;
                        const closed = winCount + s.sl; // BE excluded from Win% (break-even = neutral)
                        const winPct =
                          closed > 0
                            ? Math.round((winCount / closed) * 100)
                            : null;
                        return (
                          <tr key={pattern} className="hover:bg-gray-50">
                            <td className="px-4 py-2 font-medium text-gray-800">
                              {pattern}
                            </td>
                            <td className="px-4 py-2 text-center text-gray-700">
                              {s.total}
                            </td>
                            <td className="px-4 py-2 text-center text-green-700">
                              {s.t1 || "-"}
                            </td>
                            <td className="px-4 py-2 text-center text-green-700">
                              {s.t2 || "-"}
                            </td>
                            <td className="px-4 py-2 text-center text-green-700">
                              {s.t3 || "-"}
                            </td>
                            <td className="px-4 py-2 text-center text-red-700">
                              {s.sl || "-"}
                            </td>
                            <td className="px-4 py-2 text-center text-amber-600">
                              {s.be || "-"}
                            </td>
                            <td className="px-4 py-2 text-center text-gray-400">
                              {s.open || "-"}
                            </td>
                            <td className="px-4 py-2 text-center">
                              {winPct !== null ? (
                                <span
                                  className={`font-bold ${
                                    winPct >= 60
                                      ? "text-green-700"
                                      : winPct >= 40
                                        ? "text-amber-600"
                                        : "text-red-700"
                                  }`}
                                >
                                  {winPct}%
                                </span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-center">
                              <span
                                className={`font-bold ${
                                  s.totalPnl > 0
                                    ? "text-green-700"
                                    : s.totalPnl < 0
                                      ? "text-red-700"
                                      : "text-gray-500"
                                }`}
                              >
                                {s.totalPnl !== 0
                                  ? `₹${s.totalPnl.toLocaleString("en-IN")}`
                                  : "—"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 bg-gray-50 font-semibold">
                        <td className="px-4 py-2 text-gray-700">Total</td>
                        <td className="px-4 py-2 text-center text-gray-700">
                          {rows.reduce((s, [, r]) => s + r.total, 0)}
                        </td>
                        <td className="px-4 py-2 text-center text-green-700">
                          {rows.reduce((s, [, r]) => s + r.t1, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center text-green-700">
                          {rows.reduce((s, [, r]) => s + r.t2, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center text-green-700">
                          {rows.reduce((s, [, r]) => s + r.t3, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center text-red-700">
                          {rows.reduce((s, [, r]) => s + r.sl, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center text-amber-600">
                          {rows.reduce((s, [, r]) => s + r.be, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center text-gray-400">
                          {rows.reduce((s, [, r]) => s + r.open, 0) || "-"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {(() => {
                            const wins = rows.reduce(
                              (s, [, r]) => s + r.t1 + r.t2 + r.t3,
                              0,
                            );
                            const losses = rows.reduce(
                              (s, [, r]) => s + r.sl,
                              0,
                            );
                            const pct =
                              wins + losses > 0
                                ? Math.round((wins / (wins + losses)) * 100)
                                : null;
                            return pct !== null ? (
                              <span
                                className={`font-bold ${pct >= 60 ? "text-green-700" : pct >= 40 ? "text-amber-600" : "text-red-700"}`}
                              >
                                {pct}%
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {(() => {
                            const total = rows.reduce(
                              (s, [, r]) => s + r.totalPnl,
                              0,
                            );
                            return (
                              <span
                                className={`font-bold ${total > 0 ? "text-green-700" : total < 0 ? "text-red-700" : "text-gray-500"}`}
                              >
                                {total !== 0
                                  ? `₹${total.toLocaleString("en-IN")}`
                                  : "—"}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}
            <div className="space-y-3">
              {spotRangeResults.map(({ date, options: dayOptions }) => (
                <div
                  key={date}
                  className="overflow-hidden rounded-xl border bg-white shadow"
                >
                  <div className="flex items-center gap-3 border-b bg-gray-50 px-5 py-3">
                    <span className="font-semibold text-gray-800">
                      {new Date(date + "T00:00:00").toLocaleDateString(
                        "en-IN",
                        {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        },
                      )}
                    </span>
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                      {dayOptions.reduce((s, o) => s + o.signals.length, 0)}{" "}
                      signal(s)
                    </span>
                  </div>
                  <div className="px-5 py-4">
                    {dayOptions.map((opt, oi) => (
                      <div key={oi} className="flex flex-wrap gap-2">
                        {opt.signals.map((signal, si) => (
                          <div
                            key={si}
                            className="flex flex-col rounded-lg border border-gray-200 bg-white p-3 shadow-sm cursor-pointer hover:shadow-md hover:border-blue-300 transition-shadow"
                            onClick={() => {
                              setSelectedOption(opt);
                              setSelectedDate(date);
                              setIsChartOpen(true);
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                                  signal.recommendation === "BUY"
                                    ? "bg-green-100 text-green-800"
                                    : "bg-red-100 text-red-800"
                                }`}
                              >
                                {signal.recommendation}
                              </span>
                              <span className="text-xs font-semibold text-gray-700">
                                {signal.time}
                              </span>
                              {signal.outcome && (
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${
                                    signal.outcome === "SL"
                                      ? "bg-red-100 text-red-700"
                                      : signal.outcome === "OPEN"
                                        ? "bg-gray-100 text-gray-600"
                                        : signal.outcome === "BE"
                                          ? "bg-amber-100 text-amber-700"
                                          : "bg-green-100 text-green-700"
                                  }`}
                                >
                                  {signal.outcome === "SL"
                                    ? "SL ✗"
                                    : signal.outcome === "OPEN"
                                      ? "EOD"
                                      : signal.outcome === "BE"
                                        ? "BE ↔"
                                        : `${signal.outcome} ✓`}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-xs text-gray-600">
                              {signal.reason}
                            </div>
                            <div className="mt-1 text-xs text-gray-500">
                              @ ₹{signal.price.toFixed(2)}
                            </div>
                            {signal.pnl != null && (
                              <div
                                className={`mt-1 text-xs font-semibold ${
                                  signal.pnl > 0
                                    ? "text-green-700"
                                    : signal.pnl < 0
                                      ? "text-red-700"
                                      : "text-gray-500"
                                }`}
                              >
                                P&amp;L: ₹{signal.pnl.toLocaleString("en-IN")}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Options Table */}
        {options.length > 0 && !error && (
          <div className="mt-6">
            {/* Locked-strike info banner */}
            {lockedStrike?.locked && (
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm">
                <span className="text-lg">🔒</span>
                <div>
                  <span className="font-semibold text-amber-800">
                    Auto-trade is monitoring:{" "}
                  </span>
                  <span className="font-mono text-amber-900">
                    {lockedStrike.instruments
                      .map((i) => i.tradingsymbol)
                      .join(" & ")}
                  </span>
                  <span className="ml-2 text-amber-600">
                    (locked {lockedStrike.lockedAgoMinutes}min ago · refreshes
                    in ~{lockedStrike.nextRefreshInMinutes}min)
                  </span>
                  <span className="ml-2 text-amber-700">
                    — Trade Finder results below use this same strike.
                  </span>
                </div>
              </div>
            )}
            {(() => {
              const optionsWithSignals = options.filter(
                (opt) => opt.signals && opt.signals.length > 0,
              );
              const totalSignals = optionsWithSignals.reduce(
                (sum, opt) => sum + (opt.signals?.length || 0),
                0,
              );

              if (optionsWithSignals.length === 0) {
                return (
                  <div className="rounded-xl border bg-white p-12 text-center">
                    <p className="text-lg font-semibold text-gray-700 mb-3">
                      {strategy === "DAY_BUYING"
                        ? "No buy signals found for the selected criteria"
                        : "No rejection signals found for the selected criteria"}
                    </p>
                    <div className="text-sm text-gray-600 space-y-2">
                      {strategy === "SMART_SELL" ? (
                        <>
                          <p>
                            <strong>SMART_SELL</strong> uses strict filters to
                            reduce false signals:
                          </p>
                          <ul className="text-left max-w-2xl mx-auto list-disc list-inside space-y-1">
                            <li>RSI must be &gt; 60 (overbought)</li>
                            <li>Only trades between 10:30 AM - 2:30 PM</li>
                            <li>Requires volume &gt; 1.2x average</li>
                            <li>Needs 2+ pattern confirmations</li>
                          </ul>
                          <p className="mt-3">
                            Try: Different date, DAY_SELLING strategy, or 5-min
                            interval
                          </p>
                        </>
                      ) : strategy === "DAY_BUYING" ? (
                        <>
                          <p>
                            <strong>DAY_BUYING</strong> shows BUY signals with
                            two scenarios:
                          </p>
                          <ul className="text-left max-w-2xl mx-auto list-disc list-inside space-y-1">
                            <li>
                              <strong>Scenario 1:</strong> Any green candle when
                              RSI &lt; 40 (oversold bounce)
                            </li>
                            <li>
                              <strong>Scenario 2:</strong> Candle crosses from
                              below to above 20 EMA when RSI &lt; 60 (breakout)
                            </li>
                            <li>Only trades between 9:30 AM - 2:30 PM</li>
                          </ul>
                          <p className="mt-3">
                            Scenario 1 captures oversold reversals, Scenario 2
                            captures EMA breakouts
                          </p>
                        </>
                      ) : (
                        <p>
                          Try adjusting the margin points, interval, or select a
                          different date.
                        </p>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <>
                  <h2 className="mb-4 text-2xl font-bold text-gray-800">
                    {strategy === "DAY_BUYING" ? "Buy" : "Rejection"} Signals
                    Found: {optionsWithSignals.length} Options ({totalSignals}{" "}
                    total signals)
                  </h2>

                  <div className="overflow-x-auto rounded-xl border bg-white shadow-lg">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b bg-gray-50">
                          <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">
                            Strike
                          </th>
                          <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">
                            Type
                          </th>
                          <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">
                            LTP
                          </th>
                          <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700">
                            Signals
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {optionsWithSignals.map((option, idx) => (
                          <tr
                            key={idx}
                            className="hover:bg-blue-50 transition-colors cursor-pointer"
                            onClick={() => {
                              console.log("Option row clicked:", option);
                              console.log(
                                "Selected broker ID:",
                                selectedBrokerId,
                              );

                              if (
                                !selectedBrokerId ||
                                selectedBrokerId === ""
                              ) {
                                toast.error(
                                  "Please select a broker from the dropdown above",
                                );
                                return;
                              }

                              console.log("Opening chart for:", {
                                tradingsymbol: option.tradingsymbol,
                                instrumentToken: option.instrumentToken,
                                brokerId: selectedBrokerId,
                              });

                              setSelectedOption(option);
                              setSelectedDate(targetDate);
                              setIsChartOpen(true);
                            }}
                          >
                            <td className="px-6 py-4">
                              <div className="font-semibold text-gray-900">
                                {option.strike > 0
                                  ? `${option.symbol} ${option.strike}`
                                  : option.symbol}
                              </div>
                              <div className="text-xs text-gray-500">
                                {option.tradingsymbol}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span
                                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                                  option.optionType === "CE"
                                    ? "bg-blue-100 text-blue-800"
                                    : option.optionType === "IDX"
                                      ? "bg-green-100 text-green-800"
                                      : "bg-purple-100 text-purple-800"
                                }`}
                              >
                                {option.optionType === "IDX"
                                  ? "SPOT"
                                  : option.optionType}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="font-medium text-gray-900">
                                ₹{option.ltp.toFixed(2)}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-wrap gap-2">
                                {option.signals && option.signals.length > 0 ? (
                                  option.signals.map((signal, signalIdx) => (
                                    <div
                                      key={signalIdx}
                                      className="flex flex-col rounded-lg border border-gray-200 bg-white p-3 shadow-sm hover:shadow-md transition-shadow"
                                    >
                                      <div className="flex items-center gap-2">
                                        <span
                                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                                            signal.recommendation === "BUY"
                                              ? "bg-green-100 text-green-800"
                                              : "bg-red-100 text-red-800"
                                          }`}
                                        >
                                          {signal.recommendation}
                                        </span>
                                        <span className="text-xs font-semibold text-gray-700">
                                          {signal.time}
                                        </span>
                                        {signal.outcome && (
                                          <span
                                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${
                                              signal.outcome === "SL"
                                                ? "bg-red-100 text-red-700"
                                                : signal.outcome === "OPEN"
                                                  ? "bg-gray-100 text-gray-600"
                                                  : signal.outcome === "BE"
                                                    ? "bg-amber-100 text-amber-700"
                                                    : "bg-green-100 text-green-700"
                                            }`}
                                          >
                                            {signal.outcome === "SL"
                                              ? "SL ✗"
                                              : signal.outcome === "OPEN"
                                                ? "EOD"
                                                : signal.outcome === "BE"
                                                  ? "BE ↔"
                                                  : `${signal.outcome} ✓`}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-1 text-xs text-gray-600">
                                        {signal.reason}
                                      </div>
                                      <div className="mt-1 text-xs text-gray-500">
                                        @ ₹{signal.price.toFixed(2)}
                                      </div>
                                      {signal.pnl != null && (
                                        <div
                                          className={`mt-1 text-xs font-semibold ${
                                            signal.pnl > 0
                                              ? "text-green-700"
                                              : signal.pnl < 0
                                                ? "text-red-700"
                                                : "text-gray-500"
                                          }`}
                                        >
                                          P&amp;L: ₹
                                          {signal.pnl.toLocaleString("en-IN")}
                                        </div>
                                      )}
                                      {signal.recommendation === "SELL" && (
                                        <div className="mt-2 text-xs font-medium text-blue-600">
                                          Auto-traded when signal generated
                                        </div>
                                      )}
                                      {signal.recommendation === "BUY" && (
                                        <div className="mt-2 text-xs font-medium text-green-600">
                                          Complementary buy entry
                                        </div>
                                      )}
                                    </div>
                                  ))
                                ) : (
                                  <span className="text-xs text-gray-500">
                                    No signals
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {!loadingOptions && options.length === 0 && !error && (
          <div className="mt-6 rounded-xl border bg-white p-12 text-center text-gray-500">
            Click "Get Options" to find options data
          </div>
        )}
      </main>

      {/* Chart Modal */}
      {selectedOption && selectedBrokerId && selectedBrokerId.trim() !== "" && (
        <OptionChartModal
          key={`${selectedOption.instrumentToken}-${strategy}-${marginPoints}-${interval}-${selectedDate || targetDate}`}
          isOpen={isChartOpen}
          onClose={() => {
            setIsChartOpen(false);
            setSelectedOption(null);
            setSelectedDate("");
          }}
          brokerId={selectedBrokerId}
          instrumentToken={selectedOption.instrumentToken}
          tradingsymbol={selectedOption.tradingsymbol}
          targetDate={selectedDate || targetDate}
          interval={interval}
          strategy={strategy}
          marginPoints={marginPoints}
          overrideSignals={selectedOption.signals
            .filter((s) => s.timestamp != null)
            .map((s) => ({
              time: s.timestamp!,
              type: s.recommendation,
              price: s.price,
              stopLoss: s.stopLoss ?? s.price,
              target: s.target1 ?? s.price,
              text: s.recommendation,
            }))}
        />
      )}
    </div>
  );
}

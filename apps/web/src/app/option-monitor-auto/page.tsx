"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import toast from "react-hot-toast";

const STRATEGY = "DAY_SELLING";

interface Signal {
  id: string;
  symbol: string;
  optionSymbol: string;
  strike: number;
  optionType: string;
  signalType: "BUY" | "SELL";
  strategy: string;
  signalReason: string;
  signalTime: string;
  signalDate: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  ltp?: number;
  tradeCreated: boolean;
  paperTradeStatus?: string | null;
  paperTradePnl?: number | null;
  paperTradeExitTime?: string | null;
  createdAt: string;
  broker?: {
    name: string;
    type: string;
  };
}

interface SignalStats {
  total: number;
  buy: number;
  sell: number;
  traded: number;
  active: number;
  closed: number;
  pending: number;
  byStrategy: Array<{ strategy: string; count: number }>;
}

export default function OptionMonitorAutoPage() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [stats, setStats] = useState<SignalStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<any>(null);
  const [showBrokerAlert, setShowBrokerAlert] = useState(true);
  const [fixingUnlinked, setFixingUnlinked] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Fetch signals for active tab
  const fetchSignals = async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      const today = new Date().toISOString().split("T")[0];
      const response: any = await apiFetch(
        `/signals?strategy=${STRATEGY}&date=${today}&limit=50`,
      );
      setSignals(response.signals || []);
      setLastUpdated(new Date());
    } catch (error: any) {
      console.error("Failed to fetch signals:", error);
      if (!silent) {
        toast.error(error.message || "Failed to load signals");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Fetch statistics
  const fetchStats = async () => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const response: any = await apiFetch(`/signals/stats?date=${today}`);
      setStats(response);
    } catch (error: any) {
      console.error("Failed to fetch stats:", error);
    }
  };

  // Check broker status
  const checkBrokerStatus = async () => {
    try {
      const response: any = await apiFetch("/brokers/status");
      setBrokerStatus(response);

      // Show toast notification if tokens are expired (only once on load)
      if (response.hasExpiredTokens && showBrokerAlert) {
        toast.error(
          "Your broker access token has expired! Please reconnect your broker.",
          { duration: 6000 },
        );
      } else if (response.hasNoBrokers && showBrokerAlert) {
        toast.error("No brokers configured. Please add a broker first.", {
          duration: 5000,
        });
      }
    } catch (error: any) {
      console.error("Failed to check broker status:", error);
    }
  };

  // Clear today's signals
  const clearTodaySignals = async () => {
    if (
      !window.confirm("Delete ALL of today's signals? This cannot be undone.")
    )
      return;

    try {
      setClearing(true);
      const response: any = await apiFetch("/signals/today", {
        method: "DELETE",
      });
      toast.success(`Cleared ${response.deleted} signal(s) for today.`);
      setSignals([]);
      setStats(null);
      await fetchStats();
    } catch (error: any) {
      console.error("Failed to clear signals:", error);
      toast.error(error.message || "Failed to clear signals");
    } finally {
      setClearing(false);
    }
  };

  // Fix unlinked signals
  const fixUnlinkedSignals = async () => {
    try {
      setFixingUnlinked(true);
      const response: any = await apiFetch("/signals/fix-unlinked", {
        method: "POST",
      });

      if (response.success) {
        toast.success(`Fixed ${response.fixedCount} unlinked signal(s)!`, {
          duration: 3000,
        });
        // Refresh data after fixing
        await fetchSignals(false);
        await fetchStats();
      } else {
        toast.error("Failed to fix unlinked signals");
      }
    } catch (error: any) {
      console.error("Failed to fix unlinked signals:", error);
      toast.error(error.message || "Failed to fix unlinked signals");
    } finally {
      setFixingUnlinked(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchSignals();
    fetchStats();
    checkBrokerStatus();
  }, []);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchSignals(true); // Silent refresh (no loading spinner)
      fetchStats();
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, [autoRefresh]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  };

  const getRiskReward = (signal: Signal) => {
    const risk = Math.abs(signal.stopLoss - signal.entryPrice);
    const reward1 = Math.abs(signal.target1 - signal.entryPrice);
    const reward2 = Math.abs(signal.target2 - signal.entryPrice);
    const reward3 = Math.abs(signal.target3 - signal.entryPrice);

    return {
      risk: risk.toFixed(2),
      t1: `1:${(reward1 / risk).toFixed(1)}`,
      t2: `1:${(reward2 / risk).toFixed(1)}`,
      t3: `1:${(reward3 / risk).toFixed(1)}`,
    };
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Auto Trade Finder
              </h1>
              <p className="text-gray-600">
                Live signals from automated strategy analysis
              </p>
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={clearTodaySignals}
                disabled={clearing}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Delete all of today's signals"
              >
                <svg
                  className={`w-4 h-4 ${clearing ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                {clearing ? "Clearing..." : "Clear Today"}
              </button>
              <button
                onClick={fixUnlinkedSignals}
                disabled={fixingUnlinked}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Link paper trades with their corresponding signals"
              >
                <svg
                  className={`w-4 h-4 ${fixingUnlinked ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                </svg>
                {fixingUnlinked ? "Fixing..." : "Fix Unlinked"}
              </button>
              <button
                onClick={() => {
                  fetchSignals(false); // Force refresh with loading
                  fetchStats();
                }}
                disabled={loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                {loading ? "Refreshing..." : "Refresh"}
              </button>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">
                  Auto-refresh (30s)
                </span>
              </label>
              {refreshing && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <svg
                    className="w-4 h-4 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <span>Updating...</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Broker Status Alert */}
        {brokerStatus &&
          (brokerStatus.hasExpiredTokens || brokerStatus.hasNoBrokers) &&
          showBrokerAlert && (
            <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-lg shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0">
                    <svg
                      className="w-6 h-6 text-red-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-red-800 mb-1">
                      {brokerStatus.hasExpiredTokens
                        ? "Broker Access Token Expired"
                        : "No Brokers Configured"}
                    </h3>
                    <p className="text-sm text-red-700 mb-3">
                      {brokerStatus.message}
                    </p>
                    <a
                      href="/brokers"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      {brokerStatus.hasExpiredTokens
                        ? "Reconnect Broker"
                        : "Add Broker"}
                    </a>
                  </div>
                </div>
                <button
                  onClick={() => setShowBrokerAlert(false)}
                  className="text-red-500 hover:text-red-700 transition-colors"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
          )}

        {/* Statistics Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-gray-600 mb-1">
                Total Signals
              </div>
              <div className="text-3xl font-bold text-gray-900">
                {stats.total}
              </div>
            </div>
            <div className="bg-green-50 rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-green-700 mb-1">
                BUY Signals
              </div>
              <div className="text-3xl font-bold text-green-600">
                {stats.buy}
              </div>
            </div>
            <div className="bg-red-50 rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-red-700 mb-1">
                SELL Signals
              </div>
              <div className="text-3xl font-bold text-red-600">
                {stats.sell}
              </div>
            </div>
            <div className="bg-emerald-50 rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-emerald-700 mb-1">
                Active Trades
              </div>
              <div className="text-3xl font-bold text-emerald-600">
                {stats.active}
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-slate-700 mb-1">
                Closed Trades
              </div>
              <div className="text-3xl font-bold text-slate-600">
                {stats.closed}
              </div>
            </div>
            <div className="bg-yellow-50 rounded-xl shadow-sm p-6">
              <div className="text-sm font-medium text-yellow-700 mb-1">
                Pending
              </div>
              <div className="text-3xl font-bold text-yellow-600">
                {stats.pending}
              </div>
            </div>
          </div>
        )}

        {/* Signals Table */}
        <div className="bg-white rounded-xl shadow-lg mb-6">
          <div className="px-6 pt-5 pb-2 flex items-center gap-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-blue-700 bg-blue-50 px-3 py-1 rounded-full">
              DAY_SELLING
            </span>
            <span className="text-sm text-gray-500">
              Day Selling — Bearish Patterns
            </span>
          </div>
          <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
              </div>
            ) : signals.length === 0 ? (
              <div className="text-center py-12">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">
                  No signals yet
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Signals will appear here as they are generated during market
                  hours.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Time
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Option
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Signal
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Reason
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Entry
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        SL
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        T1
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        T2
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        T3
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Risk:Reward
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {signals.map((signal) => {
                      const rr = getRiskReward(signal);
                      return (
                        <tr key={signal.id} className="hover:bg-gray-50">
                          <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            <div className="font-medium">
                              {new Date(signal.createdAt).toLocaleTimeString(
                                "en-IN",
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  hour12: true,
                                },
                              )}
                            </div>
                            <div className="text-xs text-gray-500">
                              {new Date(signal.signalDate).toLocaleDateString(
                                "en-IN",
                              )}
                            </div>
                            <div className="text-xs text-gray-400">
                              Pattern: {signal.signalTime}
                            </div>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium text-gray-900">
                              {signal.optionSymbol}
                            </div>
                            <div className="text-xs text-gray-500">
                              {signal.strike} {signal.optionType}
                            </div>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                signal.signalType === "BUY"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-red-100 text-red-800"
                              }`}
                            >
                              {signal.signalType}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-sm text-gray-600 max-w-xs truncate">
                            {signal.signalReason}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                            {signal.entryPrice.toFixed(2)}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-red-600">
                            {signal.stopLoss.toFixed(2)}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-green-600">
                            {signal.target1.toFixed(2)}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-green-600">
                            {signal.target2.toFixed(2)}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-right text-sm text-green-600">
                            {signal.target3.toFixed(2)}
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-center text-xs">
                            <div className="font-medium text-gray-900">
                              Risk: {rr.risk}
                            </div>
                            <div className="text-gray-600">
                              {rr.t1} | {rr.t2} | {rr.t3}
                            </div>
                          </td>
                          <td className="px-4 py-4 whitespace-nowrap text-center">
                            {signal.tradeCreated ? (
                              signal.paperTradeStatus === "ACTIVE" ? (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  Active Trade
                                </span>
                              ) : signal.paperTradeStatus?.startsWith(
                                  "CLOSED",
                                ) ? (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                                  Closed
                                  {signal.paperTradePnl !== null &&
                                    signal.paperTradePnl !== undefined && (
                                      <span
                                        className={`ml-1 ${signal.paperTradePnl >= 0 ? "text-green-700" : "text-red-700"}`}
                                      >
                                        ({signal.paperTradePnl >= 0 ? "+" : ""}
                                        {signal.paperTradePnl.toFixed(2)})
                                      </span>
                                    )}
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                  Traded
                                </span>
                              )
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                Pending
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <span>Active Trade</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-500"></div>
                <span>Closed Trade</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <span>Awaiting Trade</span>
              </div>
            </div>
            <div className="text-xs text-gray-600">
              Last updated:{" "}
              {lastUpdated
                ? lastUpdated.toLocaleTimeString("en-IN")
                : "Loading..."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

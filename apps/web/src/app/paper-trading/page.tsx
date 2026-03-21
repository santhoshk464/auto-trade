"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { io, Socket } from "socket.io-client";

type PaperTrade = {
  id: string;
  symbol: string;
  optionSymbol: string;
  strike: number;
  optionType: string;
  signalType: string;
  strategy: string;
  signalReason: string | null;
  entryPrice: number;
  entryTime: string;
  exitPrice: number | null;
  exitTime: string | null;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  status: string;
  pnl: number;
  pnlPercentage: number;
  quantity: number;
  instrumentToken: number;
  brokerId: string;
};

type PnLStats = {
  totalTrades: number;
  activeTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
};

export default function PaperTradingPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<PnLStats | null>(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly" | "all">(
    "all",
  );
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [ltpData, setLtpData] = useState<Record<string, number>>({});
  const [loadingLtp, setLoadingLtp] = useState(false);
  const [autoRefreshLtp, setAutoRefreshLtp] = useState(false);

  // Lot-size units per symbol (can be overridden by Settings paperLots)
  const LOT_SIZES: Record<string, number> = {
    NIFTY: 65,
    BANKNIFTY: 30,
    FINNIFTY: 65,
    SENSEX: 20,
  };
  // paperLots per symbol from settings (default 1 until loaded)
  const [paperLots, setPaperLotsMap] = useState<Record<string, number>>({});

  // Load paperLots from settings
  useEffect(() => {
    if (!user) return;
    apiFetch<Array<{ symbol: string; paperLots?: number }>>("/settings/trading")
      .then((rows) => {
        const m: Record<string, number> = {};
        rows.forEach((r) => {
          m[r.symbol] = r.paperLots ?? 1;
        });
        setPaperLotsMap(m);
      })
      .catch(() => {
        /* silently fall back to 1 lot */
      });
  }, [user]);

  /** Total lot-units for a trade: paperLots setting × per-lot qty for that symbol */
  function tradeUnits(trade: PaperTrade): number {
    const sym = trade.symbol?.toUpperCase() ?? "NIFTY";
    const lots = paperLots[sym] ?? 1;
    const unitSize = LOT_SIZES[sym] ?? 1;
    return lots * unitSize;
  }

  // WebSocket state
  const socketRef = useRef<Socket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const tradesRef = useRef<PaperTrade[]>([]); // Keep ref of trades for WebSocket callbacks
  const [isMarketHours, setIsMarketHours] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!loading && user) {
      loadTrades();
      loadStats();
    }
  }, [loading, user, period, statusFilter]);

  // Update trades ref when trades change
  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  // Check market hours
  useEffect(() => {
    const checkMarketHours = () => {
      const now = new Date();
      const istTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
      );
      const hours = istTime.getHours();
      const minutes = istTime.getMinutes();
      const currentTime = hours * 60 + minutes;

      // Market hours: 9:15 AM to 3:30 PM IST
      const marketOpen = 9 * 60 + 15; // 9:15 AM
      const marketClose = 15 * 60 + 30; // 3:30 PM
      const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday

      // Market is open Mon-Fri, 9:15 AM - 3:30 PM IST
      const isOpen =
        day >= 1 &&
        day <= 5 &&
        currentTime >= marketOpen &&
        currentTime <= marketClose;
      setIsMarketHours(isOpen);

      if (!isOpen) {
        console.log(
          "⏰ Market is currently closed. Live updates will resume during market hours (9:15 AM - 3:30 PM IST)",
        );
      }
    };

    checkMarketHours();
    const interval = setInterval(checkMarketHours, 60000); // Check every minute

    return () => clearInterval(interval);
  }, []);

  // Fetch initial LTP when trades load
  useEffect(() => {
    if (trades.length > 0 && trades.some((t) => t.status === "ACTIVE")) {
      fetchLtp();
    }
  }, [trades.length]);

  // WebSocket connection management
  useEffect(() => {
    if (!user) return;

    const API_BASE =
      process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";

    setWsStatus("connecting");
    const socket = io(API_BASE, {
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("WebSocket connected");
      setWsConnected(true);
      setWsStatus("connected");
      toast.success("Live price updates connected");
    });

    socket.on("disconnect", () => {
      console.log("WebSocket disconnected");
      setWsConnected(false);
      setWsStatus("disconnected");
    });

    socket.on(
      "ltp-update",
      (data: {
        updates: Array<{ instrument_token: number; last_price: number }>;
      }) => {
        console.log("LTP update received:", data.updates);

        // Update LTP data by mapping instrument tokens to trade IDs
        setLtpData((prev) => {
          const newData = { ...prev };

          data.updates.forEach((update) => {
            // Find trade(s) with this instrument token using the ref
            const matchingTrades = tradesRef.current.filter(
              (t) =>
                t.instrumentToken === update.instrument_token &&
                t.status === "ACTIVE",
            );

            matchingTrades.forEach((trade) => {
              newData[trade.id] = update.last_price;
              console.log(
                `Updated LTP for trade ${trade.id} (${trade.optionSymbol}): ₹${update.last_price}`,
              );
            });
          });

          return newData;
        });
      },
    );

    socket.on("ltp-subscribed", (data) => {
      console.log("✅ LTP subscription confirmed:", data);
      toast.success(
        `Subscribed to ${data.instrumentTokens?.length || 0} instruments`,
      );
    });

    socket.on("ltp-error", (data) => {
      console.error("LTP error:", data);
      toast.error(`LTP: ${data.message}`);
    });

    socketRef.current = socket;

    return () => {
      console.log("Cleaning up WebSocket connection");
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  // Subscribe to LTP when trades or WebSocket connection changes
  useEffect(() => {
    if (!socketRef.current || !wsConnected || trades.length === 0) {
      console.log("Skipping LTP subscription:", {
        socketExists: !!socketRef.current,
        wsConnected,
        tradesCount: trades.length,
      });
      return;
    }

    const activeTrades = trades.filter((t) => t.status === "ACTIVE");
    if (activeTrades.length === 0) {
      console.log("No active trades to subscribe");
      return;
    }

    // Validate trades have required data
    const validTrades = activeTrades.filter(
      (t) => t.brokerId && t.instrumentToken,
    );
    if (validTrades.length === 0) {
      console.error(
        "Active trades missing brokerId or instrumentToken:",
        activeTrades,
      );
      toast.error("Trades are missing instrument information");
      return;
    }

    if (validTrades.length < activeTrades.length) {
      console.warn(
        `${activeTrades.length - validTrades.length} trades missing data`,
      );
    }

    // Group by broker
    const tradesByBroker: Record<string, PaperTrade[]> = {};
    validTrades.forEach((trade) => {
      if (!tradesByBroker[trade.brokerId]) {
        tradesByBroker[trade.brokerId] = [];
      }
      tradesByBroker[trade.brokerId].push(trade);
    });

    console.log(
      "Setting up LTP subscriptions for",
      Object.keys(tradesByBroker).length,
      "broker(s)",
    );

    // Subscribe for each broker
    Object.entries(tradesByBroker).forEach(([brokerId, brokerTrades]) => {
      const instrumentTokens = brokerTrades.map((t) => t.instrumentToken);

      console.log(`📡 Subscribing to LTP for broker ${brokerId}:`, {
        count: instrumentTokens.length,
        tokens: instrumentTokens,
        trades: brokerTrades.map((t) => ({
          id: t.id,
          symbol: t.optionSymbol,
          token: t.instrumentToken,
        })),
      });

      socketRef.current?.emit("subscribe-ltp", {
        brokerId,
        instrumentTokens,
      });
    });

    // Only unsubscribe when component unmounts or WebSocket disconnects
    // NOT when trades change (to prevent frequent reconnections)
  }, [trades, wsConnected]);

  // Cleanup WebSocket subscriptions only on unmount
  useEffect(() => {
    return () => {
      if (socketRef.current && socketRef.current.connected) {
        console.log("Cleaning up LTP subscriptions on unmount");
        socketRef.current.emit("unsubscribe-ltp");
      }
    };
  }, []);

  // Remove the old auto-refresh polling effect (no longer needed with WebSocket)

  async function loadTrades() {
    try {
      setLoadingTrades(true);
      const params = new URLSearchParams();
      if (statusFilter !== "all") {
        params.append("status", statusFilter);
      }

      // Apply date range based on selected period
      if (period !== "all") {
        const now = new Date();
        const toDate = new Date(now);
        toDate.setHours(23, 59, 59, 999);
        const fromDate = new Date(now);
        if (period === "daily") {
          fromDate.setHours(0, 0, 0, 0);
        } else if (period === "weekly") {
          fromDate.setDate(now.getDate() - 7);
          fromDate.setHours(0, 0, 0, 0);
        } else if (period === "monthly") {
          fromDate.setDate(now.getDate() - 30);
          fromDate.setHours(0, 0, 0, 0);
        }
        params.append("fromDate", fromDate.toISOString());
        params.append("toDate", toDate.toISOString());
      }

      const url = `/paper-trading?${params.toString()}`;
      const data = await apiFetch<PaperTrade[]>(url);
      setTrades(data);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load trades");
    } finally {
      setLoadingTrades(false);
    }
  }

  async function loadStats() {
    try {
      const data = await apiFetch<PnLStats>(
        `/paper-trading/stats?period=${period}`,
      );
      setStats(data);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load stats");
    }
  }

  async function monitorTrades() {
    try {
      setIsMonitoring(true);
      const result = await apiFetch<{
        checked: number;
        closed: number;
        trades: PaperTrade[];
      }>("/paper-trading/monitor", { method: "POST" });

      if (result.closed > 0) {
        toast.success(
          `Monitored ${result.checked} trades, closed ${result.closed} trades`,
        );
        loadTrades();
        loadStats();
      } else {
        toast.success(`Monitored ${result.checked} trades, all still active`);
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to monitor trades");
    } finally {
      setIsMonitoring(false);
    }
  }

  async function deleteTrade(tradeId: string) {
    if (!confirm("Are you sure you want to delete this trade?")) {
      return;
    }

    try {
      // Check if this is an active trade before deleting (for WS cleanup)
      const deletingActive = trades.find(
        (t) => t.id === tradeId && t.status === "ACTIVE",
      );

      await apiFetch(`/paper-trading/${tradeId}`, { method: "DELETE" });
      toast.success("Trade deleted successfully");

      // If we deleted an active trade, check remaining active trades
      if (deletingActive) {
        const remainingActive = trades.filter(
          (t) => t.id !== tradeId && t.status === "ACTIVE",
        );
        if (remainingActive.length === 0) {
          // No more active trades — unsubscribe from LTP feed entirely
          if (socketRef.current?.connected) {
            socketRef.current.emit("unsubscribe-ltp");
          }
        }
        // If remaining active trades exist, the useEffect([trades, wsConnected])
        // will fire after loadTrades() and re-subscribe with only remaining tokens.
        // The gateway's token-diff logic will unsubscribe the deleted trade's token.
      }

      await loadTrades();
      loadStats();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete trade");
    }
  }

  async function clearAllTrades() {
    if (
      !confirm(
        "Are you sure you want to delete ALL paper trades? This cannot be undone!",
      )
    ) {
      return;
    }

    try {
      const result = await apiFetch<{ deleted: number }>(
        "/paper-trading/clear-all",
        { method: "DELETE" },
      );
      toast.success(`Successfully deleted ${result.deleted} trades`);
      loadTrades();
      loadStats();
    } catch (err: any) {
      toast.error(err?.message || "Failed to clear trades");
    }
  }

  async function fetchLtp() {
    try {
      setLoadingLtp(true);
      const activeTrades = trades.filter((t) => t.status === "ACTIVE");

      if (activeTrades.length === 0) {
        setLtpData({});
        return;
      }

      // Check if brokerId and instrumentToken exist
      const missingBrokerId = activeTrades.filter(
        (t) => !t.brokerId || !t.instrumentToken,
      );
      if (missingBrokerId.length > 0) {
        console.error(
          "Trades missing brokerId or instrumentToken:",
          missingBrokerId,
        );
        toast.error("Some trades are missing broker or instrument information");
        return;
      }

      // Group by broker to make separate API calls
      const tradesByBroker: Record<string, PaperTrade[]> = {};
      activeTrades.forEach((trade) => {
        if (!tradesByBroker[trade.brokerId]) {
          tradesByBroker[trade.brokerId] = [];
        }
        tradesByBroker[trade.brokerId].push(trade);
      });

      const newLtpData: Record<string, number> = {};

      // Fetch LTP for each broker using instrument tokens (more efficient)
      for (const [brokerId, brokerTrades] of Object.entries(tradesByBroker)) {
        const instrumentTokens = brokerTrades.map(
          (trade) => trade.instrumentToken,
        );

        try {
          const response: any = await apiFetch("/kite/quotes-by-tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brokerId, instrumentTokens }),
          });

          if (response.quotes && Array.isArray(response.quotes)) {
            // response.quotes is an array of { instrument_token, last_price, tradingsymbol, exchange }
            brokerTrades.forEach((trade) => {
              const quoteData = response.quotes.find(
                (q: any) => q.instrument_token === trade.instrumentToken,
              );
              if (quoteData && typeof quoteData.last_price === "number") {
                newLtpData[trade.id] = quoteData.last_price;
              }
            });
          }
        } catch (err: any) {
          console.error(`Failed to fetch LTP for broker ${brokerId}:`, err);
          toast.error(`Failed to fetch LTP: ${err.message || "Unknown error"}`);
        }
      }

      setLtpData(newLtpData);

      if (Object.keys(newLtpData).length > 0) {
        toast.success(
          `Fetched LTP for ${Object.keys(newLtpData).length} trades`,
        );
      }
    } catch (err: any) {
      console.error("Failed to fetch LTP:", err);
      toast.error(err?.message || "Failed to fetch LTP");
    } finally {
      setLoadingLtp(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    const day = d.getDate();
    const mon = d.toLocaleString("en-IN", { month: "short" });
    const time = d.toLocaleString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return (
      <>
        <span>
          {day} {mon},
        </span>
        <br />
        <span>{time}</span>
      </>
    );
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return "bg-blue-100 text-blue-800";
      case "CLOSED_SL":
        return "bg-red-100 text-red-800";
      case "CLOSED_TARGET1":
      case "CLOSED_TARGET2":
      case "CLOSED_TARGET3":
        return "bg-green-100 text-green-800";
      case "CLOSED_EOD":
        return "bg-orange-100 text-orange-800";
      case "CANCELLED":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusDisplay = (status: string) => {
    switch (status) {
      case "CLOSED_TARGET1":
        return "Target 1:2";
      case "CLOSED_TARGET2":
        return "Target 1:3";
      case "CLOSED_TARGET3":
        return "Target 1:4";
      case "CLOSED_SL":
        return "Stop Loss";
      case "CLOSED_EOD":
        return "Squared Off (EOD)";
      default:
        return status.replace("_", " ");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Paper Trading</h1>
            <p className="text-gray-600">Track your paper trades and P&L</p>
          </div>
          <div className="flex gap-3 items-center">
            {/* WebSocket Status Indicator */}
            <div className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg">
              <div
                className={`w-2 h-2 rounded-full ${
                  wsStatus === "connected"
                    ? "bg-green-500 animate-pulse"
                    : wsStatus === "connecting"
                      ? "bg-yellow-500 animate-pulse"
                      : "bg-gray-400"
                }`}
              ></div>
              <span className="text-sm font-medium text-gray-700">
                {wsStatus === "connected"
                  ? "Live"
                  : wsStatus === "connecting"
                    ? "Connecting..."
                    : "Disconnected"}
              </span>
            </div>

            {/* Market Hours Indicator */}
            <div className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg">
              <div
                className={`w-2 h-2 rounded-full ${
                  isMarketHours ? "bg-green-500" : "bg-orange-500"
                }`}
              ></div>
              <span className="text-sm font-medium text-gray-700">
                {isMarketHours ? "Market Open" : "Market Closed"}
              </span>
            </div>

            {/* Manual Refresh LTP Button (fallback) */}
            <button
              onClick={fetchLtp}
              disabled={
                loadingLtp ||
                trades.filter((t) => t.status === "ACTIVE").length === 0
              }
              className="rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
              title="Manually refresh prices (fallback)"
            >
              {loadingLtp ? (
                <>
                  <svg
                    className="animate-spin h-4 w-4"
                    fill="none"
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
                  Refreshing...
                </>
              ) : (
                <>
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
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Refresh LTP
                </>
              )}
            </button>

            <button
              onClick={clearAllTrades}
              className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700 transition-colors"
            >
              Clear All Trades
            </button>

            <button
              onClick={monitorTrades}
              disabled={isMonitoring}
              className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isMonitoring ? "Monitoring..." : "Monitor Trades"}
            </button>
          </div>
        </div>
        {/* Market Closed Warning */}
        {!isMarketHours && wsConnected && (
          <div className="mb-6 rounded-lg bg-orange-50 border border-orange-200 p-4">
            <div className="flex items-center gap-3">
              <svg
                className="w-5 h-5 text-orange-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <p className="font-medium text-orange-900">Market is Closed</p>
                <p className="text-sm text-orange-700">
                  Live price updates are only available during market hours
                  (Mon-Fri, 9:15 AM - 3:30 PM IST). You can still use the manual
                  "Refresh LTP" button to get cached prices.
                </p>
              </div>
            </div>
          </div>
        )}
        {/* Stats Cards */}
        {stats && (
          <div className="mb-6">
            <div className="mb-4 flex gap-2">
              {(["all", "daily", "weekly", "monthly"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded-lg px-4 py-2 capitalize ${
                    period === p
                      ? "bg-blue-600 text-white"
                      : "bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Running MTM banner — only when active trades have live prices */}
            {(() => {
              const activeTrades = trades.filter(
                (t) => t.status === "ACTIVE" && ltpData[t.id] != null,
              );
              if (activeTrades.length === 0) return null;
              const runningMtm = activeTrades.reduce((sum, t) => {
                const units = tradeUnits(t);
                const mtm =
                  t.signalType === "SELL"
                    ? (t.entryPrice - ltpData[t.id]) * units
                    : (ltpData[t.id] - t.entryPrice) * units;
                return sum + mtm;
              }, 0);
              return (
                <div
                  className={`mb-4 flex items-center justify-between rounded-xl border-2 px-6 py-4 shadow ${
                    runningMtm >= 0
                      ? "border-green-300 bg-green-50"
                      : "border-red-300 bg-red-50"
                  }`}
                >
                  <div>
                    <div
                      className={`text-xs font-semibold uppercase tracking-wide ${
                        runningMtm >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      Running MTM ({activeTrades.length} active trade
                      {activeTrades.length > 1 ? "s" : ""})
                    </div>
                    <div
                      className={`text-3xl font-bold ${
                        runningMtm >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {runningMtm >= 0 ? "+" : ""}₹{runningMtm.toFixed(0)}
                    </div>
                  </div>
                  <div
                    className={`text-5xl ${
                      runningMtm >= 0 ? "text-green-300" : "text-red-300"
                    }`}
                  >
                    {runningMtm >= 0 ? "📈" : "📉"}
                  </div>
                </div>
              );
            })()}

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Total Trades</div>
                <div className="text-2xl font-bold">{stats.totalTrades}</div>
              </div>
              <div className="rounded-lg bg-blue-50 p-4 shadow">
                <div className="text-sm text-blue-600">Active</div>
                <div className="text-2xl font-bold text-blue-700">
                  {stats.activeTrades}
                </div>
              </div>
              <div className="rounded-lg bg-green-50 p-4 shadow">
                <div className="text-sm text-green-600">Winning</div>
                <div className="text-2xl font-bold text-green-700">
                  {stats.winningTrades}
                </div>
              </div>
              <div className="rounded-lg bg-red-50 p-4 shadow">
                <div className="text-sm text-red-600">Losing</div>
                <div className="text-2xl font-bold text-red-700">
                  {stats.losingTrades}
                </div>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Win Rate</div>
                <div className="text-2xl font-bold">
                  {stats.winRate.toFixed(1)}%
                </div>
              </div>
              <div
                className={`rounded-lg p-4 shadow ${
                  stats.totalPnL >= 0 ? "bg-green-50" : "bg-red-50"
                }`}
              >
                <div
                  className={`text-sm ${stats.totalPnL >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  Total P&L
                </div>
                <div
                  className={`text-2xl font-bold ${
                    stats.totalPnL >= 0 ? "text-green-700" : "text-red-700"
                  }`}
                >
                  ₹{stats.totalPnL.toFixed(0)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Avg Win</div>
                <div className="text-xl font-bold text-green-700">
                  ₹{stats.avgWin.toFixed(0)}
                </div>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Avg Loss</div>
                <div className="text-xl font-bold text-red-700">
                  ₹{stats.avgLoss.toFixed(0)}
                </div>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Best Trade</div>
                <div className="text-xl font-bold text-green-700">
                  ₹{stats.bestTrade.toFixed(0)}
                </div>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <div className="text-sm text-gray-600">Worst Trade</div>
                <div className="text-xl font-bold text-red-700">
                  ₹{stats.worstTrade.toFixed(0)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border px-4 py-2"
          >
            <option value="all">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="CLOSED_SL">Stop Loss</option>
            <option value="CLOSED_TARGET1">Target 1:2</option>
            <option value="CLOSED_TARGET2">Target 1:3</option>
            <option value="CLOSED_TARGET3">Target 1:4</option>
            <option value="CLOSED_EOD">Squared Off (EOD)</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>

        {/* Trades Table */}
        <div className="rounded-lg bg-white shadow-lg overflow-hidden">
          {loadingTrades ? (
            <div className="py-12 text-center">Loading trades...</div>
          ) : trades.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              No paper trades found. Go to Trade Finder to create trades.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 w-28">
                      Entry Time
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 w-28">
                      Exit Time
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">
                      Option
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 w-17.5">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700 w-27.5">
                      Strategy
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700 w-22.5">
                      Entry Price
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700 w-22.5">
                      LTP
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700 w-22.5">
                      Exit Price
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700 w-35">
                      P&L
                    </th>
                    <th className="px-4 py-3 text-center text-sm font-semibold text-gray-700 w-22.5">
                      Status
                    </th>
                    <th className="px-4 py-3 text-center text-sm font-semibold text-gray-700 w-17.5">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {trades.map((trade) => (
                    <tr key={trade.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm leading-snug">
                        {formatDate(trade.entryTime)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 leading-snug">
                        {trade.exitTime ? formatDate(trade.exitTime) : "-"}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">
                        {trade.optionSymbol}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            trade.signalType === "SELL"
                              ? "bg-red-100 text-red-700"
                              : "bg-green-100 text-green-700"
                          }`}
                        >
                          {trade.signalType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">{trade.strategy}</td>
                      <td className="px-4 py-3 text-sm text-right">
                        ₹{trade.entryPrice.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        {trade.status === "ACTIVE" ? (
                          ltpData[trade.id] ? (
                            <span className="font-medium text-blue-700">
                              ₹{ltpData[trade.id].toFixed(2)}
                            </span>
                          ) : loadingLtp ? (
                            <span className="text-gray-400 text-xs">
                              Loading...
                            </span>
                          ) : (
                            <span className="text-gray-400 text-xs">-</span>
                          )
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        {trade.exitPrice
                          ? `₹${trade.exitPrice.toFixed(2)}`
                          : "-"}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium">
                        {trade.status === "ACTIVE" ? (
                          ltpData[trade.id] != null ? (
                            (() => {
                              const units = tradeUnits(trade);
                              const mtm =
                                trade.signalType === "SELL"
                                  ? (trade.entryPrice - ltpData[trade.id]) *
                                    units
                                  : (ltpData[trade.id] - trade.entryPrice) *
                                    units;
                              return (
                                <span
                                  className={
                                    mtm >= 0 ? "text-green-700" : "text-red-700"
                                  }
                                >
                                  {mtm >= 0 ? "+" : ""}₹{mtm.toFixed(0)}
                                  <span className="ml-1 text-xs font-normal text-gray-400">
                                    (MTM)
                                  </span>
                                </span>
                              );
                            })()
                          ) : (
                            <span className="text-gray-400 text-xs">
                              awaiting LTP…
                            </span>
                          )
                        ) : (
                          <span
                            className={
                              trade.pnl >= 0 ? "text-green-700" : "text-red-700"
                            }
                          >
                            {trade.pnl >= 0 ? "+" : ""}₹{trade.pnl.toFixed(0)} (
                            {trade.pnlPercentage.toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(trade.status)}`}
                        >
                          {getStatusDisplay(trade.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => deleteTrade(trade.id)}
                          className="text-red-600 hover:text-red-800 text-sm font-medium inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                          title="Delete trade"
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
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

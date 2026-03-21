"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";

interface LiveTrade {
  id: string;
  symbol: string;
  optionSymbol: string;
  strike: number;
  optionType: string;
  expiryDate: string;
  strategy: string;

  hedgeSymbol: string | null;
  hedgeOrderId: string | null;
  hedgePrice: number | null;
  hedgeQty: number;
  hedgeFilled: boolean;

  entryPrice: number | null;
  entryLimitPrice: number | null;
  entryFilledPrice: number | null;
  entryFilledTime: string | null;
  entryQty: number;
  entryFilled: boolean;

  targetOrderId: string | null;
  targetPrice: number | null;
  targetFilled: boolean;
  targetFilledPrice: number | null;

  slOrderId: string | null;
  slPrice: number | null;
  slFilled: boolean;
  slFilledPrice: number | null;

  status: string;
  pnl: number | null;
  exitPrice: number | null;
  exitTime: string | null;
  errorMessage: string | null;
  createdAt: string;

  broker: { name: string; type: string } | null;
}

interface Stats {
  total: number;
  active: number;
  targetHit: number;
  slHit: number;
  squaredOff: number;
  failed: number;
  totalPnl: number;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING_HEDGE: "bg-yellow-100 text-yellow-800",
  PENDING_ENTRY: "bg-blue-100 text-blue-800",
  PENDING_EXIT_ORDERS: "bg-indigo-100 text-indigo-800",
  ACTIVE: "bg-green-100 text-green-800",
  TARGET_HIT: "bg-emerald-100 text-emerald-800",
  SL_HIT: "bg-red-100 text-red-800",
  SQUARED_OFF: "bg-zinc-100 text-zinc-700",
  FAILED: "bg-red-200 text-red-900",
  CANCELLED: "bg-zinc-100 text-zinc-500",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING_HEDGE: "⏳ Hedge Pending",
  PENDING_ENTRY: "⏳ Entry Pending",
  PENDING_EXIT_ORDERS: "⏳ Placing T/SL",
  ACTIVE: "🟢 Active",
  TARGET_HIT: "🎯 Target Hit",
  SL_HIT: "🛑 SL Hit",
  SQUARED_OFF: "⚪ Squared Off",
  FAILED: "❌ Failed",
  CANCELLED: "🚫 Cancelled",
};

const ACTIVE_STATUSES = [
  "PENDING_HEDGE",
  "PENDING_ENTRY",
  "PENDING_EXIT_ORDERS",
  "ACTIVE",
];

export default function LiveOrdersPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loadingData, setLoadingData] = useState(true);
  const [squaringOff, setSquaringOff] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  const loadData = useCallback(async () => {
    try {
      const [tradesRes, statsRes] = await Promise.all([
        apiFetch<LiveTrade[]>(
          `/live-trades${statusFilter !== "ALL" ? `?status=${statusFilter}` : ""}`,
        ),
        apiFetch<Stats>("/live-trades/stats"),
      ]);
      setTrades(tradesRes);
      setStats(statsRes);
    } catch (err: any) {
      toast.error("Failed to load live orders");
    } finally {
      setLoadingData(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (loading || !user) return;
    loadData();
  }, [loading, user, loadData]);

  // Auto-refresh every 15 seconds when there are active trades
  useEffect(() => {
    const hasActive = trades.some((t) => ACTIVE_STATUSES.includes(t.status));
    if (!hasActive) return;
    const interval = setInterval(loadData, 15_000);
    return () => clearInterval(interval);
  }, [trades, loadData]);

  const handleSquareOff = async (id: string, symbol: string) => {
    if (!confirm(`Square off live trade for ${symbol}?`)) return;
    setSquaringOff(id);
    try {
      await apiFetch(`/live-trades/${id}/square-off`, { method: "POST" });
      toast.success(`Squared off ${symbol}`);
      loadData();
    } catch (err: any) {
      toast.error(err?.message || "Failed to square off");
    } finally {
      setSquaringOff(null);
    }
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-zinc-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between p-4">
          <div className="font-semibold">🔴 Live Orders</div>
          <div className="flex gap-2">
            <button
              onClick={loadData}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100"
            >
              🔄 Refresh
            </button>
            <Link
              href="/dashboard"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100"
            >
              ← Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-6 space-y-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard label="Total" value={stats.total} color="zinc" />
            <StatCard label="Active" value={stats.active} color="green" />
            <StatCard
              label="Target Hit"
              value={stats.targetHit}
              color="emerald"
            />
            <StatCard label="SL Hit" value={stats.slHit} color="red" />
            <StatCard label="Sq. Off" value={stats.squaredOff} color="zinc" />
            <StatCard label="Failed" value={stats.failed} color="red" />
            <div
              className={`rounded-xl border p-3 text-center ${
                stats.totalPnl >= 0
                  ? "bg-emerald-50 border-emerald-200"
                  : "bg-red-50 border-red-200"
              }`}
            >
              <div
                className={`text-lg font-bold ${
                  stats.totalPnl >= 0 ? "text-emerald-700" : "text-red-700"
                }`}
              >
                ₹{stats.totalPnl.toFixed(0)}
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">Total P&L</div>
            </div>
          </div>
        )}

        {/* Filter */}
        <div className="flex flex-wrap gap-2">
          {[
            "ALL",
            "ACTIVE",
            "PENDING_HEDGE",
            "PENDING_ENTRY",
            "TARGET_HIT",
            "SL_HIT",
            "SQUARED_OFF",
            "FAILED",
          ].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                statusFilter === s
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-zinc-600 border-zinc-300 hover:border-blue-400"
              }`}
            >
              {s === "ALL" ? "All" : (STATUS_LABELS[s] ?? s)}
            </button>
          ))}
        </div>

        {/* Trades table */}
        {trades.length === 0 ? (
          <div className="rounded-xl border bg-white p-12 text-center text-zinc-500">
            <div className="text-4xl mb-3">📭</div>
            <div className="font-medium">No live orders found</div>
            <div className="text-sm mt-1">
              Enable live trading in{" "}
              <Link href="/settings" className="text-blue-600 underline">
                Settings
              </Link>{" "}
              to start placing real orders automatically.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {trades.map((trade) => (
              <TradeCard
                key={trade.id}
                trade={trade}
                onSquareOff={handleSquareOff}
                squaringOff={squaringOff === trade.id}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    green: "bg-green-50 border-green-200",
    emerald: "bg-emerald-50 border-emerald-200",
    red: "bg-red-50 border-red-200",
    zinc: "bg-white border-zinc-200",
  };
  const textMap: Record<string, string> = {
    green: "text-green-700",
    emerald: "text-emerald-700",
    red: "text-red-700",
    zinc: "text-zinc-700",
  };
  return (
    <div
      className={`rounded-xl border p-3 text-center ${colorMap[color] ?? "bg-white border-zinc-200"}`}
    >
      <div className={`text-xl font-bold ${textMap[color] ?? "text-zinc-700"}`}>
        {value}
      </div>
      <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

function TradeCard({
  trade,
  onSquareOff,
  squaringOff,
}: {
  trade: LiveTrade;
  onSquareOff: (id: string, symbol: string) => void;
  squaringOff: boolean;
}) {
  const isActive = ACTIVE_STATUSES.includes(trade.status);
  const pnl = trade.pnl;

  return (
    <div
      className={`rounded-xl border bg-white p-4 ${isActive ? "border-blue-300 shadow-sm" : ""}`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{trade.optionSymbol}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_COLORS[trade.status] ?? "bg-zinc-100 text-zinc-600"
              }`}
            >
              {STATUS_LABELS[trade.status] ?? trade.status}
            </span>
            <span className="text-xs text-zinc-400">{trade.strategy}</span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {new Date(trade.createdAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {trade.broker && (
              <span className="ml-2">· {trade.broker.name}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {pnl !== null && (
            <span
              className={`text-sm font-semibold ${pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}
            >
              {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(0)}
            </span>
          )}
          {isActive && (
            <button
              onClick={() => onSquareOff(trade.id, trade.optionSymbol)}
              disabled={squaringOff}
              className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
            >
              {squaringOff ? "..." : "Square Off"}
            </button>
          )}
        </div>
      </div>

      {/* Order details grid */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <OrderBox
          label="🛡 Hedge"
          symbol={trade.hedgeSymbol}
          orderId={trade.hedgeOrderId}
          price={trade.hedgePrice}
          qty={trade.hedgeQty}
          filled={trade.hedgeFilled}
          tag="BUY"
        />
        <OrderBox
          label="📉 Entry SELL"
          symbol={trade.optionSymbol}
          orderId={null}
          price={trade.entryFilledPrice ?? trade.entryLimitPrice}
          qty={trade.entryQty}
          filled={trade.entryFilled}
          tag="SELL"
          limitPrice={trade.entryLimitPrice}
          filledTime={trade.entryFilledTime}
        />
        <OrderBox
          label="🎯 Target"
          symbol={null}
          orderId={trade.targetOrderId}
          price={trade.targetFilledPrice ?? trade.targetPrice}
          qty={trade.entryQty}
          filled={trade.targetFilled}
          tag="BUY"
        />
        <OrderBox
          label="🛑 Stop Loss"
          symbol={null}
          orderId={trade.slOrderId}
          price={trade.slFilledPrice ?? trade.slPrice}
          qty={trade.entryQty}
          filled={trade.slFilled}
          tag="BUY"
        />
      </div>

      {/* Error message */}
      {trade.errorMessage && (
        <div className="mt-2 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          ⚠️ {trade.errorMessage}
        </div>
      )}
    </div>
  );
}

function OrderBox({
  label,
  symbol,
  orderId,
  price,
  qty,
  filled,
  tag,
  limitPrice,
  filledTime,
}: {
  label: string;
  symbol: string | null;
  orderId: string | null;
  price: number | null;
  qty: number;
  filled: boolean;
  tag: "BUY" | "SELL";
  limitPrice?: number | null;
  filledTime?: string | null;
}) {
  const borderColor = filled
    ? tag === "SELL"
      ? "border-red-200 bg-red-50"
      : "border-emerald-200 bg-emerald-50"
    : orderId
      ? "border-blue-200 bg-blue-50"
      : "border-zinc-100 bg-zinc-50";

  return (
    <div className={`rounded-lg border p-2 ${borderColor}`}>
      <div className="font-medium text-zinc-600 mb-1">{label}</div>
      {symbol && (
        <div className="text-zinc-700 font-mono truncate">{symbol}</div>
      )}
      {orderId && (
        <div className="text-zinc-400 font-mono truncate text-[10px]">
          {orderId}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        {price !== null && (
          <span className="font-semibold text-zinc-800">
            ₹{price.toFixed(1)}
          </span>
        )}
        {qty > 0 && <span className="text-zinc-400">×{qty}</span>}
        {filled && (
          <span className="rounded-full bg-green-200 text-green-800 px-1.5 py-0.5 text-[10px] font-medium">
            FILLED
          </span>
        )}
        {!filled && orderId && (
          <span className="rounded-full bg-yellow-100 text-yellow-700 px-1.5 py-0.5 text-[10px] font-medium">
            OPEN
          </span>
        )}
        {!orderId && !filled && (
          <span className="rounded-full bg-zinc-200 text-zinc-500 px-1.5 py-0.5 text-[10px]">
            NOT PLACED
          </span>
        )}
      </div>
      {filledTime && (
        <div className="text-zinc-400 text-[10px] mt-0.5">
          {new Date(filledTime).toLocaleTimeString("en-IN")}
        </div>
      )}
    </div>
  );
}

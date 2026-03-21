"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { ThemeToggle } from "@/components/theme-toggle";

// ── Types ──────────────────────────────────────────────────────────────────────

type Signal = {
  time: string;
  type: "BUY" | "SELL";
  price: number;
  reason: string;
  open: number;
  high: number;
  low: number;
  close: number;
  stopLoss: number;
  target1R: number;
  target: number;
  outcome:
    | "FULL_SL"
    | "BE"
    | "PARTIAL_BE"
    | "RUNNER_EXIT_5M_EMA"
    | "RUNNER_EXIT_5M_SWING"
    | "RUNNER_EXIT_5M_REVERSAL"
    | "MAX_TARGET_HIT"
    | "OPEN";
  exitPrice: number | null;
  exitTime: string | null;
  partialExitPrice: number | null;
  pnlPoints: number | null;
  pnlPct: number | null;
  entryMode?: "IMMEDIATE" | "RETRACEMENT";
};

type DeltaBroker = { id: string; name: string; type: string };

// ── Constants ──────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { value: "BTCUSD", label: "Bitcoin (BTC/USD)" },
  { value: "ETHUSD", label: "Ethereum (ETH/USD)" },
  { value: "SOLUSD", label: "Solana (SOL/USD)" },
  { value: "XRPUSD", label: "Ripple (XRP/USD)" },
  { value: "BNBUSD", label: "BNB (BNB/USD)" },
  { value: "ADAUSD", label: "Cardano (ADA/USD)" },
  { value: "DOTUSD", label: "Polkadot (DOT/USD)" },
  { value: "AVAXUSD", label: "Avalanche (AVAX/USD)" },
  { value: "MATICUSD", label: "Polygon (MATIC/USD)" },
  { value: "LINKUSD", label: "Chainlink (LINK/USD)" },
];

const INTERVALS = [
  { value: "1m", label: "1 Min" },
  { value: "5m", label: "5 Min" },
  { value: "15m", label: "15 Min" },
  { value: "30m", label: "30 Min" },
  { value: "1h", label: "1 Hour" },
];

const STRATEGIES = [
  { value: "EMA_CROSS", label: "EMA Cross (9/21)" },
  { value: "RSI", label: "RSI Reversal (30/70)" },
  { value: "SUPERTREND", label: "SuperTrend (10, 2)" },
  { value: "EMA_RSI", label: "EMA Cross + RSI Confirmation" },
  { value: "SCALPING", label: "Scalping (Trend · Sweep · EMA Rejection)" },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtPrice(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1000)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DeltaTradeFinder() {
  const router = useRouter();
  const { user, loading } = useMe();

  const [deltaBrokers, setDeltaBrokers] = useState<DeltaBroker[]>([]);
  const [brokerId, setBrokerId] = useState("");
  const [symbol, setSymbol] = useState("BTCUSD");
  const [interval, setIntervalVal] = useState("5m");
  const [strategy, setStrategy] = useState("EMA_CROSS");
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d.toISOString().split("T")[0];
  });
  const [toDate, setToDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [signals, setSignals] = useState<Signal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [outcomeFilter, setOutcomeFilter] = useState<
    | "ALL"
    | "FULL_SL"
    | "BE"
    | "PARTIAL_BE"
    | "RUNNER"
    | "MAX_TARGET_HIT"
    | "OPEN"
  >("ALL");
  const [scannedMeta, setScannedMeta] = useState<{
    symbol: string;
    interval: string;
    strategy: string;
    from: string;
    to: string;
    total: number;
  } | null>(null);

  // Auth guard
  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  // Load Delta brokers
  useEffect(() => {
    if (loading || !user) return;
    apiFetch<{ brokers: DeltaBroker[] }>("/brokers")
      .then(({ brokers }) => {
        const delta = brokers.filter((b) => b.type === "DELTA");
        setDeltaBrokers(delta);
        if (delta.length > 0) setBrokerId(delta[0].id);
      })
      .catch(() => toast.error("Failed to load brokers"));
  }, [loading, user]);

  async function handleFindTrades() {
    if (!fromDate || !toDate) {
      toast.error("Please select from and to dates");
      return;
    }
    setScanning(true);
    setSignals([]);
    setScannedMeta(null);
    try {
      const params = new URLSearchParams({
        symbol,
        interval,
        fromDate,
        toDate,
        strategy,
      });
      const result = await apiFetch<Signal[]>(`/delta/trade-finder?${params}`);
      setSignals(result);
      setScannedMeta({
        symbol,
        interval:
          INTERVALS.find((i) => i.value === interval)?.label ?? interval,
        strategy:
          STRATEGIES.find((s) => s.value === strategy)?.label ?? strategy,
        from: fromDate,
        to: toDate,
        total: result.length,
      });
      if (result.length === 0) {
        toast("No signals found for the selected criteria", { icon: "ℹ️" });
      } else {
        toast.success(
          `Found ${result.length} signal${result.length !== 1 ? "s" : ""}`,
        );
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to scan signals");
    } finally {
      setScanning(false);
    }
  }

  const filtered = signals.filter((s) => {
    const matchType = filter === "ALL" || s.type === filter;
    const matchOutcome =
      outcomeFilter === "ALL" ||
      (outcomeFilter === "RUNNER"
        ? s.outcome === "RUNNER_EXIT_5M_EMA" ||
          s.outcome === "RUNNER_EXIT_5M_SWING" ||
          s.outcome === "RUNNER_EXIT_5M_REVERSAL"
        : s.outcome === outcomeFilter);
    return matchType && matchOutcome;
  });

  const buyCount = signals.filter((s) => s.type === "BUY").length;
  const sellCount = signals.filter((s) => s.type === "SELL").length;
  const targetCount = signals.filter(
    (s) =>
      s.outcome === "RUNNER_EXIT_5M_EMA" ||
      s.outcome === "RUNNER_EXIT_5M_SWING" ||
      s.outcome === "RUNNER_EXIT_5M_REVERSAL" ||
      s.outcome === "MAX_TARGET_HIT" ||
      s.outcome === "PARTIAL_BE",
  ).length;
  const slCount = signals.filter((s) => s.outcome === "FULL_SL").length;
  const beCount = signals.filter((s) => s.outcome === "BE").length;
  const closedCount = targetCount + slCount + beCount;
  const winRate =
    closedCount > 0 ? ((targetCount / closedCount) * 100).toFixed(1) : "—";
  const totalPnlPct = signals
    .reduce((sum, s) => sum + (s.pnlPct ?? 0), 0)
    .toFixed(2);

  if (loading) return null;
  if (!user) return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/deltadotexchange"
            className="text-blue-600 hover:underline text-sm"
          >
            ← Delta Exchange
          </Link>
          <h1 className="text-lg font-bold dark:text-white">Trade Finder</h1>
          <span className="text-xs bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded-full font-medium">
            Crypto
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/deltadotexchange"
            className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            Dashboard
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Filter card */}
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-700 p-5 shadow-sm">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {/* Broker */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Broker
              </label>
              <select
                value={brokerId}
                onChange={(e) => setBrokerId(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {deltaBrokers.length === 0 ? (
                  <option value="">No Delta broker</option>
                ) : (
                  deltaBrokers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Symbol */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Symbol
              </label>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {SYMBOLS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Strategy */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Strategy
              </label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* From Date */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                From Date
              </label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* To Date */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                To Date
              </label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Interval */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                Interval
              </label>
              <select
                value={interval}
                onChange={(e) => setIntervalVal(e.target.value)}
                className="border border-slate-300 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleFindTrades}
              disabled={scanning}
              className="bg-black dark:bg-white text-white dark:text-black font-semibold px-8 py-2.5 rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {scanning ? "Scanning…" : "Find Trades"}
            </button>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Scans candle data and detects buy / sell signals based on the
              selected strategy
            </p>
          </div>
        </div>

        {/* Scan summary */}
        {scannedMeta && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
            <SummaryCard label="Symbol" value={scannedMeta.symbol} />
            <SummaryCard label="Strategy" value={scannedMeta.strategy} small />
            <SummaryCard
              label="✓ Target"
              value={String(targetCount)}
              color="text-green-600 dark:text-green-400"
            />
            <SummaryCard
              label="✗ SL Hit"
              value={String(slCount)}
              color="text-red-600 dark:text-red-400"
            />
            <SummaryCard
              label="≈ Break Even"
              value={String(beCount)}
              color="text-blue-600 dark:text-blue-400"
            />
            <SummaryCard
              label="Win Rate"
              value={winRate === "—" ? "—" : `${winRate}%`}
              color={
                winRate !== "—" && parseFloat(winRate) >= 50
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-500 dark:text-red-400"
              }
            />
            <SummaryCard
              label="Total P&L %"
              value={`${Number(totalPnlPct) >= 0 ? "+" : ""}${totalPnlPct}%`}
              color={
                Number(totalPnlPct) >= 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-500 dark:text-red-400"
              }
            />
          </div>
        )}

        {/* Results */}
        {scannedMeta && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-700 shadow-sm overflow-hidden">
            {/* Table header toolbar */}
            <div className="px-5 py-3 border-b border-slate-100 dark:border-zinc-800 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm dark:text-white">
                    Signals — {scannedMeta.symbol} · {scannedMeta.interval} ·{" "}
                    {fmtDate(scannedMeta.from)} → {fmtDate(scannedMeta.to)}
                  </span>
                  <span className="text-xs text-slate-400">
                    ({filtered.length} shown)
                  </span>
                </div>
                <div className="flex gap-1">
                  {(["ALL", "BUY", "SELL"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        filter === f
                          ? f === "BUY"
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : f === "SELL"
                              ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                              : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                          : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              {/* Outcome filter */}
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { value: "ALL", label: "All Outcomes" },
                    { value: "FULL_SL", label: "SL Hit" },
                    { value: "BE", label: "BE" },
                    { value: "PARTIAL_BE", label: "Partial+BE" },
                    { value: "RUNNER", label: "Runner Exit" },
                    { value: "MAX_TARGET_HIT", label: "Max Target" },
                    { value: "OPEN", label: "Open" },
                  ] as const
                ).map(({ value, label }) => {
                  const active = outcomeFilter === value;
                  const colorClass = active
                    ? value === "FULL_SL"
                      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      : value === "BE"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                        : value === "PARTIAL_BE"
                          ? "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300"
                          : value === "RUNNER"
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : value === "MAX_TARGET_HIT"
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                              : value === "OPEN"
                                ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                                : "bg-slate-200 text-slate-700 dark:bg-zinc-700 dark:text-slate-200"
                    : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-zinc-800";
                  return (
                    <button
                      key={value}
                      onClick={() => setOutcomeFilter(value)}
                      className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors ${colorClass}`}
                    >
                      {label}
                      {value !== "ALL" && (
                        <span className="ml-1 opacity-60">
                          (
                          {
                            signals.filter((s) =>
                              value === "RUNNER"
                                ? s.outcome === "RUNNER_EXIT_5M_EMA" ||
                                  s.outcome === "RUNNER_EXIT_5M_SWING" ||
                                  s.outcome === "RUNNER_EXIT_5M_REVERSAL"
                                : s.outcome === value,
                            ).length
                          }
                          )
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="py-16 text-center text-slate-400 dark:text-slate-600">
                No signals match the selected filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-zinc-800/50 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      <th className="px-3 py-3 text-left">#</th>
                      <th className="px-3 py-3 text-left">
                        Entry Time / Reason
                      </th>
                      <th className="px-3 py-3 text-center">Signal</th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        Entry
                      </th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        Stop Loss
                      </th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        1R / BE Lvl
                      </th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        Target
                      </th>
                      <th className="px-3 py-3 text-center">Outcome</th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        Exit Price
                      </th>
                      <th className="px-3 py-3 text-left whitespace-nowrap">
                        Exit Time
                      </th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        P&amp;L $
                      </th>
                      <th className="px-3 py-3 text-right whitespace-nowrap">
                        P&amp;L %
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {filtered.map((s, idx) => {
                      const isProfit = (s.pnlPoints ?? 0) >= 0;
                      const pnlColor = isProfit
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400";
                      return (
                        <tr
                          key={idx}
                          className="hover:bg-slate-50 dark:hover:bg-zinc-800/40 transition-colors"
                        >
                          <td className="px-3 py-3 text-slate-400 dark:text-slate-500 font-mono text-xs">
                            {idx + 1}
                          </td>
                          <td className="px-3 py-3 min-w-[200px]">
                            <div className="font-mono text-xs dark:text-slate-300 whitespace-nowrap">
                              {fmtDateTime(s.time)}
                            </div>
                            {s.reason && (
                              <div className="mt-1 text-xs text-slate-400 dark:text-slate-500 leading-snug">
                                {s.reason}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <div className="inline-flex flex-col items-center gap-0.5">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                                  s.type === "BUY"
                                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                                    : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                }`}
                              >
                                {s.type === "BUY" ? "▲" : "▼"} {s.type}
                              </span>
                              {s.entryMode === "RETRACEMENT" && (
                                <span className="text-[10px] font-medium text-amber-500 dark:text-amber-400">
                                  RETR
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right font-semibold dark:text-white font-mono text-xs">
                            ${fmtPrice(s.price)}
                          </td>
                          <td className="px-3 py-3 text-right text-red-500 dark:text-red-400 font-mono text-xs">
                            ${fmtPrice(s.stopLoss)}
                          </td>
                          <td className="px-3 py-3 text-right text-blue-500 dark:text-blue-400 font-mono text-xs">
                            ${fmtPrice(s.target1R)}
                          </td>
                          <td className="px-3 py-3 text-right text-green-600 dark:text-green-400 font-mono text-xs">
                            ${fmtPrice(s.target)}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <OutcomeBadge outcome={s.outcome} />
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-xs dark:text-slate-300">
                            {s.exitPrice != null
                              ? `$${fmtPrice(s.exitPrice)}`
                              : "—"}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs text-slate-400 dark:text-slate-500 whitespace-nowrap">
                            {s.exitTime ? fmtDateTime(s.exitTime) : "—"}
                          </td>
                          <td
                            className={`px-3 py-3 text-right font-mono text-xs font-semibold ${pnlColor}`}
                          >
                            {s.pnlPoints != null
                              ? `${s.pnlPoints >= 0 ? "+" : ""}${fmtPrice(s.pnlPoints)}`
                              : "—"}
                          </td>
                          <td
                            className={`px-3 py-3 text-right font-mono text-xs font-semibold ${pnlColor}`}
                          >
                            {s.pnlPct != null
                              ? `${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%`
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Empty state before first scan */}
        {!scannedMeta && !scanning && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-700 py-20 text-center shadow-sm">
            <p className="text-4xl mb-3">📈</p>
            <p className="text-slate-600 dark:text-slate-400 font-medium">
              Select a symbol, strategy and date range, then click{" "}
              <strong>Find Trades</strong>.
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-600 mt-1">
              Crypto candles are fetched from Delta Exchange and scanned for
              technical signals.
            </p>
          </div>
        )}

        {scanning && (
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-700 py-20 text-center shadow-sm">
            <div className="inline-block w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-slate-600 dark:text-slate-400 font-medium">
              Fetching candles and scanning for signals…
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Outcome badge ─────────────────────────────────────────────────────────────

function OutcomeBadge({
  outcome,
}: {
  outcome:
    | "FULL_SL"
    | "BE"
    | "PARTIAL_BE"
    | "RUNNER_EXIT_5M_EMA"
    | "RUNNER_EXIT_5M_SWING"
    | "RUNNER_EXIT_5M_REVERSAL"
    | "MAX_TARGET_HIT"
    | "OPEN";
}) {
  if (outcome === "MAX_TARGET_HIT")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
        ★ MAX TARGET
      </span>
    );
  if (outcome === "RUNNER_EXIT_5M_EMA")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
        ↑ RUNNER EMA
      </span>
    );
  if (outcome === "RUNNER_EXIT_5M_SWING")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
        ↑ RUNNER SWING
      </span>
    );
  if (outcome === "RUNNER_EXIT_5M_REVERSAL")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
        ↑ RUNNER REV
      </span>
    );
  if (outcome === "PARTIAL_BE")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
        ½ PARTIAL+BE
      </span>
    );
  if (outcome === "FULL_SL")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
        ✗ SL HIT
      </span>
    );
  if (outcome === "BE")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
        ≈ BREAK EVEN
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">
      ● OPEN
    </span>
  );
}

// ── Summary card ───────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  color,
  small,
}: {
  label: string;
  value: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-zinc-700 px-5 py-4 shadow-sm">
      <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">
        {label}
      </p>
      <p
        className={`font-bold ${small ? "text-sm" : "text-xl"} ${color ?? "dark:text-white"}`}
      >
        {value}
      </p>
    </div>
  );
}

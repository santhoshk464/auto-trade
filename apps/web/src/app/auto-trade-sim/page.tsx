"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import toast from "react-hot-toast";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Broker {
  id: string;
  name: string;
  brokerType: string;
}

interface SimTrade {
  tradeNo: number;
  optionSymbol: string;
  strike: number;
  optionType: string;
  signalTime: string;
  signalReason: string;
  entry: number;
  sl: number;
  target: number;
  lotSize: number;
  exitReason: string;
  exitTime: string | null;
  exitPrice: number | null;
  pnlPerUnit: number;
  pnl: number;
  pnlFormatted: string;
}

interface DayResult {
  date: string;
  expiry?: string;
  totalSignalsFound: number;
  trades: SimTrade[];
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    totalPnlFormatted: string;
  };
  error?: string;
}

interface WeekEntry {
  week: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  pnlFormatted: string;
  winRate: number;
}

interface MonthEntry {
  month: string;
  monthLabel: string;
  days: number;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  pnlFormatted: string;
  winRate: number;
}

interface RangeResult {
  startDate: string;
  endDate: string;
  days: DayResult[];
  weeklyBreakdown: WeekEntry[];
  monthlyBreakdown: MonthEntry[];
  summary: {
    totalDays: number;
    tradingDays: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalPnlFormatted: string;
    maxDayLoss: number;
    avgPnlPerTradingDay: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISO(d: Date) {
  return d.toISOString().split("T")[0];
}
function startOfWeek(d: Date) {
  const c = new Date(d);
  const day = c.getDay() || 7;
  c.setDate(c.getDate() - day + 1);
  return toISO(c);
}
function startOfMonth(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function endOfMonth(d: Date) {
  return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
function lastMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

function pnlClass(v: number) {
  return v > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : v < 0
      ? "text-red-500 dark:text-red-400"
      : "text-slate-500";
}

function ExitBadge({ reason }: { reason: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    TARGET_HIT: {
      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
      label: "Target Hit",
    },
    SL_HIT: {
      cls: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
      label: "SL Hit",
    },
    BE_HIT: {
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
      label: "BE ↔",
    },
    T1_EOD: {
      cls: "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
      label: "T1 + EOD",
    },
    EOD_CLOSE: {
      cls: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
      label: "EOD Close",
    },
    DATA_ERROR: {
      cls: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
      label: "Data Error",
    },
    OPEN: {
      cls: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
      label: "Still Open",
    },
  };
  // REPLACED_BY_TRADE_N → amber
  if (reason.startsWith("REPLACED_BY_TRADE_")) {
    const n = reason.replace("REPLACED_BY_TRADE_", "");
    return (
      <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
        Replaced by #{n}
      </span>
    );
  }
  const entry = map[reason] ?? {
    cls: "bg-slate-100 text-slate-600",
    label: reason.replace(/_/g, " "),
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${entry.cls}`}
    >
      {entry.label}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AutoTradeSimPage() {
  const today = toISO(new Date());

  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [brokerId, setBrokerId] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RangeResult | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [interval, setInterval] = useState<string>("minute");
  const [slPts, setSlPts] = useState<number>(30);
  const [mode, setMode] = useState<"live" | "historical">("historical");

  // Load brokers on mount
  useEffect(() => {
    apiFetch<{ brokers: Broker[] }>("/brokers")
      .then((res) => {
        if (res.brokers?.length) {
          setBrokers(res.brokers);
          setBrokerId(res.brokers[0].id);
        }
      })
      .catch(() => toast.error("Failed to load brokers"));
  }, []);

  // Quick-select helpers
  const setRange = useCallback((start: string, end: string) => {
    setStartDate(start);
    setEndDate(end);
    setResult(null);
  }, []);

  const quickToday = () => setRange(today, today);
  const quickThisWeek = () => setRange(startOfWeek(new Date()), today);
  const quickThisMonth = () => setRange(startOfMonth(new Date()), today);
  const quickLastMonth = () => {
    const { start, end } = lastMonth();
    setRange(start, end);
  };

  const isSingleDay = startDate === endDate;

  // ── Run simulation ──────────────────────────────────────────────────────────
  async function run() {
    if (!brokerId) {
      toast.error("Select a broker first");
      return;
    }
    setLoading(true);
    setResult(null);
    setExpandedDay(null);
    try {
      if (isSingleDay) {
        // Use the single-day endpoint and wrap in range shape
        const day = await apiFetch<DayResult>(
          `/kite/simulate-auto-trade?brokerId=${brokerId}&date=${startDate}&interval=${interval}&slPts=${slPts}&mode=${mode}`,
        );
        const synth: RangeResult = {
          startDate,
          endDate,
          days: [day],
          weeklyBreakdown: [],
          monthlyBreakdown: [],
          summary: {
            totalDays: 1,
            tradingDays: day.summary.totalTrades > 0 ? 1 : 0,
            totalTrades: day.summary.totalTrades,
            wins: day.summary.wins,
            losses: day.summary.losses,
            winRate:
              day.summary.totalTrades > 0
                ? Math.round(
                    (day.summary.wins / day.summary.totalTrades) * 10000,
                  ) / 100
                : 0,
            totalPnl: day.summary.totalPnl,
            totalPnlFormatted: day.summary.totalPnlFormatted,
            maxDayLoss: day.summary.totalPnl < 0 ? day.summary.totalPnl : 0,
            avgPnlPerTradingDay:
              day.summary.totalTrades > 0 ? day.summary.totalPnl : 0,
          },
        };
        setResult(synth);
        setExpandedDay(startDate);
      } else {
        const data = await apiFetch<RangeResult>(
          `/kite/simulate-auto-trade-range?brokerId=${brokerId}&startDate=${startDate}&endDate=${endDate}&interval=${interval}&slPts=${slPts}&mode=${mode}`,
        );
        setResult(data);
        // Auto-expand first day with trades
        const first = data.days.find((d) => d.summary.totalTrades > 0);
        if (first) setExpandedDay(first.date);
      }
    } catch (err: unknown) {
      toast.error(
        (err as Error)?.message ?? "Simulation failed — check console",
      );
    } finally {
      setLoading(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition"
          >
            ←
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              Auto Trade Simulator
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Paper-trade the DAY_SELLING strategy on historical data
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm">
          <div className="flex flex-wrap items-end gap-4">
            {/* Broker */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Broker
              </label>
              <select
                value={brokerId}
                onChange={(e) => setBrokerId(e.target.value)}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                {brokers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.brokerType})
                  </option>
                ))}
              </select>
            </div>

            {/* Start date */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                From
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setResult(null);
                }}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            {/* End date */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                To
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setResult(null);
                }}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            {/* Quick selects */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Quick select
              </label>
              <div className="flex gap-2">
                {[
                  { label: "Today", fn: quickToday },
                  { label: "This Week", fn: quickThisWeek },
                  { label: "This Month", fn: quickThisMonth },
                  { label: "Last Month", fn: quickLastMonth },
                ].map(({ label, fn }) => (
                  <button
                    key={label}
                    onClick={fn}
                    className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Timeframe selector */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Timeframe
              </label>
              <div className="flex gap-1">
                {[
                  { label: "1m", value: "minute" },
                  { label: "3m", value: "3minute" },
                  { label: "5m", value: "5minute" },
                  { label: "15m", value: "15minute" },
                  { label: "30m", value: "30minute" },
                  { label: "1h", value: "60minute" },
                ].map(({ label, value }) => (
                  <button
                    key={value}
                    onClick={() => setInterval(value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      interval === value
                        ? "bg-cyan-600 border-cyan-600 text-white"
                        : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* SL Points */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                SL Points
              </label>
              <div className="flex gap-1">
                {[20, 30, 40, 50, 60].map((pts) => (
                  <button
                    key={pts}
                    onClick={() => setSlPts(pts)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      slPts === pts
                        ? "bg-cyan-600 border-cyan-600 text-white"
                        : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    }`}
                  >
                    {pts}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Mode
              </label>
              <div className="flex items-center gap-4 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2">
                {(["historical", "live"] as const).map((m) => (
                  <label
                    key={m}
                    className="flex items-center gap-2 cursor-pointer select-none"
                  >
                    <input
                      type="radio"
                      name="simMode"
                      value={m}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="accent-cyan-600"
                    />
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      {m === "live" ? "Live data" : "Historical"}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Run button */}
            <button
              onClick={run}
              disabled={loading || !brokerId}
              className="ml-auto rounded-lg bg-cyan-600 px-6 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Running…" : "Run Simulation"}
            </button>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-cyan-500" />
              <p className="text-sm text-slate-500">
                Running simulation… this may take a while for large date ranges
              </p>
            </div>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-6">
            {/* ── Summary cards ── */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryCard
                label="Total P&L"
                value={result.summary.totalPnlFormatted}
                sub={`${result.summary.tradingDays} trading day${result.summary.tradingDays !== 1 ? "s" : ""}`}
                highlight={result.summary.totalPnl}
              />
              <SummaryCard
                label="Total Trades"
                value={String(result.summary.totalTrades)}
                sub={`${result.summary.wins}W / ${result.summary.losses}L`}
              />
              <SummaryCard
                label="Win Rate"
                value={`${result.summary.winRate}%`}
                sub={`${result.summary.totalTrades} trades`}
                highlight={result.summary.winRate - 50}
              />
              <SummaryCard
                label="Avg / Trading Day"
                value={`₹${result.summary.avgPnlPerTradingDay.toFixed(0)}`}
                sub={`Max loss ₹${Math.abs(result.summary.maxDayLoss).toFixed(0)}`}
                highlight={result.summary.avgPnlPerTradingDay}
              />
            </div>

            {/* ── Daily results ── */}
            <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
              <div className="border-b border-slate-100 dark:border-slate-800 px-6 py-4">
                <h2 className="font-semibold text-slate-800 dark:text-white">
                  Daily Breakdown
                </h2>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {result.days.map((day) => (
                  <DayRow
                    key={day.date}
                    day={day}
                    expanded={expandedDay === day.date}
                    onToggle={() =>
                      setExpandedDay(expandedDay === day.date ? null : day.date)
                    }
                  />
                ))}
                {result.days.length === 0 && (
                  <p className="py-12 text-center text-sm text-slate-400">
                    No trading days in this range
                  </p>
                )}
              </div>
            </section>

            {/* ── Weekly breakdown (hidden for single day) ── */}
            {result.weeklyBreakdown.length > 0 && (
              <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 dark:border-slate-800 px-6 py-4">
                  <h2 className="font-semibold text-slate-800 dark:text-white">
                    Weekly Breakdown
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800 text-left text-xs text-slate-500 uppercase tracking-wide">
                        <th className="px-6 py-3">Week</th>
                        <th className="px-4 py-3 text-right">Trades</th>
                        <th className="px-4 py-3 text-right">W / L</th>
                        <th className="px-4 py-3 text-right">Win Rate</th>
                        <th className="px-6 py-3 text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {result.weeklyBreakdown.map((w) => (
                        <tr
                          key={w.week}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <td className="px-6 py-3 font-mono text-slate-700 dark:text-slate-300">
                            {w.week}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">
                            {w.trades}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">
                            {w.wins}W / {w.losses}L
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">
                            {w.winRate}%
                          </td>
                          <td
                            className={`px-6 py-3 text-right font-semibold ${pnlClass(w.pnl)}`}
                          >
                            {w.pnlFormatted}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ── Monthly breakdown ── */}
            {result.monthlyBreakdown.length > 0 && (
              <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 dark:border-slate-800 px-6 py-4">
                  <h2 className="font-semibold text-slate-800 dark:text-white">
                    Monthly Breakdown
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800 text-left text-xs text-slate-500 uppercase tracking-wide">
                        <th className="px-6 py-3">Month</th>
                        <th className="px-4 py-3 text-right">Days</th>
                        <th className="px-4 py-3 text-right">Trades</th>
                        <th className="px-4 py-3 text-right">W / L</th>
                        <th className="px-4 py-3 text-right">Win Rate</th>
                        <th className="px-6 py-3 text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {result.monthlyBreakdown.map((m) => (
                        <tr
                          key={m.month}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <td className="px-6 py-3 text-slate-700 dark:text-slate-300 font-medium">
                            {m.monthLabel}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">
                            {m.days}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">
                            {m.trades}
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">
                            {m.wins}W / {m.losses}L
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400">
                            {m.winRate}%
                          </td>
                          <td
                            className={`px-6 py-3 text-right font-semibold ${pnlClass(m.pnl)}`}
                          >
                            {m.pnlFormatted}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: number;
}) {
  const color =
    highlight === undefined
      ? "text-slate-900 dark:text-white"
      : highlight > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : highlight < 0
          ? "text-red-500 dark:text-red-400"
          : "text-slate-900 dark:text-white";
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function DayRow({
  day,
  expanded,
  onToggle,
}: {
  day: DayResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasError = !!day.error;
  const hasTrades = day.summary.totalTrades > 0;
  const pnl = day.summary.totalPnl;

  return (
    <div>
      {/* Row header */}
      <button
        onClick={hasTrades || hasError ? onToggle : undefined}
        className={`w-full flex items-center justify-between px-6 py-3 text-left transition ${
          hasTrades || hasError
            ? "hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
            : "cursor-default"
        }`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              hasError
                ? "bg-slate-400"
                : hasTrades
                  ? pnl >= 0
                    ? "bg-emerald-500"
                    : "bg-red-500"
                  : "bg-slate-200 dark:bg-slate-700"
            }`}
          />
          <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
            {day.date}
          </span>
          {hasError && (
            <span className="text-xs text-slate-400 italic">{day.error}</span>
          )}
          {!hasError && !hasTrades && (
            <span className="text-xs text-slate-400">No signals</span>
          )}
          {hasTrades && (
            <span className="text-xs text-slate-500">
              {day.summary.totalTrades} trade
              {day.summary.totalTrades !== 1 ? "s" : ""}
              {day.totalSignalsFound > 0 &&
                ` · ${day.totalSignalsFound} signals`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {hasTrades && (
            <>
              <span className="text-xs text-slate-500">
                {day.summary.wins}W {day.summary.losses}L
              </span>
              <span className={`text-sm font-semibold ${pnlClass(pnl)}`}>
                {day.summary.totalPnlFormatted}
              </span>
            </>
          )}
          {(hasTrades || hasError) && (
            <span className="text-slate-400 text-xs">
              {expanded ? "▲" : "▼"}
            </span>
          )}
        </div>
      </button>

      {/* Expanded trade details */}
      {expanded && hasTrades && (
        <div className="bg-slate-50 dark:bg-slate-800/40 px-6 pb-4 pt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 uppercase tracking-wide border-b border-slate-200 dark:border-slate-700">
                <th className="pb-2 pr-4">#</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Signal</th>
                <th className="pb-2 pr-4">Entry</th>
                <th className="pb-2 pr-4">SL</th>
                <th className="pb-2 pr-4">Target</th>
                <th className="pb-2 pr-4">Exit</th>
                <th className="pb-2 pr-4">Exit Price</th>
                <th className="pb-2 pr-4">Reason</th>
                <th className="pb-2 text-right">P&L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {day.trades.map((t) => (
                <tr key={t.tradeNo} className="align-top">
                  <td className="py-2 pr-4 text-slate-500">{t.tradeNo}</td>
                  <td className="py-2 pr-4 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {t.optionSymbol}
                  </td>
                  <td className="py-2 pr-4 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {t.signalTime}
                  </td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                    ₹{t.entry}
                  </td>
                  <td className="py-2 pr-4 text-red-500">₹{t.sl}</td>
                  <td className="py-2 pr-4 text-emerald-600">₹{t.target}</td>
                  <td className="py-2 pr-4 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {t.exitReason === "OPEN" ? (
                      <span className="text-slate-400">-</span>
                    ) : (
                      (t.exitTime ?? "-")
                    )}
                  </td>
                  <td className="py-2 pr-4 text-slate-700 dark:text-slate-300">
                    {t.exitReason === "OPEN" ? (
                      <span className="text-purple-500 text-xs">
                        LTP ₹{t.exitPrice}
                      </span>
                    ) : t.exitPrice != null ? (
                      `₹${t.exitPrice}`
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <ExitBadge reason={t.exitReason} />
                  </td>
                  <td
                    className={`py-2 text-right font-semibold ${pnlClass(t.pnl)}`}
                  >
                    {t.exitReason === "OPEN" ? (
                      <span className="text-xs">
                        {t.pnlFormatted}{" "}
                        <span className="text-slate-400 font-normal">
                          (unrealized)
                        </span>
                      </span>
                    ) : (
                      t.pnlFormatted
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

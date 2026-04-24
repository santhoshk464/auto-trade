"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import toast from "react-hot-toast";
import { createChart } from "lightweight-charts";
import type { IChartApi } from "lightweight-charts";

// ── Types ──────────────────────────────────────────────────────────────────
interface InstrumentSummary {
  id: number;
  tradingsymbol: string;
  instrumentToken: number;
  interval: string;
  savedAt: string;
  candleCount: number;
}

interface SummaryResponse {
  date: string;
  count: number;
  instruments: InstrumentSummary[];
  availableDates: string[];
}

interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleResponse {
  cached: boolean;
  tradingsymbol: string;
  date: string;
  interval: string;
  savedAt: string;
  candles: Candle[];
}

// One row per unique tradingsymbol — only needs to know if 1m is cached
interface GroupedInstrument {
  tradingsymbol: string;
  instrumentToken: number;
  savedAt: string;
  candleCount: number;
}

// ── Timeframe config ──────────────────────────────────────────────────────
// All timeframes are derived client-side from 1m candles (exactly how Kite/TradingView work)
const TIMEFRAMES: { label: string; minutes: number }[] = [
  { label: "1m", minutes: 1 },
  { label: "3m", minutes: 3 },
  { label: "5m", minutes: 5 },
  { label: "10m", minutes: 10 },
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
];

// ── Candle aggregation ────────────────────────────────────────────────────
/**
 * Aggregates 1-minute candles into any N-minute timeframe.
 * Identical to how Kite / TradingView derive higher timeframes on the fly.
 * Each bucket aligns to IST session start (09:15).
 */
function aggregateCandles(oneMin: Candle[], minutes: number): Candle[] {
  if (minutes <= 1 || oneMin.length === 0) return oneMin;

  // Session start anchor: 09:15 IST = 03:45 UTC
  const SESSION_START_MINUTES = 9 * 60 + 15; // 555 minutes since midnight IST

  const buckets = new Map<number, Candle[]>();

  for (const c of oneMin) {
    const ts = new Date(c.date);
    // Convert to IST minutes-since-midnight
    const istMs = ts.getTime() + 5.5 * 3600 * 1000;
    const istDate = new Date(istMs);
    const istMinutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
    // Offset from session start, bucket index
    const offset = istMinutes - SESSION_START_MINUTES;
    const bucketIdx = Math.floor(offset / minutes);
    // Use epoch seconds of bucket start as key
    const bucketStartMin = SESSION_START_MINUTES + bucketIdx * minutes;
    // Reconstruct UTC epoch for this bucket start
    const dayStartUtc = new Date(istDate);
    dayStartUtc.setUTCHours(0, 0, 0, 0);
    const bucketEpoch =
      dayStartUtc.getTime() + bucketStartMin * 60 * 1000 - 5.5 * 3600 * 1000;

    if (!buckets.has(bucketEpoch)) buckets.set(bucketEpoch, []);
    buckets.get(bucketEpoch)!.push(c);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([epoch, cs]) => ({
      date: new Date(epoch).toISOString(),
      open: cs[0].open,
      high: Math.max(...cs.map((x) => x.high)),
      low: Math.min(...cs.map((x) => x.low)),
      close: cs[cs.length - 1].close,
      volume: cs.reduce((s, x) => s + x.volume, 0),
    }));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Deduplicate by tradingsymbol — keep only the 1m entry info for display */
function groupInstruments(rows: InstrumentSummary[]): GroupedInstrument[] {
  const map = new Map<string, GroupedInstrument>();
  for (const r of rows) {
    if (r.interval !== "minute") continue; // only 1m is the base
    map.set(r.tradingsymbol, {
      tradingsymbol: r.tradingsymbol,
      instrumentToken: r.instrumentToken,
      savedAt: r.savedAt,
      candleCount: r.candleCount,
    });
  }
  return Array.from(map.values());
}

// ── Chart component ────────────────────────────────────────────────────────
function CandleChart({ candles }: { candles: Candle[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return;

    const container = chartRef.current;
    if (chartInstanceRef.current) {
      chartInstanceRef.current.remove();
      chartInstanceRef.current = null;
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 360,
      layout: {
        background: { color: "transparent" },
        textColor: "#71717a",
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: "#3f3f46" },
      timeScale: { borderColor: "#3f3f46", timeVisible: true },
    });

    chartInstanceRef.current = chart;

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    const data = candles.map((c) => ({
      time: Math.floor(new Date(c.date).getTime() / 1000) as any,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    series.setData(data);
    chart.timeScale().fitContent();

    const handleResize = () => {
      chart.applyOptions({ width: container.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartInstanceRef.current = null;
    };
  }, [candles]);

  return <div ref={chartRef} className="w-full" />;
}

// ── Spinner ───────────────────────────────────────────────────────────────
function Spinner({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
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
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8H4z"
      />
    </svg>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function CandleDataPage() {
  const [selectedDate, setSelectedDate] = useState(todayIST());
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [saving, setSaving] = useState(false);

  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  // Active timeframe in minutes (1 = 1m, 5 = 5m, etc.)
  const [activeMinutes, setActiveMinutes] = useState(1);

  // Raw 1m candles fetched from DB — all timeframes derived from this
  const [rawCandles, setRawCandles] = useState<Candle[]>([]);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [viewMode, setViewMode] = useState<"chart" | "table">("chart");

  const availableDates = summary?.availableDates ?? [];
  const grouped = useMemo(
    () => groupInstruments(summary?.instruments ?? []),
    [summary],
  );
  const activeGroup = grouped.find((g) => g.tradingsymbol === selectedSymbol);

  // Aggregate 1m candles into the active timeframe — pure CPU, instant
  const displayCandles = useMemo(
    () => aggregateCandles(rawCandles, activeMinutes),
    [rawCandles, activeMinutes],
  );

  // Fetch summary when date changes
  useEffect(() => {
    fetchSummary(selectedDate);
    setSelectedSymbol(null);
    setRawCandles([]);
  }, [selectedDate]);

  // Auto-select the latest available date if today has no data
  useEffect(() => {
    if (!summary) return;
    if (summary.count === 0 && summary.availableDates.length > 0) {
      setSelectedDate(summary.availableDates[0]);
    }
  }, [summary]);

  // Fetch 1m candles when symbol changes
  useEffect(() => {
    if (!selectedSymbol) return;
    loadCandles(selectedSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  async function fetchSummary(date: string) {
    setLoadingSummary(true);
    try {
      const data = await apiFetch<SummaryResponse>(
        `/kite/candle-cache-summary?date=${date}`,
      );
      setSummary(data);
    } catch (err: any) {
      toast.error(err.message || "Failed to load summary");
    } finally {
      setLoadingSummary(false);
    }
  }

  // Always fetch the 1m base candles; higher timeframes are aggregated client-side
  async function loadCandles(symbol: string) {
    setLoadingCandles(true);
    setRawCandles([]);
    try {
      const data = await apiFetch<CandleResponse>(
        `/kite/candle-cache?tradingsymbol=${encodeURIComponent(symbol)}&date=${selectedDate}&interval=minute`,
      );
      setRawCandles(data.candles ?? []);
    } catch (err: any) {
      toast.error(err.message || "Failed to load candles");
    } finally {
      setLoadingCandles(false);
    }
  }

  async function triggerSave() {
    if (saving) return;
    setSaving(true);
    const tid = toast.loading(`Saving EOD candles for ${selectedDate}…`);
    try {
      const res: any = await apiFetch("/kite/save-candle-cache", {
        method: "POST",
        body: JSON.stringify({ date: selectedDate }),
      });
      toast.success(res.message ?? "Save complete", { id: tid });
      fetchSummary(selectedDate);
    } catch (err: any) {
      toast.error(err.message || "Save failed", { id: tid });
    } finally {
      setSaving(false);
    }
  }

  const activeTf =
    TIMEFRAMES.find((t) => t.minutes === activeMinutes) ?? TIMEFRAMES[0];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* ── Header ── */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-7xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
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
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100">
                Candle History
              </h1>
              <p className="text-xs text-zinc-500">
                EOD candle data saved in local DB
              </p>
            </div>
          </div>

          <button
            onClick={triggerSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
          >
            {saving ? (
              <Spinner className="w-4 h-4 text-white" />
            ) : (
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
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
                />
              </svg>
            )}
            Save EOD for {selectedDate}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {/* ── Date picker ── */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-zinc-400 shrink-0">Date:</label>
              <input
                type="date"
                value={selectedDate}
                min={availableDates.length > 0 ? availableDates[availableDates.length - 1] : undefined}
                max={availableDates.length > 0 ? availableDates[0] : todayIST()}
                onChange={(e) => {
                  const picked = e.target.value;
                  if (!picked) return;
                  if (availableDates.length === 0 || availableDates.includes(picked)) {
                    setSelectedDate(picked);
                  } else {
                    const nearest = availableDates.reduce((prev, cur) =>
                      Math.abs(new Date(cur).getTime() - new Date(picked).getTime()) <
                      Math.abs(new Date(prev).getTime() - new Date(picked).getTime())
                        ? cur
                        : prev,
                    );
                    setSelectedDate(nearest);
                    toast(`No data for ${picked} — switched to ${nearest}`, { icon: "📅" });
                  }
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            {loadingSummary && <Spinner className="w-4 h-4 text-zinc-500" />}
            {!loadingSummary && summary && summary.count === 0 && (
              <span className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-full px-3 py-1">
                No candle data saved for {selectedDate}
              </span>
            )}
          </div>

          {/* Quick-jump chips — only dates that have saved data */}
          {availableDates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-600 shrink-0">Saved:</span>
              {availableDates.map((d) => (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  className={`rounded-full px-3 py-0.5 text-xs font-medium transition-colors ${
                    d === selectedDate
                      ? "bg-amber-500 text-zinc-900"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Content: instrument list + chart ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Instrument list — one row per symbol */}
          <div className="lg:col-span-1">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-200">
                  Instruments
                </h2>
                <span className="text-xs text-zinc-500">
                  {grouped.length} symbols
                </span>
              </div>

              {grouped.length === 0 && !loadingSummary ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-zinc-500">
                    No candle data for {selectedDate}
                  </p>
                  <p className="text-xs text-zinc-600 mt-1">
                    Click &quot;Save EOD&quot; to fetch from Kite
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {grouped.map((g) => (
                    <button
                      key={g.tradingsymbol}
                      onClick={() => setSelectedSymbol(g.tradingsymbol)}
                      className={`w-full text-left px-4 py-3 hover:bg-zinc-800/70 transition-colors border-l-2 ${
                        selectedSymbol === g.tradingsymbol
                          ? "bg-zinc-800 border-l-amber-500"
                          : "border-l-transparent"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-zinc-200">
                          {g.tradingsymbol}
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            g.tradingsymbol.endsWith("CE")
                              ? "bg-green-900/60 text-green-400"
                              : g.tradingsymbol.endsWith("PE")
                                ? "bg-red-900/60 text-red-400"
                                : "bg-zinc-700 text-zinc-300"
                          }`}
                        >
                          {g.tradingsymbol.endsWith("CE")
                            ? "CE"
                            : g.tradingsymbol.endsWith("PE")
                              ? "PE"
                              : ""}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                        <span>{g.candleCount} candles</span>
                        <span>·</span>
                        <span>{fmtDateTime(g.savedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Candle viewer ── */}
          <div className="lg:col-span-2">
            {!selectedSymbol ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 flex items-center justify-center h-64">
                <div className="text-center">
                  <svg
                    className="w-10 h-10 mx-auto text-zinc-700 mb-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
                    />
                  </svg>
                  <p className="text-sm text-zinc-500">
                    Select an instrument to view candles
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
                {/* ── Toolbar — TradingView style ── */}
                <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-semibold text-zinc-200">
                      {selectedSymbol}
                    </span>

                    {/* Timeframe pills — all derived from 1m, no extra API calls */}
                    <div className="flex items-center gap-0.5 bg-zinc-800 rounded-lg p-0.5">
                      {TIMEFRAMES.map(({ label, minutes }) => (
                        <button
                          key={minutes}
                          onClick={() => setActiveMinutes(minutes)}
                          disabled={rawCandles.length === 0}
                          className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all ${
                            activeMinutes === minutes && rawCandles.length > 0
                              ? "bg-amber-500 text-zinc-900 shadow"
                              : rawCandles.length === 0
                                ? "text-zinc-600 cursor-not-allowed"
                                : "text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {activeGroup &&
                      !loadingCandles &&
                      rawCandles.length > 0 && (
                        <span className="text-[11px] text-zinc-500">
                          {displayCandles.length} candles
                          {activeMinutes > 1 && (
                            <span className="ml-1 text-zinc-600">
                              (from {rawCandles.length} × 1m)
                            </span>
                          )}
                          {" · "}
                          {fmtDateTime(activeGroup.savedAt)}
                        </span>
                      )}
                  </div>

                  <div className="flex gap-0.5 bg-zinc-800 rounded-lg p-0.5">
                    <button
                      onClick={() => setViewMode("chart")}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        viewMode === "chart"
                          ? "bg-zinc-600 text-zinc-100 shadow"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Chart
                    </button>
                    <button
                      onClick={() => setViewMode("table")}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        viewMode === "table"
                          ? "bg-zinc-600 text-zinc-100 shadow"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Table
                    </button>
                  </div>
                </div>

                {loadingCandles && (
                  <div className="flex items-center justify-center h-64">
                    <Spinner className="w-6 h-6 text-zinc-500" />
                  </div>
                )}

                {!loadingCandles &&
                  displayCandles.length > 0 &&
                  viewMode === "chart" && (
                    <div className="p-2">
                      <CandleChart candles={displayCandles} />
                    </div>
                  )}

                {!loadingCandles &&
                  displayCandles.length > 0 &&
                  viewMode === "table" && (
                    <div className="overflow-auto max-h-105">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
                          <tr>
                            <th className="px-3 py-2 text-left text-zinc-500 font-medium">
                              Time
                            </th>
                            <th className="px-3 py-2 text-right text-zinc-500 font-medium">
                              Open
                            </th>
                            <th className="px-3 py-2 text-right text-zinc-500 font-medium">
                              High
                            </th>
                            <th className="px-3 py-2 text-right text-zinc-500 font-medium">
                              Low
                            </th>
                            <th className="px-3 py-2 text-right text-zinc-500 font-medium">
                              Close
                            </th>
                            <th className="px-3 py-2 text-right text-zinc-500 font-medium">
                              Volume
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                          {displayCandles.map((c, i) => {
                            const bullish = c.close >= c.open;
                            return (
                              <tr
                                key={i}
                                className="hover:bg-zinc-800/40 transition-colors"
                              >
                                <td className="px-3 py-1.5 text-zinc-400 font-mono whitespace-nowrap">
                                  {new Date(c.date).toLocaleTimeString(
                                    "en-IN",
                                    {
                                      timeZone: "Asia/Kolkata",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      hour12: false,
                                    },
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right text-zinc-300 tabular-nums">
                                  {c.open.toFixed(2)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-green-400 tabular-nums">
                                  {c.high.toFixed(2)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-red-400 tabular-nums">
                                  {c.low.toFixed(2)}
                                </td>
                                <td
                                  className={`px-3 py-1.5 text-right font-semibold tabular-nums ${bullish ? "text-green-400" : "text-red-400"}`}
                                >
                                  {c.close.toFixed(2)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-zinc-500 tabular-nums">
                                  {c.volume.toLocaleString("en-IN")}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                {!loadingCandles && rawCandles.length === 0 && (
                  <div className="p-8 text-center text-sm text-zinc-500">
                    No candles found
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

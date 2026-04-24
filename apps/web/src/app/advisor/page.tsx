"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import toast from "react-hot-toast";
import { io, Socket } from "socket.io-client";
import { apiFetch, API_BASE_URL } from "@/lib/api";
import { useMe } from "@/lib/useMe";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdvisorVerdict {
  action: "HOLD" | "CAUTION" | "EXIT_WARNING";
  confidence: number;
  reasons: string[];
  oiTrend:
    | "BEARISH_BUILD"
    | "BEARISH_UNWIND"
    | "BULLISH_BUILD"
    | "BULLISH_UNWIND"
    | "NEUTRAL";
  oiVelocitySpike: boolean;
  orderBookFlipped: boolean;
  absorptionDetected: boolean;
  pcr: number | null;
  pcrTrend: "RISING" | "FALLING" | "FLAT" | "UNKNOWN";
  latestOI: number;
  latestLTP: number;
}

interface ActiveTrade {
  liveTradeId: string;
  verdict: AdvisorVerdict | null;
}

interface PatternEvent {
  id: string;
  tradeDate: string;
  instrumentToken: number;
  symbol: string;
  patternType: string;
  ltpAtDetection: number;
  oiAtDetection: number;
  ltpAfter5m: number | null;
  ltpAfter15m: number | null;
  wasCorrect: boolean | null;
  detectedAt: string;
}

interface OiSnapshot {
  id: string;
  tradeDate: string;
  symbol: string;
  strike: number;
  expiryDate: string;
  ceOI: number;
  peOI: number;
  pcr: number;
  ceLTP: number;
  peLTP: number;
  createdAt: string;
}

interface TradeOutcome {
  id: string;
  tradeDate: string;
  symbol: string;
  optionSymbol: string;
  direction: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number | null;
  entryOI: number;
  exitOI: number | null;
  entryPCR: number | null;
  exitPCR: number | null;
  entryOIVelocity: number | null;
  entryBuyQty: number | null;
  entrySellQty: number | null;
  outcome: string | null;
  pnl: number | null;
  holdMinutes: number | null;
  exitReason: string | null;
  createdAt: string;
}

interface PatternAccuracyRow {
  patternType: string;
  total: number;
  correct: number;
  accuracy: number;
}

interface KiteLeg {
  symbol: string;
  strike: number;
  token: number;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  ltpChange: number;
  oi: number;
  oiDayHigh?: number;
  oiDayLow?: number;
  oiDayChange?: number;
  volume?: number;
  buyQty?: number;
  sellQty?: number;
  buySellRatio?: number | null;
}

interface KiteStrikeResult {
  symbol: string;
  date: string;
  expiry: string;
  isExpiryDay?: boolean;
  atmStrike: number;
  niftySpotAtOpen: number;
  brokerName?: string;
  brokerId?: string;
  ce?: KiteLeg;
  pe?: KiteLeg;
  analysis?: {
    pcr: number;
    pcrSignal: string;
    verdict: string;
    score: number;
    reasons: string[];
  };
  tradeAdvice?: {
    ceSell: {
      action: "HOLD" | "CAUTION" | "EXIT_WARNING";
      reasons: string[];
      confidence: number;
    };
    peSell: {
      action: "HOLD" | "CAUTION" | "EXIT_WARNING";
      reasons: string[];
      confidence: number;
    };
    ceBuy: {
      action: "HOLD" | "CAUTION" | "EXIT_WARNING";
      reasons: string[];
      confidence: number;
    };
    peBuy: {
      action: "HOLD" | "CAUTION" | "EXIT_WARNING";
      reasons: string[];
      confidence: number;
    };
  };
  entrySuggestions?: {
    ce: {
      sellAt: number;
      sellNow: boolean;
      sellNote: string;
      sellRisk?: string | null;
      buyAt: number;
      buyNow: boolean;
      buyNote: string;
      buyRisk?: string | null;
      open: number;
      dayHigh: number;
      dayLow: number;
      priceInRange: number;
      moveFromOpenPct: number;
    };
    pe: {
      sellAt: number;
      sellNow: boolean;
      sellNote: string;
      sellRisk?: string | null;
      buyAt: number;
      buyNow: boolean;
      buyNote: string;
      buyRisk?: string | null;
      open: number;
      dayHigh: number;
      dayLow: number;
      priceInRange: number;
      moveFromOpenPct: number;
    };
    topTrade: {
      action: string;
      at: number | null;
      atNow: boolean;
      reason: string;
      confidence: "HIGH" | "MEDIUM" | "LOW";
      marketPhase: string;
      riskNote?: string | null;
      alternative?: string | null;
    };
  };
  error?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

interface TickSummary {
  token: number;
  ticks: number;
  firstOI?: number;
  lastOI?: number;
  oiChange?: number;
  minLTP?: number;
  maxLTP?: number;
  firstLTP?: number;
  lastLTP?: number;
  firstTime?: string;
  lastTime?: string;
  totalVolume?: number;
}

interface PcrPoint {
  time: string;
  pcr: number;
  ceOI: number;
  peOI: number;
}

interface HistoricTrade {
  trade: {
    id: string;
    symbol: string;
    optionSymbol: string;
    strike: number;
    optionType: string;
    expiryDate: string;
    strategy: string;
    status: string;
    entryFilledPrice: number | null;
    exitPrice: number | null;
    targetPrice: number | null;
    slPrice: number | null;
    pnl: number | null;
    createdAt: string;
    entryFilledTime: string | null;
    exitTime: string | null;
  };
  strikeSelection: {
    atmStrike: number;
    niftySpotAtOpen: number;
    ceTradingSymbol: string;
    ceStrike: number;
    peTradingSymbol: string;
    peStrike: number;
  } | null;
  tickSummary: TickSummary | null;
  patterns: PatternEvent[];
  pcrHistory: PcrPoint[];
  outcome: TradeOutcome | null;
  retrospectiveVerdict: "PROFITABLE" | "LOSS" | "BREAKEVEN" | "OPEN";
  oiChange: number | null;
  entryOI: number | null;
  exitOI: number | null;
}

type Tab =
  | "active"
  | "patterns"
  | "oi-snapshots"
  | "outcomes"
  | "accuracy"
  | "history";

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function fmt(n: number | null | undefined, dec = 2) {
  if (n == null) return "—";
  return n.toFixed(dec);
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_00_00_000) return (n / 1_00_00_000).toFixed(1) + " Cr";
  if (n >= 1_00_000) return (n / 1_00_000).toFixed(1) + " L";
  return n.toLocaleString("en-IN");
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

// ── Verdict badge ─────────────────────────────────────────────────────────────

const VERDICT_STYLE: Record<string, string> = {
  HOLD: "bg-emerald-100 text-emerald-800 border border-emerald-300",
  CAUTION: "bg-yellow-100 text-yellow-800 border border-yellow-300",
  EXIT_WARNING: "bg-red-100 text-red-800 border border-red-300",
};
const VERDICT_ICON: Record<string, string> = {
  HOLD: "🟢",
  CAUTION: "🟡",
  EXIT_WARNING: "🔴",
};

function VerdictBadge({ action }: { action: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${VERDICT_STYLE[action] ?? "bg-zinc-100 text-zinc-700"}`}
    >
      {VERDICT_ICON[action] ?? "⚪"} {action.replace("_", " ")}
    </span>
  );
}

// ── OI trend badge ────────────────────────────────────────────────────────────

const OI_STYLE: Record<string, string> = {
  BEARISH_BUILD: "bg-red-100 text-red-700",
  BEARISH_UNWIND: "bg-orange-100 text-orange-700",
  BULLISH_BUILD: "bg-emerald-100 text-emerald-700",
  BULLISH_UNWIND: "bg-blue-100 text-blue-700",
  NEUTRAL: "bg-zinc-100 text-zinc-600",
};

function OITrendBadge({ trend }: { trend: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${OI_STYLE[trend] ?? "bg-zinc-100 text-zinc-600"}`}
    >
      {trend.replace("_", " ")}
    </span>
  );
}

// ── Pattern type badge ────────────────────────────────────────────────────────

const PT_STYLE: Record<string, string> = {
  OI_VELOCITY_SPIKE_DROP: "bg-red-100 text-red-700",
  OI_VELOCITY_SPIKE_RISE: "bg-emerald-100 text-emerald-700",
  ABSORPTION: "bg-purple-100 text-purple-700",
  ORDER_BOOK_FLIP_BULLISH: "bg-blue-100 text-blue-700",
  ORDER_BOOK_FLIP_BEARISH: "bg-orange-100 text-orange-700",
};

function PatternBadge({ type }: { type: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${PT_STYLE[type] ?? "bg-zinc-100 text-zinc-600"}`}
    >
      {type.replace(/_/g, " ")}
    </span>
  );
}

// ── PCR trend ─────────────────────────────────────────────────────────────────

function PcrTrend({ trend }: { trend: string }) {
  const icons: Record<string, string> = {
    RISING: "↑",
    FALLING: "↓",
    FLAT: "→",
    UNKNOWN: "?",
  };
  const colors: Record<string, string> = {
    RISING: "text-emerald-600",
    FALLING: "text-red-500",
    FLAT: "text-zinc-500",
    UNKNOWN: "text-zinc-400",
  };
  return (
    <span className={`font-bold ${colors[trend] ?? "text-zinc-500"}`}>
      {icons[trend] ?? "?"} {trend}
    </span>
  );
}

// ── Tab header ────────────────────────────────────────────────────────────────

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-zinc-500 hover:text-zinc-800"
      }`}
    >
      {label}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdvisorPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [tab, setTab] = useState<Tab>("active");
  const [date, setDate] = useState(todayIST());

  // Active trades state
  const [activeTrades, setActiveTrades] = useState<ActiveTrade[]>([]);
  const [loadingActive, setLoadingActive] = useState(false);

  // Patterns state
  const [patterns, setPatterns] = useState<PatternEvent[]>([]);
  const [loadingPatterns, setLoadingPatterns] = useState(false);

  // OI Snapshots state
  const [oiSnapshots, setOiSnapshots] = useState<OiSnapshot[]>([]);
  const [loadingOi, setLoadingOi] = useState(false);
  const [oiSymbol, setOiSymbol] = useState("NIFTY");
  const [oiStrike, setOiStrike] = useState("");
  const [oiExpiry, setOiExpiry] = useState(todayIST());

  // Trade outcomes state
  const [outcomes, setOutcomes] = useState<TradeOutcome[]>([]);
  const [loadingOutcomes, setLoadingOutcomes] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState("ALL");

  // Pattern accuracy state
  const [accuracy, setAccuracy] = useState<PatternAccuracyRow[]>([]);
  const [loadingAccuracy, setLoadingAccuracy] = useState(false);

  // History state
  const [history, setHistory] = useState<HistoricTrade[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);

  // Kite live strike analysis state
  const [kiteAnalysis, setKiteAnalysis] = useState<KiteStrikeResult[]>([]);
  const [loadingKite, setLoadingKite] = useState(false);
  const [socketStatus, setSocketStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [lastPush, setLastPush] = useState<Date | null>(null);
  const socketRef = useRef<Socket | null>(null);
  // Refs so socket listeners always see current values without re-subscribing
  const dateRef = useRef(date);
  const tabRef = useRef(tab);
  useEffect(() => {
    dateRef.current = date;
  }, [date]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadActive = useCallback(async () => {
    setLoadingActive(true);
    try {
      const data = await apiFetch<ActiveTrade[]>("/advisor/active-trades");
      setActiveTrades(data);
    } catch {
      toast.error("Failed to load active trade verdicts");
    } finally {
      setLoadingActive(false);
    }
  }, []);

  const loadPatterns = useCallback(async () => {
    setLoadingPatterns(true);
    try {
      const res = await apiFetch<{ count: number; patterns: PatternEvent[] }>(
        `/advisor/patterns?date=${date}`,
      );
      setPatterns(res.patterns);
    } catch {
      toast.error("Failed to load patterns");
    } finally {
      setLoadingPatterns(false);
    }
  }, [date]);

  const loadOiSnapshots = useCallback(async () => {
    if (!oiStrike) return;
    setLoadingOi(true);
    try {
      const res = await apiFetch<{ count: number; snapshots: OiSnapshot[] }>(
        `/advisor/oi-snapshots?symbol=${oiSymbol}&strike=${oiStrike}&expiry=${oiExpiry}&date=${date}`,
      );
      setOiSnapshots(res.snapshots);
    } catch {
      toast.error("Failed to load OI snapshots");
    } finally {
      setLoadingOi(false);
    }
  }, [oiSymbol, oiStrike, oiExpiry, date]);

  const loadOutcomes = useCallback(async () => {
    setLoadingOutcomes(true);
    try {
      const params = new URLSearchParams({ date });
      if (outcomeFilter !== "ALL") params.set("outcome", outcomeFilter);
      const res = await apiFetch<{
        count: number;
        outcomes: TradeOutcome[];
      }>(`/advisor/trade-outcomes?${params}`);
      setOutcomes(res.outcomes);
    } catch {
      toast.error("Failed to load trade outcomes");
    } finally {
      setLoadingOutcomes(false);
    }
  }, [date, outcomeFilter]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setLoadingKite(true);
    try {
      const [histRes, kiteRes] = await Promise.allSettled([
        apiFetch<{ date: string; count: number; trades: HistoricTrade[] }>(
          `/advisor/historic-analysis?date=${date}`,
        ),
        apiFetch<{ date: string; count: number; results: KiteStrikeResult[] }>(
          `/advisor/kite-strike-analysis?date=${date}`,
        ),
      ]);
      if (histRes.status === "fulfilled") setHistory(histRes.value.trades);
      else setHistory([]);
      if (kiteRes.status === "fulfilled")
        setKiteAnalysis(kiteRes.value.results);
      else {
        toast.error("Kite strike analysis failed");
        setKiteAnalysis([]);
      }
    } catch {
      toast.error("Failed to load historic analysis");
    } finally {
      setLoadingHistory(false);
      setLoadingKite(false);
    }
  }, [date]);

  const loadAccuracy = useCallback(async () => {
    setLoadingAccuracy(true);
    try {
      const res = await apiFetch<{
        totalPatterns: number;
        stats: Record<
          string,
          { total: number; correct: number; accuracy: number }
        >;
      }>("/advisor/pattern-accuracy");
      const rows: PatternAccuracyRow[] = Object.entries(res.stats ?? {}).map(
        ([patternType, s]) => ({ patternType, ...s }),
      );
      setAccuracy(rows);
    } catch {
      toast.error("Failed to load accuracy stats");
    } finally {
      setLoadingAccuracy(false);
    }
  }, []);

  // Silent Kite-only refresh (no loading spinner flash — used by socket push)
  const refreshKiteOnly = useCallback(async (d: string) => {
    try {
      const res = await apiFetch<{
        date: string;
        count: number;
        results: KiteStrikeResult[];
      }>(`/advisor/kite-strike-analysis?date=${d}`);
      setKiteAnalysis(res.results ?? []);
      setLastPush(new Date());
    } catch {
      // silent — don't toast on background refresh
    }
  }, []);

  // ── WebSocket: push updates from server ───────────────────────────────────
  useEffect(() => {
    const socket = io(API_BASE_URL, {
      transports: ["websocket"],
      withCredentials: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on("connect", () => setSocketStatus("connected"));
    socket.on("disconnect", () => setSocketStatus("disconnected"));
    socket.on("connect_error", () => setSocketStatus("disconnected"));

    // Live verdict push: replace entire activeTrades list
    socket.on(
      "advisor:verdicts",
      (payload: { trades: ActiveTrade[]; updatedAt: string }) => {
        setActiveTrades(payload.trades ?? []);
        setLastPush(new Date(payload.updatedAt));
      },
    );

    // Live Kite strike analysis push
    socket.on(
      "advisor:kite-update",
      (payload: { results: KiteStrikeResult[]; updatedAt: string }) => {
        setKiteAnalysis(payload.results ?? []);
        setLastPush(new Date(payload.updatedAt));
      },
    );

    // Tick-by-tick LTP updates for CE/PE tokens subscribed via subscribe-ltp
    socket.on(
      "ltp-update",
      (payload: { updates: Array<{ instrument_token: number; last_price: number }> }) => {
        setKiteAnalysis((prev) =>
          prev.map((item) => {
            let updated = false;
            let ce = item.ce;
            let pe = item.pe;
            for (const tick of payload.updates) {
              if (ce && tick.instrument_token === ce.token) {
                ce = { ...ce, ltp: tick.last_price };
                updated = true;
              }
              if (pe && tick.instrument_token === pe.token) {
                pe = { ...pe, ltp: tick.last_price };
                updated = true;
              }
            }
            return updated ? { ...item, ce, pe } : item;
          }),
        );
        setLastPush(new Date());
      },
    );

    // Server signals Kite data may have changed — silently refetch if on history tab
    socket.on("advisor:refresh", () => {
      if (tabRef.current === "history") {
        refreshKiteOnly(dateRef.current);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Subscribe CE/PE tokens for tick-by-tick LTP updates whenever kiteAnalysis loads
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || kiteAnalysis.length === 0) return;
    // Collect all unique brokerId → tokens mappings
    const brokerTokens = new Map<string, number[]>();
    for (const item of kiteAnalysis) {
      if (!item.brokerId) continue;
      const tokens: number[] = [];
      if (item.ce?.token) tokens.push(item.ce.token);
      if (item.pe?.token) tokens.push(item.pe.token);
      if (tokens.length > 0) {
        const existing = brokerTokens.get(item.brokerId) ?? [];
        brokerTokens.set(item.brokerId, [...existing, ...tokens]);
      }
    }
    // Subscribe each broker's tokens
    for (const [brokerId, instrumentTokens] of brokerTokens) {
      socket.emit("subscribe-ltp", { brokerId, instrumentTokens });
    }
    // Unsubscribe on cleanup (tab change / unmount)
    return () => {
      if (socket.connected) socket.emit("unsubscribe-ltp");
    };
  }, [kiteAnalysis]);

  // Load on tab change
  useEffect(() => {
    if (loading || !user) return;
    if (tab === "active") loadActive();
    if (tab === "patterns") loadPatterns();
    if (tab === "oi-snapshots" && oiStrike) loadOiSnapshots();
    if (tab === "outcomes") loadOutcomes();
    if (tab === "accuracy") loadAccuracy();
    if (tab === "history") loadHistory();
  }, [tab, loading, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback: if no socket push arrives within 90s (e.g. outside market hours or
  // socket drop), still silently refresh the Kite prices every 90s on the history tab.
  useEffect(() => {
    if (tab !== "history") return;
    const id = setInterval(() => refreshKiteOnly(date), 90_000);
    return () => clearInterval(id);
  }, [tab, date, refreshKiteOnly]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* ── Header ── */}
      <header className="border-b bg-white dark:bg-zinc-900 sticky top-0 z-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <div className="font-semibold text-sm dark:text-white">
                AI Agent Advisor
              </div>
              <div className="text-xs text-zinc-400">
                OI · Volume · Order Book · PCR analysis
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border px-2 py-1.5 text-xs dark:bg-zinc-800 dark:border-zinc-700 dark:text-white"
            />
            <button
              onClick={() => {
                if (tab === "active") loadActive();
                if (tab === "patterns") loadPatterns();
                if (tab === "oi-snapshots") loadOiSnapshots();
                if (tab === "outcomes") loadOutcomes();
                if (tab === "accuracy") loadAccuracy();
                if (tab === "history") loadHistory();
              }}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 dark:text-white"
            >
              🔄 Refresh
            </button>
            <Link
              href="/dashboard"
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 dark:text-white"
            >
              ← Dashboard
            </Link>
          </div>
        </div>

        {/* Tab bar */}
        <div className="mx-auto max-w-7xl flex border-t overflow-x-auto dark:border-zinc-800">
          <TabBtn
            label="🟢 Active Verdicts"
            active={tab === "active"}
            onClick={() => setTab("active")}
          />
          <TabBtn
            label="⚡ Patterns"
            active={tab === "patterns"}
            onClick={() => setTab("patterns")}
          />
          <TabBtn
            label="📊 OI Snapshots"
            active={tab === "oi-snapshots"}
            onClick={() => setTab("oi-snapshots")}
          />
          <TabBtn
            label="📋 Trade Outcomes"
            active={tab === "outcomes"}
            onClick={() => setTab("outcomes")}
          />
          <TabBtn
            label="🎯 Pattern Accuracy"
            active={tab === "accuracy"}
            onClick={() => setTab("accuracy")}
          />
          <TabBtn
            label="📅 Historic Analysis"
            active={tab === "history"}
            onClick={() => setTab("history")}
          />
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4 space-y-4">
        {/* ── Tab: Active Verdicts ── */}
        {tab === "active" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
                Live trade verdicts — push updates via WebSocket
              </h2>
              <span className="text-xs text-zinc-400">
                {activeTrades.length} trade(s) under advisory
              </span>
            </div>

            {loadingActive ? (
              <Spinner />
            ) : activeTrades.length === 0 ? (
              <EmptyState
                icon="📭"
                title="No active trades under advisory"
                sub="Verdicts appear here when a live trade becomes ACTIVE and the advisor is connected."
              />
            ) : (
              <div className="space-y-4">
                {activeTrades.map((at) => (
                  <ActiveTradeCard key={at.liveTradeId} data={at} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Patterns ── */}
        {tab === "patterns" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
                Detected OI & Order Book patterns for {date}
              </h2>
              <span className="text-xs text-zinc-400">
                {patterns.length} events
              </span>
            </div>

            {loadingPatterns ? (
              <Spinner />
            ) : patterns.length === 0 ? (
              <EmptyState
                icon="🔍"
                title="No patterns detected"
                sub={`No OI velocity / order book patterns found on ${date}.`}
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Time</th>
                      <th className="px-4 py-2 text-left">Symbol</th>
                      <th className="px-4 py-2 text-left">Pattern</th>
                      <th className="px-4 py-2 text-right">LTP at Detection</th>
                      <th className="px-4 py-2 text-right">LTP +5m</th>
                      <th className="px-4 py-2 text-right">LTP +15m</th>
                      <th className="px-4 py-2 text-right">OI at Detection</th>
                      <th className="px-4 py-2 text-center">Correct?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-zinc-800">
                    {patterns.map((p) => (
                      <tr
                        key={p.id}
                        className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                      >
                        <td className="px-4 py-2 text-zinc-500 text-xs whitespace-nowrap">
                          {fmtTime(p.detectedAt)}
                        </td>
                        <td className="px-4 py-2 font-medium dark:text-white">
                          {p.symbol}
                        </td>
                        <td className="px-4 py-2">
                          <PatternBadge type={p.patternType} />
                        </td>
                        <td className="px-4 py-2 text-right font-mono dark:text-zinc-200">
                          {fmt(p.ltpAtDetection)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono dark:text-zinc-200">
                          {fmt(p.ltpAfter5m)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono dark:text-zinc-200">
                          {fmt(p.ltpAfter15m)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                          {fmtNum(p.oiAtDetection)}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {p.wasCorrect === null ? (
                            <span className="text-zinc-400 text-xs">
                              ⏳ pending
                            </span>
                          ) : p.wasCorrect ? (
                            <span className="text-emerald-600 font-bold">
                              ✓ Yes
                            </span>
                          ) : (
                            <span className="text-red-500 font-bold">✗ No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: OI Snapshots ── */}
        {tab === "oi-snapshots" && (
          <div className="space-y-3">
            {/* Controls */}
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Symbol
                </label>
                <input
                  value={oiSymbol}
                  onChange={(e) => setOiSymbol(e.target.value.toUpperCase())}
                  placeholder="NIFTY"
                  className="rounded-md border px-2 py-1.5 text-sm w-24 dark:bg-zinc-800 dark:border-zinc-700 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Strike
                </label>
                <input
                  value={oiStrike}
                  onChange={(e) => setOiStrike(e.target.value)}
                  placeholder="24500"
                  className="rounded-md border px-2 py-1.5 text-sm w-24 dark:bg-zinc-800 dark:border-zinc-700 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Expiry
                </label>
                <input
                  type="date"
                  value={oiExpiry}
                  onChange={(e) => setOiExpiry(e.target.value)}
                  className="rounded-md border px-2 py-1.5 text-sm dark:bg-zinc-800 dark:border-zinc-700 dark:text-white"
                />
              </div>
              <button
                onClick={loadOiSnapshots}
                disabled={!oiStrike}
                className="rounded-md bg-blue-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                Load
              </button>
            </div>

            {loadingOi ? (
              <Spinner />
            ) : !oiStrike ? (
              <EmptyState
                icon="📊"
                title="Enter strike to load PCR history"
                sub="Enter symbol, strike and expiry above then click Load."
              />
            ) : oiSnapshots.length === 0 ? (
              <EmptyState
                icon="📊"
                title="No OI snapshots found"
                sub={`No PCR data for ${oiSymbol} ${oiStrike} on ${date}.`}
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Time</th>
                      <th className="px-4 py-2 text-right">CE OI</th>
                      <th className="px-4 py-2 text-right">PE OI</th>
                      <th className="px-4 py-2 text-right">PCR</th>
                      <th className="px-4 py-2 text-right">CE LTP</th>
                      <th className="px-4 py-2 text-right">PE LTP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-zinc-800">
                    {oiSnapshots.map((s, i) => {
                      const prevPcr = i > 0 ? oiSnapshots[i - 1].pcr : null;
                      const pcrUp = prevPcr !== null ? s.pcr > prevPcr : null;
                      return (
                        <tr
                          key={s.id}
                          className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                        >
                          <td className="px-4 py-2 text-zinc-500 text-xs whitespace-nowrap">
                            {fmtTime(s.createdAt)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                            {fmtNum(s.ceOI)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                            {fmtNum(s.peOI)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-semibold dark:text-white">
                            <span
                              className={
                                pcrUp === null
                                  ? ""
                                  : pcrUp
                                    ? "text-emerald-600"
                                    : "text-red-500"
                              }
                            >
                              {pcrUp === true
                                ? "↑ "
                                : pcrUp === false
                                  ? "↓ "
                                  : ""}
                              {fmt(s.pcr, 3)}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right font-mono dark:text-zinc-200">
                            {fmt(s.ceLTP)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono dark:text-zinc-200">
                            {fmt(s.peLTP)}
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

        {/* ── Tab: Trade Outcomes ── */}
        {tab === "outcomes" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
                ML Training Dataset — per-trade OI context
              </h2>
              <div className="flex gap-1.5">
                {["ALL", "TARGET_HIT", "SL_HIT", "MANUAL_EXIT", "OPEN"].map(
                  (o) => (
                    <button
                      key={o}
                      onClick={() => {
                        setOutcomeFilter(o);
                        setTimeout(loadOutcomes, 0);
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                        outcomeFilter === o
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-zinc-600 border-zinc-300 hover:border-blue-400 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      {o === "ALL" ? "All" : o.replace("_", " ")}
                    </button>
                  ),
                )}
              </div>
            </div>

            {loadingOutcomes ? (
              <Spinner />
            ) : outcomes.length === 0 ? (
              <EmptyState
                icon="📋"
                title="No trade outcomes yet"
                sub={`No completed trade data for ${date}. Outcomes are saved when advised trades close.`}
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Symbol</th>
                      <th className="px-4 py-2 text-left">Direction</th>
                      <th className="px-4 py-2 text-right">Entry</th>
                      <th className="px-4 py-2 text-right">Exit</th>
                      <th className="px-4 py-2 text-right">P&L pts</th>
                      <th className="px-4 py-2 text-right">Entry OI</th>
                      <th className="px-4 py-2 text-right">Exit OI</th>
                      <th className="px-4 py-2 text-right">Entry PCR</th>
                      <th className="px-4 py-2 text-right">OI Vel.</th>
                      <th className="px-4 py-2 text-right">Hold (m)</th>
                      <th className="px-4 py-2 text-center">Outcome</th>
                      <th className="px-4 py-2 text-center">Exit Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-zinc-800">
                    {outcomes.map((o) => (
                      <tr
                        key={o.id}
                        className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                      >
                        <td className="px-4 py-2">
                          <div className="font-medium text-xs dark:text-white">
                            {o.optionSymbol}
                          </div>
                          <div className="text-zinc-400 text-xs">
                            {o.strategy}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`text-xs font-medium ${o.direction === "BUY" ? "text-emerald-600" : "text-red-500"}`}
                          >
                            {o.direction}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-200">
                          {fmt(o.entryPrice)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-200">
                          {fmt(o.exitPrice)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono text-xs font-semibold ${
                            o.pnl == null
                              ? "text-zinc-400"
                              : o.pnl >= 0
                                ? "text-emerald-600"
                                : "text-red-500"
                          }`}
                        >
                          {o.pnl != null
                            ? (o.pnl >= 0 ? "+" : "") + fmt(o.pnl)
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                          {fmtNum(o.entryOI)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                          {fmtNum(o.exitOI)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                          {fmt(o.entryPCR, 3)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs dark:text-zinc-300">
                          {fmt(o.entryOIVelocity)}
                        </td>
                        <td className="px-4 py-2 text-right text-xs dark:text-zinc-300">
                          {o.holdMinutes ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <OutcomeBadge outcome={o.outcome} />
                        </td>
                        <td className="px-4 py-2 text-center text-xs text-zinc-500">
                          {o.exitReason ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Pattern Accuracy ── */}
        {tab === "accuracy" && (
          <div className="space-y-3">
            <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
              Pattern accuracy — ML performance stats (all-time)
            </h2>

            {loadingAccuracy ? (
              <Spinner />
            ) : accuracy.length === 0 ? (
              <EmptyState
                icon="🎯"
                title="No accuracy data yet"
                sub="Accuracy is calculated after enough trades have been confirmed (ltpAfter15m filled by scheduler)."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                      <th className="px-4 py-3 text-left">Pattern Type</th>
                      <th className="px-4 py-3 text-right">Total Signals</th>
                      <th className="px-4 py-3 text-right">Correct</th>
                      <th className="px-4 py-3 text-right">Accuracy</th>
                      <th className="px-4 py-3 text-left">Score Bar</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-zinc-800">
                    {accuracy
                      .sort((a, b) => b.accuracy - a.accuracy)
                      .map((row) => (
                        <tr
                          key={row.patternType}
                          className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <PatternBadge type={row.patternType} />
                          </td>
                          <td className="px-4 py-3 text-right font-mono dark:text-zinc-200">
                            {row.total}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-emerald-600">
                            {row.correct}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold dark:text-white">
                            {row.accuracy.toFixed(1)}%
                          </td>
                          <td className="px-4 py-3 min-w-40">
                            <div className="relative h-4 rounded-full bg-zinc-100 dark:bg-zinc-700 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  row.accuracy >= 70
                                    ? "bg-emerald-500"
                                    : row.accuracy >= 50
                                      ? "bg-yellow-400"
                                      : "bg-red-400"
                                }`}
                                style={{ width: `${row.accuracy}%` }}
                              />
                              <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white mix-blend-difference">
                                {row.accuracy.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Historic Analysis ── */}
        {tab === "history" && (
          <div className="space-y-6">
            {/* ── Kite Live Strike Analysis ── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
                  📡 Kite API — Strike OI &amp; PCR Analysis for {date}
                </h2>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    Live · push updates via WebSocket
                  </span>
                  <span className="text-xs text-zinc-400">
                    {kiteAnalysis.length} strike(s)
                  </span>
                </div>
              </div>

              {loadingKite ? (
                <Spinner />
              ) : kiteAnalysis.length === 0 ? (
                <EmptyState
                  icon="📡"
                  title="No strike selections found for this date"
                  sub="Strike selections are recorded at market open when the auto-trade engine runs."
                />
              ) : (
                <div className="space-y-4">
                  {kiteAnalysis.map((r, i) => (
                    <KiteStrikeCard key={i} data={r} />
                  ))}
                </div>
              )}
            </section>

            {/* ── Saved LiveTrade Records ── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-sm text-zinc-700 dark:text-zinc-300">
                  📋 Saved Live Trades for {date}
                </h2>
                <span className="text-xs text-zinc-400">
                  {history.length} trade(s)
                </span>
              </div>

              {loadingHistory ? (
                <Spinner />
              ) : history.length === 0 ? (
                <EmptyState
                  icon="📭"
                  title="No live trade records for this date"
                  sub="Trade records appear here once the live trading engine executes orders."
                />
              ) : (
                <div className="space-y-4">
                  {history.map((h) => (
                    <HistoricTradeCard
                      key={h.trade.id}
                      data={h}
                      expanded={expandedTrade === h.trade.id}
                      onToggle={() =>
                        setExpandedTrade((prev) =>
                          prev === h.trade.id ? null : h.trade.id,
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ActiveTradeCard({ data }: { data: ActiveTrade }) {
  const { liveTradeId, verdict } = data;
  if (!verdict)
    return (
      <div className="rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800 p-4 text-zinc-500 text-sm">
        Trade <code className="font-mono text-xs">{liveTradeId}</code> — no
        verdict yet (tick data still being gathered)
      </div>
    );

  return (
    <div
      className={`rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800 overflow-hidden`}
    >
      {/* Top bar */}
      <div
        className={`px-4 py-3 border-b dark:border-zinc-800 flex items-center justify-between flex-wrap gap-2 ${
          verdict.action === "HOLD"
            ? "bg-emerald-50 dark:bg-emerald-950/30"
            : verdict.action === "CAUTION"
              ? "bg-yellow-50 dark:bg-yellow-950/30"
              : "bg-red-50 dark:bg-red-950/30"
        }`}
      >
        <div className="flex items-center gap-3">
          <VerdictBadge action={verdict.action} />
          <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            {liveTradeId.slice(0, 8)}…
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="font-semibold dark:text-white">
            LTP: {fmt(verdict.latestLTP)}
          </span>
          <span className="text-xs text-zinc-500">
            Confidence: {verdict.confidence}%
          </span>
          {/* Confidence bar */}
          <div className="w-24 h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                verdict.confidence >= 70
                  ? "bg-emerald-500"
                  : verdict.confidence >= 40
                    ? "bg-yellow-400"
                    : "bg-red-400"
              }`}
              style={{ width: `${verdict.confidence}%` }}
            />
          </div>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
        <MetricCell
          label="OI Trend"
          value={<OITrendBadge trend={verdict.oiTrend} />}
        />
        <MetricCell
          label="PCR"
          value={
            verdict.pcr != null ? (
              <span className="font-mono font-semibold dark:text-white">
                {fmt(verdict.pcr, 3)}{" "}
                <span className="text-xs font-normal">
                  (<PcrTrend trend={verdict.pcrTrend} />)
                </span>
              </span>
            ) : (
              "—"
            )
          }
        />
        <MetricCell
          label="Latest OI"
          value={
            <span className="font-mono dark:text-white">
              {fmtNum(verdict.latestOI)}
            </span>
          }
        />
        <MetricCell
          label="Flags"
          value={
            <div className="flex flex-wrap gap-1">
              {verdict.oiVelocitySpike && (
                <span className="rounded bg-red-100 text-red-700 px-1.5 py-0.5 text-xs">
                  ⚡ OI Spike
                </span>
              )}
              {verdict.orderBookFlipped && (
                <span className="rounded bg-blue-100 text-blue-700 px-1.5 py-0.5 text-xs">
                  🔄 OB Flip
                </span>
              )}
              {verdict.absorptionDetected && (
                <span className="rounded bg-purple-100 text-purple-700 px-1.5 py-0.5 text-xs">
                  🧲 Absorption
                </span>
              )}
              {!verdict.oiVelocitySpike &&
                !verdict.orderBookFlipped &&
                !verdict.absorptionDetected && (
                  <span className="text-zinc-400 text-xs">None</span>
                )}
            </div>
          }
        />
      </div>

      {/* Reasons */}
      {verdict.reasons.length > 0 && (
        <div className="px-4 pb-4">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">
            Analysis
          </div>
          <ul className="space-y-1">
            {verdict.reasons.map((r, i) => (
              <li
                key={i}
                className="text-sm text-zinc-600 dark:text-zinc-300 flex gap-2"
              >
                <span className="text-zinc-400 shrink-0">•</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MetricCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-zinc-400 mb-0.5">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-xs text-zinc-400">OPEN</span>;
  const colors: Record<string, string> = {
    TARGET_HIT: "bg-emerald-100 text-emerald-700",
    SL_HIT: "bg-red-100 text-red-700",
    MANUAL_EXIT: "bg-zinc-100 text-zinc-600",
    SQUARED_OFF: "bg-zinc-100 text-zinc-600",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${colors[outcome] ?? "bg-zinc-100 text-zinc-600"}`}
    >
      {outcome.replace("_", " ")}
    </span>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-6 w-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  sub,
}: {
  icon: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800 p-12 text-center">
      <div className="text-4xl mb-3">{icon}</div>
      <div className="font-medium text-zinc-700 dark:text-zinc-300">
        {title}
      </div>
      <div className="text-sm text-zinc-400 mt-1">{sub}</div>
    </div>
  );
}

// ── Historic Trade Card ────────────────────────────────────────────────────────

const RETRO_STYLE: Record<string, string> = {
  PROFITABLE: "bg-emerald-50 border-emerald-300 dark:bg-emerald-950/30",
  LOSS: "bg-red-50 border-red-300 dark:bg-red-950/30",
  BREAKEVEN: "bg-zinc-50 border-zinc-300 dark:bg-zinc-800/30",
  OPEN: "bg-blue-50 border-blue-300 dark:bg-blue-950/30",
};
const RETRO_BADGE: Record<string, string> = {
  PROFITABLE: "bg-emerald-100 text-emerald-700 border border-emerald-300",
  LOSS: "bg-red-100 text-red-700 border border-red-300",
  BREAKEVEN: "bg-zinc-100 text-zinc-600 border border-zinc-300",
  OPEN: "bg-blue-100 text-blue-700 border border-blue-300",
};
const RETRO_ICON: Record<string, string> = {
  PROFITABLE: "🎯",
  LOSS: "🛑",
  BREAKEVEN: "➖",
  OPEN: "⏳",
};

function HistoricTradeCard({
  data,
  expanded,
  onToggle,
}: {
  data: HistoricTrade;
  expanded: boolean;
  onToggle: () => void;
}) {
  const {
    trade,
    strikeSelection,
    tickSummary,
    patterns,
    pcrHistory,
    outcome,
    retrospectiveVerdict,
    oiChange,
    entryOI,
    exitOI,
  } = data;

  const pnlPts =
    trade.entryFilledPrice != null && trade.exitPrice != null
      ? trade.exitPrice - trade.entryFilledPrice
      : null;

  return (
    <div
      className={`rounded-xl border overflow-hidden ${RETRO_STYLE[retrospectiveVerdict]}`}
    >
      {/* ── Header row ── */}
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left hover:brightness-95 transition-all"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${RETRO_BADGE[retrospectiveVerdict]}`}
          >
            {RETRO_ICON[retrospectiveVerdict]} {retrospectiveVerdict}
          </span>
          <span className="font-semibold text-sm dark:text-white">
            {trade.optionSymbol}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded font-medium ${trade.optionType === "PE" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}
          >
            {trade.optionType}
          </span>
          <span className="text-xs text-zinc-500">{trade.strategy}</span>
        </div>
        <div className="flex items-center gap-4 text-sm shrink-0">
          {pnlPts != null && (
            <span
              className={`font-mono font-bold ${pnlPts >= 0 ? "text-emerald-600" : "text-red-500"}`}
            >
              {pnlPts >= 0 ? "+" : ""}
              {pnlPts.toFixed(1)} pts
            </span>
          )}
          <StatusBadge status={trade.status} />
          <span className="text-zinc-400 text-xs">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* ── Summary metrics (always visible) ── */}
      <div className="px-4 pb-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 border-t border-white/40 dark:border-zinc-700/40">
        <SmallMetric label="Entry" value={fmt(trade.entryFilledPrice)} />
        <SmallMetric label="Exit" value={fmt(trade.exitPrice)} />
        <SmallMetric label="Target" value={fmt(trade.targetPrice)} />
        <SmallMetric label="SL" value={fmt(trade.slPrice)} />
        <SmallMetric label="Entry OI" value={fmtNum(entryOI)} />
        <SmallMetric
          label="OI Change"
          value={
            oiChange != null ? (
              <span
                className={oiChange > 0 ? "text-red-500" : "text-emerald-600"}
              >
                {oiChange > 0 ? "+" : ""}
                {fmtNum(oiChange)}
              </span>
            ) : (
              "—"
            )
          }
        />
      </div>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="border-t border-white/40 dark:border-zinc-700/40 bg-white/60 dark:bg-zinc-900/60 px-4 py-4 space-y-5">
          {/* Strike selection */}
          {strikeSelection && (
            <section>
              <SectionTitle>Strike Selection</SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-2">
                <SmallMetric
                  label="Nifty at Open"
                  value={fmt(strikeSelection.niftySpotAtOpen, 0)}
                />
                <SmallMetric
                  label="ATM Strike"
                  value={strikeSelection.atmStrike}
                />
                <SmallMetric
                  label="CE Symbol"
                  value={strikeSelection.ceTradingSymbol}
                />
                <SmallMetric
                  label="CE Strike"
                  value={strikeSelection.ceStrike}
                />
                <SmallMetric
                  label="PE Symbol"
                  value={strikeSelection.peTradingSymbol}
                />
                <SmallMetric
                  label="PE Strike"
                  value={strikeSelection.peStrike}
                />
              </div>
            </section>
          )}

          {/* Tick summary */}
          {tickSummary && tickSummary.ticks > 0 && (
            <section>
              <SectionTitle>
                Tick Data Summary ({tickSummary.ticks} ticks recorded)
              </SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                <SmallMetric
                  label="First LTP"
                  value={fmt(tickSummary.firstLTP)}
                />
                <SmallMetric
                  label="Last LTP"
                  value={fmt(tickSummary.lastLTP)}
                />
                <SmallMetric label="Min LTP" value={fmt(tickSummary.minLTP)} />
                <SmallMetric label="Max LTP" value={fmt(tickSummary.maxLTP)} />
                <SmallMetric
                  label="First OI"
                  value={fmtNum(tickSummary.firstOI)}
                />
                <SmallMetric
                  label="Last OI"
                  value={fmtNum(tickSummary.lastOI)}
                />
                <SmallMetric
                  label="OI Δ"
                  value={
                    tickSummary.oiChange != null ? (
                      <span
                        className={
                          tickSummary.oiChange > 0
                            ? "text-red-500"
                            : "text-emerald-600"
                        }
                      >
                        {tickSummary.oiChange > 0 ? "+" : ""}
                        {fmtNum(tickSummary.oiChange)}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <SmallMetric
                  label="Volume"
                  value={fmtNum(tickSummary.totalVolume)}
                />
              </div>
            </section>
          )}

          {/* PCR history */}
          {pcrHistory.length > 0 && (
            <section>
              <SectionTitle>
                PCR History ({pcrHistory.length} snapshots)
              </SectionTitle>
              <div className="mt-2 overflow-x-auto rounded-lg border dark:border-zinc-700">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-zinc-50 dark:bg-zinc-800 text-zinc-500 border-b dark:border-zinc-700">
                      <th className="px-3 py-1.5 text-left">Time</th>
                      <th className="px-3 py-1.5 text-right">CE OI</th>
                      <th className="px-3 py-1.5 text-right">PE OI</th>
                      <th className="px-3 py-1.5 text-right font-bold">PCR</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-zinc-800">
                    {pcrHistory.map((p, i) => {
                      const prev = i > 0 ? pcrHistory[i - 1].pcr : null;
                      const up = prev != null ? p.pcr > prev : null;
                      return (
                        <tr
                          key={i}
                          className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                        >
                          <td className="px-3 py-1.5 text-zinc-500">
                            {fmtTime(p.time)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {fmtNum(p.ceOI)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {fmtNum(p.peOI)}
                          </td>
                          <td
                            className={`px-3 py-1.5 text-right font-mono font-semibold ${up === true ? "text-emerald-600" : up === false ? "text-red-500" : "dark:text-white"}`}
                          >
                            {up === true ? "↑ " : up === false ? "↓ " : ""}
                            {p.pcr.toFixed(3)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Detected patterns */}
          {patterns.length > 0 && (
            <section>
              <SectionTitle>Detected Patterns ({patterns.length})</SectionTitle>
              <div className="mt-2 flex flex-wrap gap-2">
                {patterns.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-lg border px-3 py-2 text-xs bg-white dark:bg-zinc-900 dark:border-zinc-700 space-y-0.5"
                  >
                    <div>
                      <PatternBadge type={p.patternType} />
                    </div>
                    <div className="text-zinc-500">
                      {fmtTime(p.detectedAt)} · LTP {fmt(p.ltpAtDetection)}
                    </div>
                    {p.wasCorrect != null && (
                      <div
                        className={
                          p.wasCorrect ? "text-emerald-600" : "text-red-500"
                        }
                      >
                        {p.wasCorrect ? "✓ Correct" : "✗ Incorrect"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ML outcome record */}
          {outcome && (
            <section>
              <SectionTitle>ML Training Record</SectionTitle>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                <SmallMetric
                  label="Entry PCR"
                  value={fmt(outcome.entryPCR, 3)}
                />
                <SmallMetric label="Exit PCR" value={fmt(outcome.exitPCR, 3)} />
                <SmallMetric
                  label="OI Velocity"
                  value={fmt(outcome.entryOIVelocity)}
                />
                <SmallMetric
                  label="Hold (min)"
                  value={outcome.holdMinutes ?? "—"}
                />
                <SmallMetric
                  label="Buy Qty"
                  value={fmtNum(outcome.entryBuyQty)}
                />
                <SmallMetric
                  label="Sell Qty"
                  value={fmtNum(outcome.entrySellQty)}
                />
                <SmallMetric
                  label="Exit Reason"
                  value={outcome.exitReason ?? "—"}
                />
                <SmallMetric
                  label="P&L"
                  value={
                    outcome.pnl != null ? (
                      <span
                        className={
                          outcome.pnl >= 0
                            ? "text-emerald-600 font-semibold"
                            : "text-red-500 font-semibold"
                        }
                      >
                        {outcome.pnl >= 0 ? "+" : ""}
                        {fmt(outcome.pnl)} pts
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            </section>
          )}

          {/* No data notice */}
          {!tickSummary?.ticks &&
            pcrHistory.length === 0 &&
            patterns.length === 0 &&
            !outcome && (
              <div className="text-sm text-zinc-400 text-center py-4">
                No tick/OI/pattern data was recorded for this trade.
                <br />
                <span className="text-xs">
                  Advisor data collection starts only after{" "}
                  <code>startAdvisingTrade()</code> is connected to
                  LiveTradingService.
                </span>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const COLORS: Record<string, string> = {
    ACTIVE: "bg-green-100 text-green-700",
    TARGET_HIT: "bg-emerald-100 text-emerald-700",
    SL_HIT: "bg-red-100 text-red-700",
    SQUARED_OFF: "bg-zinc-100 text-zinc-600",
    PENDING_HEDGE: "bg-yellow-100 text-yellow-700",
    PENDING_ENTRY: "bg-blue-100 text-blue-700",
    FAILED: "bg-red-200 text-red-900",
    CANCELLED: "bg-zinc-100 text-zinc-500",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${COLORS[status] ?? "bg-zinc-100 text-zinc-600"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function SmallMetric({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-zinc-400 truncate">{label}</div>
      <div className="text-sm font-medium dark:text-white truncate">
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
      {children}
    </div>
  );
}

// ── Kite Strike Card ───────────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, string> = {
  BULLISH: "bg-emerald-50 border-emerald-300 dark:bg-emerald-950/30",
  MILD_BULLISH: "bg-teal-50 border-teal-200 dark:bg-teal-950/20",
  NEUTRAL: "bg-zinc-50 border-zinc-200 dark:bg-zinc-800/30",
  MILD_BEARISH: "bg-orange-50 border-orange-200 dark:bg-orange-950/20",
  BEARISH: "bg-red-50 border-red-300 dark:bg-red-950/30",
};
const VERDICT_BADGE: Record<string, string> = {
  BULLISH: "bg-emerald-100 text-emerald-800 border border-emerald-300",
  MILD_BULLISH: "bg-teal-100 text-teal-800 border border-teal-300",
  NEUTRAL: "bg-zinc-100 text-zinc-600 border border-zinc-300",
  MILD_BEARISH: "bg-orange-100 text-orange-800 border border-orange-300",
  BEARISH: "bg-red-100 text-red-800 border border-red-300",
};
const KITE_VERDICT_ICON: Record<string, string> = {
  BULLISH: "📈",
  MILD_BULLISH: "↗️",
  NEUTRAL: "➡️",
  MILD_BEARISH: "↘️",
  BEARISH: "📉",
};

function KiteStrikeCard({ data }: { data: KiteStrikeResult }) {
  if (data.error) {
    return (
      <div className="rounded-xl border bg-white dark:bg-zinc-900 dark:border-zinc-800 p-4 flex items-center gap-3">
        <span className="text-2xl">⚠️</span>
        <div>
          <div className="font-medium text-sm dark:text-white">
            {data.symbol} — {data.ceSymbol ?? "?"} / {data.peSymbol ?? "?"}
          </div>
          <div className="text-xs text-red-500 mt-0.5">{data.error}</div>
        </div>
      </div>
    );
  }

  const { ce, pe, analysis } = data;
  const verdict = analysis?.verdict ?? "NEUTRAL";

  return (
    <div
      className={`rounded-xl border overflow-hidden ${VERDICT_COLORS[verdict] ?? VERDICT_COLORS.NEUTRAL}`}
    >
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${VERDICT_BADGE[verdict] ?? VERDICT_BADGE.NEUTRAL}`}
          >
            {KITE_VERDICT_ICON[verdict] ?? "➡️"} {verdict.replace("_", " ")}
          </span>
          <span className="font-semibold text-sm dark:text-white">
            {data.symbol}
          </span>
          <span className="text-xs text-zinc-500">
            ATM {data.atmStrike} · Expiry {data.expiry}
          </span>
          <span className="text-xs text-zinc-400">
            Nifty @ Open:{" "}
            <strong className="text-zinc-600 dark:text-zinc-200">
              {data.niftySpotAtOpen?.toFixed(0)}
            </strong>
          </span>
        </div>
        {analysis && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500 text-xs">PCR:</span>
            <span
              className={`font-mono font-bold text-base ${analysis.pcr >= 1.1 ? "text-emerald-600" : analysis.pcr <= 0.9 ? "text-red-500" : "text-zinc-700 dark:text-white"}`}
            >
              {analysis.pcr.toFixed(3)}
            </span>
            <span
              className={`text-xs rounded px-1.5 py-0.5 font-medium ${analysis.pcr >= 1.1 ? "bg-emerald-100 text-emerald-700" : analysis.pcr <= 0.9 ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-600"}`}
            >
              {analysis.pcrSignal.replace("_", " ")}
            </span>
          </div>
        )}
      </div>

      {/* CE vs PE side-by-side */}
      {ce && pe && (
        <div className="grid grid-cols-2 divide-x dark:divide-zinc-700 border-t border-white/40 dark:border-zinc-700/40">
          <LegPanel leg={ce} type="CE" />
          <LegPanel leg={pe} type="PE" />
        </div>
      )}

      {/* Analysis reasons */}
      {analysis && analysis.reasons.length > 0 && (
        <div className="px-4 py-3 border-t border-white/40 dark:border-zinc-700/40 bg-white/40 dark:bg-zinc-900/40">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">
            Market Direction
          </div>
          <ul className="space-y-1">
            {analysis.reasons.map((r, i) => (
              <li
                key={i}
                className="text-sm text-zinc-600 dark:text-zinc-300 flex gap-2"
              >
                <span className="text-zinc-400 shrink-0">•</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Entry Suggestions: what to do if no trade taken yet ── */}
      {data.entrySuggestions && (
        <EntrySuggestionsPanel suggestions={data.entrySuggestions} />
      )}

      {/* ── Trade Advice: all 4 position types ── */}
      {data.tradeAdvice && (
        <div className="border-t border-white/40 dark:border-zinc-700/40">
          {/* Row label */}
          <div className="grid grid-cols-2 divide-x dark:divide-zinc-700 border-b border-white/20 dark:border-zinc-700/40">
            <div className="px-3 py-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800/60">
              📈 CE Positions
            </div>
            <div className="px-3 py-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800/60">
              📉 PE Positions
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x dark:divide-zinc-700">
            <TradeAdvicePanel
              label="If you BOUGHT the CE"
              optionLabel={`CE ${data.ce?.strike ?? ""}`}
              advice={data.tradeAdvice.ceBuy}
            />
            <TradeAdvicePanel
              label="If you BOUGHT the PE"
              optionLabel={`PE ${data.pe?.strike ?? ""}`}
              advice={data.tradeAdvice.peBuy}
            />
          </div>
          <div className="grid grid-cols-2 divide-x dark:divide-zinc-700 border-t border-white/20 dark:border-zinc-700/30">
            <TradeAdvicePanel
              label="If you SOLD the CE"
              optionLabel={`CE ${data.ce?.strike ?? ""}`}
              advice={data.tradeAdvice.ceSell}
            />
            <TradeAdvicePanel
              label="If you SOLD the PE"
              optionLabel={`PE ${data.pe?.strike ?? ""}`}
              advice={data.tradeAdvice.peSell}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const MARKET_PHASE_LABEL: Record<string, string> = {
  TRENDING_BEARISH: "📉 Trending Bearish",
  TRENDING_BULLISH: "📈 Trending Bullish",
  BEARISH_AT_SUPPORT: "⚠️ Bearish @ Support",
  BULLISH_AT_RESISTANCE: "⚠️ Bullish @ Resistance",
  NEUTRAL: "↔️ Neutral",
};

function MoveIndicator({ pct }: { pct: number }) {
  if (Math.abs(pct) < 2) return null;
  const isUp = pct > 0;
  return (
    <span
      className={`text-xs font-semibold ${
        isUp
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-500 dark:text-red-400"
      }`}
    >
      {isUp ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}% from open
    </span>
  );
}

function RangeBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct < 22 ? "bg-blue-500" : pct > 78 ? "bg-red-500" : "bg-zinc-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-1.5 w-16 rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className={`absolute left-0 top-0 h-1.5 w-1.5 rounded-full ${color}`}
          style={{ left: `calc(${pct}% - 3px)` }}
        />
      </div>
      <span className="text-[10px] text-zinc-400">
        {pct < 22 ? "Support" : pct > 78 ? "Resistance" : `Mid ${pct}%`}
      </span>
    </div>
  );
}

function EntrySuggestionsPanel({
  suggestions,
}: {
  suggestions: NonNullable<KiteStrikeResult["entrySuggestions"]>;
}) {
  const { ce, pe, topTrade } = suggestions;

  const TOP_BG: Record<string, string> = {
    HIGH: "bg-emerald-600",
    MEDIUM: "bg-blue-600",
    LOW: "bg-zinc-500",
  };
  const TOP_BORDER: Record<string, string> = {
    HIGH: "border-emerald-400",
    MEDIUM: "border-blue-400",
    LOW: "border-zinc-400",
  };

  return (
    <div className="border-t border-white/40 dark:border-zinc-700/40">
      {/* ── Top trade banner ── */}
      <div className={`px-4 py-3 ${TOP_BG[topTrade.confidence]} text-white`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-extrabold tracking-wide">
              🎯{" "}
              {topTrade.action === "WAIT"
                ? "WAIT — No Clear Edge"
                : `${topTrade.action}${topTrade.at ? ` @ ₹${topTrade.at}` : ""}`}
            </span>
            {topTrade.atNow && (
              <span className="bg-white/20 text-white text-xs font-bold px-2 py-0.5 rounded-full animate-pulse">
                ACT NOW
              </span>
            )}
            {topTrade.marketPhase && (
              <span className="bg-white/10 text-white/90 text-xs px-2 py-0.5 rounded-full border border-white/20">
                {MARKET_PHASE_LABEL[topTrade.marketPhase] ??
                  topTrade.marketPhase}
              </span>
            )}
          </div>
          <span
            className={`text-xs font-semibold border ${TOP_BORDER[topTrade.confidence]} rounded-full px-2.5 py-0.5 bg-white/10`}
          >
            {topTrade.confidence} CONFIDENCE
          </span>
        </div>
        <p className="text-sm text-white/80 mt-1">{topTrade.reason}</p>
        {/* Risk note */}
        {topTrade.riskNote && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/20 border border-amber-400/40 px-3 py-2 text-xs text-amber-100">
            <span className="shrink-0 mt-0.5">⚠️</span>
            <span>{topTrade.riskNote}</span>
          </div>
        )}
        {/* Alternative */}
        {topTrade.alternative && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-white/10 px-3 py-2 text-xs text-white/80">
            <span className="shrink-0 mt-0.5">💡</span>
            <span>{topTrade.alternative}</span>
          </div>
        )}
      </div>

      {/* ── CE + PE level grid ── */}
      <div className="grid grid-cols-2 divide-x dark:divide-zinc-700 bg-zinc-50/60 dark:bg-zinc-900/40">
        {/* CE levels */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              CE {ce.dayLow > 0 ? `(Day: ${ce.dayLow}–${ce.dayHigh})` : ""}
            </span>
            <div className="flex items-center gap-2">
              <MoveIndicator pct={ce.moveFromOpenPct} />
              <RangeBar value={ce.priceInRange} />
            </div>
          </div>
          <div className="space-y-1.5">
            <div
              className={`flex items-start gap-2 text-sm rounded-lg px-2.5 py-2 ${
                ce.sellNow
                  ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-semibold"
                  : "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              <span className="shrink-0 mt-0.5">
                {ce.sellNow ? "🔴" : "⏳"}
              </span>
              <div className="min-w-0">
                <span className="font-bold">SELL at ₹{ce.sellAt}</span>
                <p className="text-xs font-normal opacity-80 mt-0.5">
                  {ce.sellNote}
                </p>
                {ce.sellRisk && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-normal">
                    {ce.sellRisk}
                  </p>
                )}
              </div>
            </div>
            <div
              className={`flex items-start gap-2 text-sm rounded-lg px-2.5 py-2 ${
                ce.buyNow
                  ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-semibold"
                  : "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              <span className="shrink-0 mt-0.5">{ce.buyNow ? "🟢" : "⏳"}</span>
              <div className="min-w-0">
                <span className="font-bold">BUY at ₹{ce.buyAt}</span>
                <p className="text-xs font-normal opacity-80 mt-0.5">
                  {ce.buyNote}
                </p>
                {ce.buyRisk && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-normal">
                    {ce.buyRisk}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* PE levels */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              PE {pe.dayLow > 0 ? `(Day: ${pe.dayLow}–${pe.dayHigh})` : ""}
            </span>
            <div className="flex items-center gap-2">
              <MoveIndicator pct={pe.moveFromOpenPct} />
              <RangeBar value={pe.priceInRange} />
            </div>
          </div>
          <div className="space-y-1.5">
            <div
              className={`flex items-start gap-2 text-sm rounded-lg px-2.5 py-2 ${
                pe.sellNow
                  ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-semibold"
                  : "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              <span className="shrink-0 mt-0.5">
                {pe.sellNow ? "🔴" : "⏳"}
              </span>
              <div className="min-w-0">
                <span className="font-bold">SELL at ₹{pe.sellAt}</span>
                <p className="text-xs font-normal opacity-80 mt-0.5">
                  {pe.sellNote}
                </p>
                {pe.sellRisk && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-normal">
                    {pe.sellRisk}
                  </p>
                )}
              </div>
            </div>
            <div
              className={`flex items-start gap-2 text-sm rounded-lg px-2.5 py-2 ${
                pe.buyNow
                  ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300 font-semibold"
                  : "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-300"
              }`}
            >
              <span className="shrink-0 mt-0.5">{pe.buyNow ? "🟢" : "⏳"}</span>
              <div className="min-w-0">
                <span className="font-bold">BUY at ₹{pe.buyAt}</span>
                <p className="text-xs font-normal opacity-80 mt-0.5">
                  {pe.buyNote}
                </p>
                {pe.buyRisk && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-normal">
                    {pe.buyRisk}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TradeAdvicePanel({
  label,
  optionLabel,
  advice,
}: {
  label: string;
  optionLabel: string;
  advice: {
    action: "HOLD" | "CAUTION" | "EXIT_WARNING";
    reasons: string[];
    confidence: number;
  };
}) {
  const ACTION_BG: Record<string, string> = {
    HOLD: "bg-emerald-50 dark:bg-emerald-950/40",
    CAUTION: "bg-yellow-50 dark:bg-yellow-950/40",
    EXIT_WARNING: "bg-red-50 dark:bg-red-950/40",
  };
  const ACTION_BADGE: Record<string, string> = {
    HOLD: "bg-emerald-100 text-emerald-800 border border-emerald-300",
    CAUTION: "bg-yellow-100 text-yellow-800 border border-yellow-300",
    EXIT_WARNING: "bg-red-100 text-red-800 border border-red-300",
  };
  const ACTION_ICON: Record<string, string> = {
    HOLD: "🟢",
    CAUTION: "🟡",
    EXIT_WARNING: "🔴",
  };
  const ACTION_BAR: Record<string, string> = {
    HOLD: "bg-emerald-500",
    CAUTION: "bg-yellow-400",
    EXIT_WARNING: "bg-red-500",
  };

  return (
    <div className={`px-4 py-3 space-y-2 ${ACTION_BG[advice.action]}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs text-zinc-400">{label}</div>
          <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
            {optionLabel}
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${ACTION_BADGE[advice.action]}`}
        >
          {ACTION_ICON[advice.action]} {advice.action.replace("_", " ")}
        </span>
      </div>

      {/* Confidence bar */}
      <div className="space-y-0.5">
        <div className="flex justify-between text-xs text-zinc-400">
          <span>Confidence</span>
          <span className="font-semibold dark:text-zinc-200">
            {advice.confidence}%
          </span>
        </div>
        <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${ACTION_BAR[advice.action]}`}
            style={{ width: `${advice.confidence}%` }}
          />
        </div>
      </div>

      {/* Reasons */}
      <ul className="space-y-1 pt-1">
        {advice.reasons.map((r, i) => (
          <li
            key={i}
            className="text-xs text-zinc-600 dark:text-zinc-300 leading-snug"
          >
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LegPanel({ leg, type }: { leg: KiteLeg; type: "CE" | "PE" }) {
  const ltpColor =
    leg.ltpChange > 0
      ? "text-emerald-600"
      : leg.ltpChange < 0
        ? "text-red-500"
        : "text-zinc-700 dark:text-white";
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-semibold px-1.5 py-0.5 rounded ${type === "CE" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
        >
          {type} {leg.strike}
        </span>
        <span className="text-xs text-zinc-400 truncate max-w-32">
          {leg.symbol}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-xl font-bold font-mono ${ltpColor}`}>
          {leg.ltp?.toFixed(1)}
        </span>
        <span className={`text-xs font-mono ${ltpColor}`}>
          {leg.ltpChange >= 0 ? "+" : ""}
          {leg.ltpChange?.toFixed(1)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <div className="text-zinc-400">OI</div>
        <div className="font-mono font-semibold dark:text-white">
          {fmtNum(leg.oi)}
        </div>
        <div className="text-zinc-400">OI Day Δ</div>
        <div
          className={`font-mono ${(leg.oiDayChange ?? 0) > 0 ? "text-red-500" : "text-emerald-600"}`}
        >
          {leg.oiDayChange != null
            ? (leg.oiDayChange > 0 ? "+" : "") + fmtNum(leg.oiDayChange)
            : "—"}
        </div>
        <div className="text-zinc-400">Volume</div>
        <div className="font-mono dark:text-zinc-200">{fmtNum(leg.volume)}</div>
        <div className="text-zinc-400">H / L</div>
        <div className="font-mono text-zinc-500">
          {leg.high?.toFixed(0)} / {leg.low?.toFixed(0)}
        </div>
        <div className="text-zinc-400">Buy Qty</div>
        <div className="font-mono text-emerald-600">{fmtNum(leg.buyQty)}</div>
        <div className="text-zinc-400">Sell Qty</div>
        <div className="font-mono text-red-500">{fmtNum(leg.sellQty)}</div>
        {leg.buySellRatio != null && (
          <>
            <div className="text-zinc-400">B/S Ratio</div>
            <div
              className={`font-mono font-semibold ${leg.buySellRatio >= 1.2 ? "text-emerald-600" : leg.buySellRatio <= 0.8 ? "text-red-500" : "text-zinc-600 dark:text-zinc-300"}`}
            >
              {leg.buySellRatio.toFixed(2)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

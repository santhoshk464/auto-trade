"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { ThemeToggle } from "@/components/theme-toggle";

// --- Types --------------------------------------------------------------------
type NavCard = {
  href: string;
  gradient: string;
  iconBg: string;
  title: string;
  desc: string;
  icon: ReactNode;
  badge?: string;
  target?: string;
};

// --- SVG Icons ----------------------------------------------------------------
const BrokerIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
    />
  </svg>
);
const TerminalIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
    />
  </svg>
);
const MonitorIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
    />
  </svg>
);
const AutoTradeIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M13 10V3L4 14h7v7l9-11h-7z"
    />
  </svg>
);
const BacktestIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
    />
  </svg>
);
const PaperIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
    />
  </svg>
);
const LiveOrdersIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);
const InstrumentsIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M4 6h16M4 10h16M4 14h16M4 18h16"
    />
  </svg>
);
const SettingsIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);
const SimIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
    />
  </svg>
);
const TrendUpIcon = () => (
  <svg
    className="w-3 h-3"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.5}
      d="M5 15l7-7 7 7"
    />
  </svg>
);
const TrendDownIcon = () => (
  <svg
    className="w-3 h-3"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.5}
      d="M19 9l-7 7-7-7"
    />
  </svg>
);

const DeltaIcon = () => (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      d="M12 2L2 19h20L12 2zm0 4l7 13H5l7-13z"
    />
  </svg>
);

// --- Nav cards ----------------------------------------------------------------
const navCards: NavCard[] = [
  {
    href: "/brokers",
    icon: <BrokerIcon />,
    gradient: "from-slate-500 to-slate-700",
    iconBg: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
    title: "Brokers",
    desc: "Manage broker connections & tokens",
  },
  {
    href: "/trade-terminal",
    icon: <TerminalIcon />,
    gradient: "from-blue-500 to-blue-700",
    iconBg: "bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400",
    title: "Trade Terminal",
    desc: "Place and manage manual orders",
  },
  {
    href: "/trade-finder",
    icon: <MonitorIcon />,
    gradient: "from-emerald-500 to-emerald-700",
    iconBg:
      "bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400",
    title: "Trade Finder",
    desc: "Live option chain signal scanner",
  },
  {
    href: "/auto-trade-finder",
    icon: <AutoTradeIcon />,
    gradient: "from-rose-500 to-rose-700",
    iconBg: "bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-400",
    title: "Auto Trade",
    desc: "Fully automated options strategy",
    badge: "LIVE",
  },
  {
    href: "/backtest",
    icon: <BacktestIcon />,
    gradient: "from-violet-500 to-violet-700",
    iconBg:
      "bg-violet-50 dark:bg-violet-950 text-violet-600 dark:text-violet-400",
    title: "Strategy Backtest",
    desc: "Test strategies on historical data",
  },
  {
    href: "/paper-trading",
    icon: <PaperIcon />,
    gradient: "from-amber-500 to-amber-700",
    iconBg: "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400",
    title: "Paper Trading",
    desc: "Simulate trades without real money",
  },
  {
    href: "/live-orders",
    icon: <LiveOrdersIcon />,
    gradient: "from-red-500 to-red-700",
    iconBg: "bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400",
    title: "Live Orders",
    desc: "Monitor active live trade orders",
  },
  {
    href: "/instruments",
    icon: <InstrumentsIcon />,
    gradient: "from-teal-500 to-teal-700",
    iconBg: "bg-teal-50 dark:bg-teal-950 text-teal-600 dark:text-teal-400",
    title: "Instruments",
    desc: "Browse and search NSE instruments",
  },
  {
    href: "/settings",
    icon: <SettingsIcon />,
    gradient: "from-indigo-500 to-indigo-700",
    iconBg:
      "bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400",
    title: "Settings",
    desc: "Configure strategy & lot sizes",
  },
  {
    href: "/auto-trade-sim",
    icon: <SimIcon />,
    gradient: "from-cyan-500 to-cyan-700",
    iconBg: "bg-cyan-50 dark:bg-cyan-950 text-cyan-600 dark:text-cyan-400",
    title: "Auto Trade Simulator",
    desc: "Simulate 2-trade strategy P&L report",
  },
  {
    href: "/deltadotexchange",
    icon: <DeltaIcon />,
    gradient: "from-orange-500 to-orange-700",
    iconBg:
      "bg-orange-50 dark:bg-orange-950 text-orange-600 dark:text-orange-400",
    title: "Delta.Exchange",
    desc: "Crypto futures & options trading",
    badge: "CRYPTO",
    target: "_blank",
  },
];

// --- Helpers ------------------------------------------------------------------
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function formatDate() {
  return new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
function useMarketStatus() {
  const [status, setStatus] = useState({
    isOpen: false,
    label: "",
    timeStr: "",
  });
  useEffect(() => {
    const compute = () => {
      const now = new Date();
      const istOffset = 5.5 * 60;
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utc + istOffset * 60000);
      const h = ist.getHours(),
        m = ist.getMinutes(),
        day = ist.getDay();
      const mins = h * 60 + m,
        open = 9 * 60 + 15,
        close = 15 * 60 + 30;
      const isWeekday = day >= 1 && day <= 5;
      const isOpen = isWeekday && mins >= open && mins < close;
      const minsToClose = isOpen ? close - mins : 0;
      const minsToOpen = !isOpen && isWeekday && mins < open ? open - mins : 0;
      const label = isOpen
        ? `Closes in ${Math.floor(minsToClose / 60)}h ${minsToClose % 60}m`
        : minsToOpen > 0
          ? `Opens in ${Math.floor(minsToOpen / 60)}h ${minsToOpen % 60}m`
          : "Closed today";
      const timeStr = ist.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      setStatus({ isOpen, label, timeStr });
    };
    compute();
    const id = setInterval(compute, 30000);
    return () => clearInterval(id);
  }, []);
  return status;
}

// --- Stat Card ----------------------------------------------------------------
function StatCard({
  label,
  value,
  sub,
  trend,
  trendLabel,
  accentClass,
  icon,
}: {
  label: string;
  value: string | number;
  sub: string;
  trend?: "up" | "down" | "neutral";
  trendLabel?: string;
  accentClass: string;
  icon: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${accentClass}`} />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {label}
          </p>
          <p className="mt-2 text-3xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
            {value}
          </p>
          <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            {sub}
          </p>
        </div>
        <div className="rounded-xl p-2.5 bg-zinc-50 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500">
          {icon}
        </div>
      </div>
      {trend && trendLabel && (
        <div
          className={`mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            trend === "up"
              ? "bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400"
              : trend === "down"
                ? "bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400"
                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
          }`}
        >
          {trend === "up" ? (
            <TrendUpIcon />
          ) : trend === "down" ? (
            <TrendDownIcon />
          ) : null}
          {trendLabel}
        </div>
      )}
    </div>
  );
}

// --- Signal row ---------------------------------------------------------------
function SignalRow({ s }: { s: any }) {
  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
      <td className="py-3 px-4 whitespace-nowrap">
        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
          {s.signalTime}
        </p>
        <p className="text-[10px] text-zinc-400">
          {new Date(s.signalDate).toLocaleDateString("en-IN")}
        </p>
      </td>
      <td className="py-3 px-4 whitespace-nowrap">
        <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
          {s.optionSymbol}
        </p>
        <p className="text-[10px] text-zinc-400">
          {s.strike} {s.optionType}
        </p>
      </td>
      <td className="py-3 px-4">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide ${
            s.signalType === "SELL"
              ? "bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400"
              : "bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-400"
          }`}
        >
          {s.signalType}
        </span>
      </td>
      <td className="py-3 px-4 text-right whitespace-nowrap text-xs font-semibold text-zinc-800 dark:text-zinc-200 tabular-nums">
        ?{s.entryPrice?.toFixed(2)}
      </td>
      <td className="py-3 px-4 text-right whitespace-nowrap text-xs text-red-500 tabular-nums">
        ?{s.stopLoss?.toFixed(2)}
      </td>
      <td className="py-3 px-4 text-center">
        <span
          className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${
            s.tradeCreated
              ? "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-400"
              : "bg-yellow-100 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-400"
          }`}
        >
          {s.tradeCreated ? "Traded" : "Pending"}
        </span>
      </td>
    </tr>
  );
}

// --- Dashboard ---------------------------------------------------------------
function DashboardInner() {
  const router = useRouter();
  const search = useSearchParams();
  const { user, loading } = useMe();
  const market = useMarketStatus();
  const [loggingOut, setLoggingOut] = useState(false);
  const [brokerStatus, setBrokerStatus] = useState<any>(null);
  const [showBrokerAlert, setShowBrokerAlert] = useState(true);
  const [signalStats, setSignalStats] = useState<any>(null);
  const [recentSignals, setRecentSignals] = useState<any[]>([]);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);
  useEffect(() => {
    if (search.get("kite") === "success")
      toast.success("Access Token generation success");
  }, [search]);

  useEffect(() => {
    if (loading || !user) return;
    const today = new Date().toISOString().split("T")[0];
    Promise.allSettled([
      apiFetch("/brokers/status"),
      apiFetch(`/signals/stats?date=${today}`),
      apiFetch(`/signals?strategy=DAY_SELLING&date=${today}&limit=6`),
    ]).then(([brokerRes, statsRes, signalsRes]) => {
      if (brokerRes.status === "fulfilled") {
        const b = brokerRes.value as any;
        setBrokerStatus(b);
        if (b.hasExpiredTokens && showBrokerAlert)
          toast.error("Broker access token expired! Please reconnect.", {
            duration: 6000,
          });
      }
      if (statsRes.status === "fulfilled") setSignalStats(statsRes.value);
      if (signalsRes.status === "fulfilled")
        setRecentSignals((signalsRes.value as any).signals || []);
    });
  }, [loading, user]);

  async function logout() {
    setLoggingOut(true);
    try {
      await apiFetch<{ ok: true }>("/auth/logout", { method: "POST" });
      toast.success("Logged Out");
      router.push("/login");
    } catch (err: any) {
      toast.error(err?.message || "Logout failed");
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950">
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
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
          Loading…
        </div>
      </div>
    );

  const brokerOk =
    brokerStatus &&
    !brokerStatus.hasExpiredTokens &&
    !brokerStatus.hasNoBrokers;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950">
      {/* -- Navbar ------------------------------------------------------- */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-blue-600 text-white">
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
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <span className="font-bold text-zinc-900 dark:text-zinc-100 tracking-tight text-sm">
              AutoTrade
            </span>
          </div>

          <div
            className={`hidden sm:flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
              market.isOpen
                ? "bg-green-50 dark:bg-green-950/60 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900"
                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${market.isOpen ? "bg-green-500 animate-pulse" : "bg-zinc-400"}`}
            />
            <span>{market.isOpen ? "Market Open" : "Market Closed"}</span>
            {market.label && (
              <span className="text-[10px] opacity-60">· {market.label}</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {brokerStatus && (
              <div
                className={`hidden md:flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold border ${
                  brokerOk
                    ? "bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900"
                    : "bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${brokerOk ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
                />
                {brokerOk ? "Broker Connected" : "Broker Issue"}
              </div>
            )}
            {user && (
              <div className="hidden sm:flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 text-xs font-bold">
                  {(user.name || user.email)[0].toUpperCase()}
                </div>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {user.name || user.email.split("@")[0]}
                </span>
              </div>
            )}
            <ThemeToggle />
            <button
              className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition disabled:opacity-50"
              onClick={logout}
              disabled={loggingOut}
            >
              {loggingOut ? "…" : "Logout"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {/* -- Broker alert ------------------------------------------------ */}
        {brokerStatus &&
          (brokerStatus.hasExpiredTokens || brokerStatus.hasNoBrokers) &&
          showBrokerAlert && (
            <div className="flex items-start justify-between gap-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400">
                  <svg
                    className="h-4 w-4"
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
                <div>
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                    {brokerStatus.hasExpiredTokens
                      ? "Broker Access Token Expired"
                      : "No Brokers Configured"}
                  </p>
                  <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {brokerStatus.message}
                  </p>
                  <Link
                    href="/brokers"
                    className="mt-2 inline-flex items-center gap-1 rounded-lg bg-amber-600 hover:bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white transition"
                  >
                    {brokerStatus.hasExpiredTokens
                      ? "Reconnect Broker"
                      : "Add Broker"}
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </Link>
                </div>
              </div>
              <button
                onClick={() => setShowBrokerAlert(false)}
                className="shrink-0 rounded-lg p-1 text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900 transition"
              >
                <svg
                  className="h-4 w-4"
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
          )}

        {/* -- Hero -------------------------------------------------------- */}
        <div className="rounded-2xl bg-linear-to-br from-indigo-600 via-blue-600 to-cyan-500 p-6 text-white shadow-lg relative overflow-hidden">
          <div className="absolute -top-8 -right-8 h-40 w-40 rounded-full bg-white/5" />
          <div className="absolute -bottom-12 -left-6 h-48 w-48 rounded-full bg-white/5" />
          <div className="relative flex items-end justify-between">
            <div>
              <p className="text-sm text-blue-100 font-medium">
                {formatDate()}
              </p>
              <h1 className="mt-1 text-2xl font-bold">
                {getGreeting()}
                {user ? `, ${user.name || user.email.split("@")[0]}` : ""} 👋
              </h1>
              <p className="mt-1 text-sm text-blue-100">
                {market.isOpen
                  ? `NSE market is live \u00B7 ${market.label}`
                  : `NSE market is closed \u00B7 ${market.label}`}
              </p>
            </div>
            <div className="hidden sm:flex flex-col items-end gap-1">
              <div
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                  market.isOpen
                    ? "bg-green-400/20 text-green-100"
                    : "bg-white/10 text-blue-100"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${market.isOpen ? "bg-green-300 animate-pulse" : "bg-blue-200"}`}
                />
                {market.isOpen ? "LIVE" : "CLOSED"}
              </div>
              <p className="text-xs text-blue-200">{market.timeStr} IST</p>
            </div>
          </div>
        </div>

        {/* -- Stat cards -------------------------------------------------- */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Broker"
            value={!brokerStatus ? "—" : brokerOk ? "Online" : "Offline"}
            sub="Zerodha Kite"
            trend={brokerOk ? "up" : brokerStatus ? "down" : "neutral"}
            trendLabel={
              brokerOk
                ? "Connected"
                : brokerStatus
                  ? "Action needed"
                  : "Checking…"
            }
            accentClass={
              brokerOk
                ? "bg-gradient-to-r from-green-400 to-emerald-500"
                : "bg-gradient-to-r from-red-400 to-rose-500"
            }
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
            }
          />
          <StatCard
            label="Today Signals"
            value={signalStats ? (signalStats.total ?? 0) : "—"}
            sub={
              signalStats
                ? `${signalStats.sell ?? 0} SELL · ${signalStats.buy ?? 0} BUY`
                : "Loading…"
            }
            trend={signalStats?.total > 0 ? "up" : "neutral"}
            trendLabel={
              signalStats?.total > 0
                ? `${signalStats.sell} Sell signals`
                : "No signals yet"
            }
            accentClass="bg-gradient-to-r from-blue-400 to-indigo-500"
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            }
          />
          <StatCard
            label="Active Trades"
            value={signalStats ? (signalStats.active ?? 0) : "—"}
            sub="Open live positions"
            trend={signalStats?.active > 0 ? "up" : "neutral"}
            trendLabel={
              signalStats?.active > 0 ? "Positions open" : "No open trades"
            }
            accentClass="bg-gradient-to-r from-emerald-400 to-teal-500"
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
          />
          <StatCard
            label="Pending"
            value={signalStats ? (signalStats.pending ?? 0) : "—"}
            sub="Signals awaiting trade"
            trend="neutral"
            trendLabel="Today"
            accentClass="bg-gradient-to-r from-amber-400 to-orange-500"
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
            }
          />
        </div>

        {/* -- Recent signals + system panel ------------------------------- */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Signals table */}
          <div className="lg:col-span-2 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
              <div>
                <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Recent Signals
                </h2>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  DAY_SELLING · Today
                </p>
              </div>
              <Link
                href="/auto-trade-finder"
                className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                View All ?
              </Link>
            </div>
            {recentSignals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-300 dark:text-zinc-600 mb-4">
                  <svg
                    className="w-7 h-7"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                  No signals today
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 max-w-xs">
                  Auto-signals appear every 5 min during market hours (9:15 –
                  2:30 PM IST)
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      {[
                        "Time",
                        "Option",
                        "Signal",
                        "Entry",
                        "SL",
                        "Status",
                      ].map((h) => (
                        <th
                          key={h}
                          className={`py-2.5 px-4 text-[10px] font-bold uppercase tracking-wider text-zinc-400 ${
                            h === "Entry" || h === "SL"
                              ? "text-right"
                              : h === "Status"
                                ? "text-center"
                                : "text-left"
                          }`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/60">
                    {recentSignals.map((s) => (
                      <SignalRow key={s.id} s={s} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* System panel */}
          <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                System Status
              </h2>
            </div>
            <div className="p-5 space-y-3">
              {[
                {
                  label: "NSE Market",
                  value: market.isOpen ? "? Live" : "? Closed",
                  valueClass: market.isOpen
                    ? "text-green-600 dark:text-green-400"
                    : "text-zinc-500",
                  right: market.timeStr,
                  rightLabel: "IST",
                },
                {
                  label: "Active Strategy",
                  value: "DAY_SELLING",
                  valueClass: "text-indigo-600 dark:text-indigo-400",
                  right: "AUTO",
                  rightClass:
                    "text-[10px] font-bold bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-lg",
                },
                {
                  label: "Scheduler",
                  value: "Every 5 min",
                  valueClass: "text-zinc-700 dark:text-zinc-300",
                  right: market.isOpen ? "RUNNING" : "PAUSED",
                  rightClass: `text-[10px] font-bold px-2 py-0.5 rounded-lg ${market.isOpen ? "bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500"}`,
                },
                {
                  label: "Today Signals",
                  value: signalStats
                    ? `${signalStats.sell ?? 0} SELL · ${signalStats.buy ?? 0} BUY`
                    : "Loading…",
                  valueClass: "text-zinc-700 dark:text-zinc-300",
                  right: signalStats?.total ?? "—",
                  rightClass:
                    "text-2xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums",
                },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between rounded-xl bg-zinc-50 dark:bg-zinc-800/60 px-4 py-3"
                >
                  <div>
                    <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">
                      {row.label}
                    </p>
                    <p
                      className={`text-sm font-semibold mt-0.5 ${row.valueClass}`}
                    >
                      {row.value}
                    </p>
                  </div>
                  {row.rightClass ? (
                    <span className={row.rightClass}>{row.right}</span>
                  ) : (
                    <div className="text-right">
                      <p className="text-[10px] text-zinc-400">
                        {row.rightLabel}
                      </p>
                      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mt-0.5">
                        {row.right}
                      </p>
                    </div>
                  )}
                </div>
              ))}

              <Link
                href="/auto-trade-finder"
                className="flex items-center justify-center gap-2 w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2.5 transition mt-1"
              >
                <AutoTradeIcon />
                Open Auto Monitor
              </Link>
            </div>
          </div>
        </div>

        {/* -- Quick access ------------------------------------------------ */}
        <div>
          <h2 className="text-xs font-bold text-zinc-400 dark:text-zinc-500 mb-4 uppercase tracking-widest">
            Quick Access
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {navCards.map((card) => (
              <Link
                key={card.href}
                href={card.href}
                target={card.target}
                rel={
                  card.target === "_blank" ? "noopener noreferrer" : undefined
                }
                className="group flex items-center gap-4 rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 hover:shadow-md hover:-translate-y-0.5 transition-all duration-150"
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${card.iconBg}`}
                >
                  {card.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {card.title}
                    </p>
                    {card.badge && (
                      <span className="rounded-full bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 leading-none">
                        {card.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                    {card.desc}
                  </p>
                </div>
                <svg
                  className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600 group-hover:text-zinc-500 dark:group-hover:text-zinc-400 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
            ))}
          </div>
        </div>

        {/* -- Footer ------------------------------------------------------ */}
        <div className="flex items-center justify-between pt-4 pb-2 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-xs text-zinc-400">
            AutoTrade · NSE Options Strategy Engine
          </p>
          <p className="text-xs text-zinc-400">All times in IST</p>
        </div>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950">
          <div className="text-sm text-zinc-400">Loading…</div>
        </div>
      }
    >
      <DashboardInner />
    </Suspense>
  );
}

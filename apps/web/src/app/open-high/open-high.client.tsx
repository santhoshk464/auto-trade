"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";

type Broker = {
  id: string;
  type: string;
  name: string;
  brokerIdMasked: string;
  status: "ACTIVE" | "INACTIVE";
};

type OptionsAnalysisRow = {
  strike: number;
  call: {
    tradingsymbol: string;
    last_price: number;
    instrument_token: number;
    ohlc: { open: number; high: number; low: number; close: number } | null;
  } | null;
  put: {
    tradingsymbol: string;
    last_price: number;
    instrument_token: number;
    ohlc: { open: number; high: number; low: number; close: number } | null;
  } | null;
};

type OptionsAnalysisResponse = {
  underlying: {
    tradingsymbol: string;
    name: string;
    exchange: string;
    last_price: number;
    change: number;
    changePercent: number;
    asOn: string | null;
    instrument_token: number;
    ohlc: { open: number; high: number; low: number; close: number } | null;
  } | null;
  rows: OptionsAnalysisRow[];
};

const INDEX_OPTIONS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
] as const;

type Strategy = "OPEN_HIGH" | "OPEN_LOW";

type Mode = "LIVE" | "HISTORICAL";

function formatAsOnIST(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function formatPct(n: number): string {
  const sign = n > 0 ? "" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function isApproxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

export default function OpenHighClient() {
  const router = useRouter();
  const { user, loading } = useMe();

  const [mode, setMode] = useState<Mode>("LIVE");
  const [exchange] = useState("NSE");
  const [symbol, setSymbol] = useState<(typeof INDEX_OPTIONS)[number]>("NIFTY");
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  const [strategy, setStrategy] = useState<Strategy>("OPEN_HIGH");

  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [brokerId, setBrokerId] = useState<string | null>(null);

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>("");

  const [loadingExpiries, setLoadingExpiries] = useState(false);
  const [loadingTable, setLoadingTable] = useState(false);

  const [data, setData] = useState<OptionsAnalysisResponse | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    async function loadBrokers() {
      try {
        const res = await apiFetch<{ brokers: Broker[] }>("/brokers");
        setBrokers(res.brokers || []);
        const firstActive = (res.brokers || []).find(
          (b) => b.status === "ACTIVE"
        );
        setBrokerId(firstActive?.id || null);
      } catch (err: any) {
        toast.error(err?.message || "Failed to load brokers");
      }
    }

    if (user) {
      loadBrokers();
    }
  }, [user]);

  useEffect(() => {
    async function loadExpiries() {
      setLoadingExpiries(true);
      try {
        const params = new URLSearchParams({
          exchange,
          symbol,
          segment: "Options",
        });
        const res = await apiFetch<{ expiries: string[] }>(
          `/kite/expiry-dates?${params.toString()}`
        );
        const exps = res.expiries || [];
        setExpiries(exps);
        setExpiry((prev) =>
          prev && exps.includes(prev) ? prev : exps[0] || ""
        );
      } catch (err: any) {
        toast.error(err?.message || "Failed to load expiry dates");
        setExpiries([]);
        setExpiry("");
      } finally {
        setLoadingExpiries(false);
      }
    }

    if (!user) return;
    loadExpiries();
  }, [exchange, symbol, user]);

  const canLoad = useMemo(() => {
    return Boolean(user && brokerId && symbol && expiry && exchange);
  }, [user, brokerId, symbol, expiry, exchange]);

  async function loadTable() {
    if (!canLoad || !brokerId) {
      toast.error("Broker/expiry missing");
      return;
    }

    setLoadingTable(true);
    try {
      const res = await apiFetch<OptionsAnalysisResponse>(
        "/kite/options-analysis",
        {
          method: "POST",
          json: {
            brokerId,
            exchange,
            symbol,
            expiry,
            strategy,
            date: mode === "HISTORICAL" ? selectedDate : undefined,
          },
        }
      );
      setData(res);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load options analysis");
    } finally {
      setLoadingTable(false);
    }
  }

  useEffect(() => {
    // Match screenshot behavior: load once defaults are ready
    if (!canLoad) return;
    if (!data) {
      loadTable();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad]);

  const rows = data?.rows || [];
  const perPage = 30;
  const shownRows = rows.slice(0, perPage);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-center p-4">
          <div className="text-sm font-medium text-zinc-700">
            Open &amp; High Strategy{" "}
            <span className="px-2 text-zinc-400">|</span> Options Analysis
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        <div className="rounded-xl border bg-white p-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-6 lg:items-end">
            <div>
              <div className="text-xs font-medium text-zinc-600">Mode</div>
              <div className="mt-2 flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "LIVE"}
                    onChange={() => setMode("LIVE")}
                  />
                  Live data
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "HISTORICAL"}
                    onChange={() => setMode("HISTORICAL")}
                  />
                  Historical
                </label>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-zinc-600">
                Select Name
              </div>
              <select
                className="mt-2 w-full rounded-md border px-3 py-2 text-sm"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value as any)}
              >
                {INDEX_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-medium text-zinc-600">
                Select Date
              </div>
              <input
                type="date"
                className="mt-2 w-full rounded-md border px-3 py-2 text-sm disabled:bg-zinc-100"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                disabled={mode === "LIVE"}
              />
            </div>

            <div>
              <div className="text-xs font-medium text-zinc-600">
                Select Expiry Date
              </div>
              <select
                className="mt-2 w-full rounded-md border px-3 py-2 text-sm disabled:bg-zinc-100"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                disabled={loadingExpiries || expiries.length === 0}
              >
                {expiries.map((ex) => (
                  <option key={ex} value={ex}>
                    {ex}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-xs font-medium text-zinc-600">Action</div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                  onClick={loadTable}
                  disabled={!canLoad || loadingTable}
                >
                  Go
                </button>
                <button
                  className={`rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
                    strategy === "OPEN_HIGH"
                      ? "bg-red-600 text-white border-red-600"
                      : "bg-white"
                  }`}
                  onClick={() => {
                    setStrategy("OPEN_HIGH");
                    if (canLoad) {
                      setTimeout(() => loadTable(), 100);
                    }
                  }}
                  disabled={loadingTable}
                >
                  Open = High
                </button>
                <button
                  className={`rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
                    strategy === "OPEN_LOW"
                      ? "bg-red-600 text-white border-red-600"
                      : "bg-white"
                  }`}
                  onClick={() => {
                    setStrategy("OPEN_LOW");
                    if (canLoad) {
                      setTimeout(() => loadTable(), 100);
                    }
                  }}
                  disabled={loadingTable}
                >
                  Open = Low
                </button>
              </div>
            </div>

            <div className="text-right">
              {data?.underlying ? (
                <div className="mt-5 text-xs text-zinc-700">
                  Underlying:{" "}
                  <span className="font-medium">{data.underlying.name}</span> at{" "}
                  <span className="font-semibold">
                    {formatNum(data.underlying.last_price)}
                  </span>
                  , Chg:{" "}
                  <span className="font-medium">
                    {formatNum(data.underlying.change)}
                  </span>{" "}
                  ({" "}
                  <span className="font-medium">
                    {formatPct(data.underlying.changePercent)}
                  </span>
                  ) as on{" "}
                  <span className="font-medium">
                    {formatAsOnIST(data.underlying.asOn)} IST
                  </span>
                </div>
              ) : (
                <div className="mt-5 text-xs text-zinc-500">
                  {brokerId ? "" : "No active broker"}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-300 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-zinc-50 text-xs text-zinc-700">
                  <th className="px-3 py-2 text-left">Day Open</th>
                  <th className="px-3 py-2 text-left">Day High</th>
                  <th className="px-3 py-2 text-left">New D.High</th>
                  <th className="px-3 py-2 text-left">New D.Low</th>
                  <th className="px-3 py-2 text-left">O=H / O=L</th>
                  <th className="px-3 py-2 text-left">Triggered Time</th>
                  <th className="px-3 py-2 text-left">Probability</th>
                  <th className="px-3 py-2 text-left">Call LTP</th>
                  <th className="px-3 py-2 text-left">Strike</th>
                  <th className="px-3 py-2 text-left">Put LTP</th>
                  <th className="px-3 py-2 text-left">Probability</th>
                  <th className="px-3 py-2 text-left">Triggered Time</th>
                  <th className="px-3 py-2 text-left">O=H / O=L</th>
                  <th className="px-3 py-2 text-left">New D.Low</th>
                  <th className="px-3 py-2 text-left">New D.High</th>
                  <th className="px-3 py-2 text-left">Day High</th>
                  <th className="px-3 py-2 text-left">Day Open</th>
                </tr>
              </thead>
              <tbody>
                {loadingTable && shownRows.length === 0 ? (
                  <tr>
                    <td
                      className="px-3 py-6 text-center text-zinc-500"
                      colSpan={17}
                    >
                      Loading…
                    </td>
                  </tr>
                ) : shownRows.length === 0 ? (
                  <tr>
                    <td
                      className="px-3 py-6 text-center text-zinc-500"
                      colSpan={17}
                    >
                      No data
                    </td>
                  </tr>
                ) : (
                  shownRows.map((r) => {
                    const c = r.call?.ohlc;
                    const p = r.put?.ohlc;

                    const callHit = c
                      ? strategy === "OPEN_HIGH"
                        ? c.high > c.open
                        : c.low < c.open
                      : false;
                    const putHit = p
                      ? strategy === "OPEN_HIGH"
                        ? p.high > p.open
                        : p.low < p.open
                      : false;

                    const badge = (hit: boolean) => {
                      if (!hit) return <span className="text-zinc-400">-</span>;
                      return (
                        <span className="inline-flex rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                          {strategy === "OPEN_HIGH" ? "O = H" : "O = L"}
                        </span>
                      );
                    };

                    const prob = (hit: boolean) => {
                      if (hit)
                        return (
                          <span className="inline-flex rounded bg-amber-400 px-2 py-0.5 text-xs font-semibold text-zinc-900">
                            Hit ✓
                          </span>
                        );
                      return <span className="text-zinc-400">-</span>;
                    };

                    return (
                      <tr key={r.strike} className="border-b last:border-b-0">
                        <td className="px-3 py-2">
                          {c ? formatNum(c.open) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {c ? formatNum(c.high) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {c ? formatNum(c.high) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {c ? formatNum(c.low) : "-"}
                        </td>
                        <td className="px-3 py-2">{badge(callHit)}</td>
                        <td className="px-3 py-2 text-zinc-400">-</td>
                        <td className="px-3 py-2">{prob(callHit)}</td>
                        <td className="px-3 py-2">
                          {r.call ? formatNum(r.call.last_price) : "-"}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {formatNum(r.strike)}
                        </td>
                        <td className="px-3 py-2">
                          {r.put ? formatNum(r.put.last_price) : "-"}
                        </td>
                        <td className="px-3 py-2">{prob(putHit)}</td>
                        <td className="px-3 py-2 text-zinc-400">-</td>
                        <td className="px-3 py-2">{badge(putHit)}</td>
                        <td className="px-3 py-2">
                          {p ? formatNum(p.low) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {p ? formatNum(p.high) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {p ? formatNum(p.high) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          {p ? formatNum(p.open) : "-"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t p-3 text-sm text-zinc-600">
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <select
                className="rounded-md border px-2 py-1 text-sm"
                value={30}
                disabled
              >
                <option value={30}>30</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <div>
                {rows.length === 0
                  ? "0"
                  : `1 - ${Math.min(rows.length, perPage)}`}{" "}
                of {rows.length}
              </div>
              <button className="px-2 py-1 text-zinc-400" disabled>
                Previous
              </button>
              <button className="px-2 py-1 text-zinc-400" disabled>
                Next
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

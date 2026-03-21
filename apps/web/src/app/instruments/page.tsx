"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import toast from "react-hot-toast";

interface Instrument {
  id: string;
  instrumentToken: number;
  exchangeToken: number;
  tradingsymbol: string;
  name: string | null;
  lastPrice: number;
  expiry: string | null;
  strike: number;
  tickSize: number;
  lotSize: number;
  instrumentType: string;
  segment: string;
  exchange: string;
}

interface Filters {
  exchanges: string[];
  segments: string[];
  instrumentTypes: string[];
  names: string[];
  expiries: string[];
}

interface Stats {
  total: number;
  byExchange: Array<{ exchange: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  bySegment: Array<{ segment: string; count: number }>;
}

export default function InstrumentsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Filter states
  const [search, setSearch] = useState("");
  const [selectedExchange, setSelectedExchange] = useState("");
  const [selectedSegment, setSelectedSegment] = useState("");
  const [selectedType, setSelectedType] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [selectedExpiry, setSelectedExpiry] = useState("");

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  // Fetch filters on mount
  useEffect(() => {
    fetchFilters();
    fetchStats();
  }, []);

  // Fetch instruments when filters change
  useEffect(() => {
    fetchInstruments();
  }, [
    search,
    selectedExchange,
    selectedSegment,
    selectedType,
    selectedName,
    selectedExpiry,
    page,
  ]);

  const fetchFilters = async () => {
    try {
      const data = await apiFetch<Filters>("/instruments/filters");
      setFilters(data);
    } catch (error: any) {
      console.error("Failed to fetch filters:", error);
    }
  };

  const fetchStats = async () => {
    try {
      const data = await apiFetch<Stats>("/instruments/stats");
      setStats(data);
    } catch (error: any) {
      console.error("Failed to fetch stats:", error);
    }
  };

  const fetchInstruments = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (selectedExchange) params.append("exchange", selectedExchange);
      if (selectedSegment) params.append("segment", selectedSegment);
      if (selectedType) params.append("instrumentType", selectedType);
      if (selectedName) params.append("name", selectedName);
      if (selectedExpiry) params.append("expiry", selectedExpiry);
      params.append("page", page.toString());
      params.append("limit", limit.toString());

      const data: any = await apiFetch(`/instruments?${params.toString()}`);
      setInstruments(data.instruments);
      setTotal(data.pagination.total);
      setTotalPages(data.pagination.totalPages);
    } catch (error: any) {
      toast.error(error.message || "Failed to fetch instruments");
    } finally {
      setLoading(false);
    }
  };

  const resetFilters = () => {
    setSearch("");
    setSelectedExchange("");
    setSelectedSegment("");
    setSelectedType("");
    setSelectedName("");
    setSelectedExpiry("");
    setPage(1);
  };

  const handleSync = async () => {
    if (syncing) return;

    setSyncing(true);
    const toastId = toast.loading("Downloading instruments from Kite API...");

    try {
      const result: any = await apiFetch("/instruments/sync", {
        method: "POST",
      });

      if (result.success) {
        toast.success(
          `Sync complete! New: ${result.stats.inserted}, Updated: ${result.stats.updated}`,
          { id: toastId },
        );

        // Refresh data
        await Promise.all([fetchInstruments(), fetchStats(), fetchFilters()]);
      } else {
        toast.error(result.message || "Sync failed", { id: toastId });
      }
    } catch (error: any) {
      toast.error(error.message || "Sync failed", { id: toastId });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-blue-600 hover:underline">
              ← Dashboard
            </Link>
            <h1 className="text-lg font-semibold">Instruments Browser</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {syncing ? "🔄 Syncing..." : "🔄 Sync from Kite"}
            </button>
            <button
              onClick={() => setShowStats(!showStats)}
              className="rounded-md border bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
            >
              {showStats ? "Hide Stats" : "Show Stats"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        {/* Statistics Panel */}
        {showStats && stats && (
          <div className="mb-4 rounded-lg border bg-white p-4">
            <h2 className="mb-3 font-semibold">Database Statistics</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <h3 className="mb-2 text-sm font-medium text-zinc-600">
                  Total Instruments
                </h3>
                <p className="text-2xl font-bold">
                  {stats.total.toLocaleString()}
                </p>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-zinc-600">
                  By Exchange
                </h3>
                <div className="space-y-1 text-sm">
                  {stats.byExchange.slice(0, 5).map((e) => (
                    <div key={e.exchange} className="flex justify-between">
                      <span>{e.exchange}:</span>
                      <span className="font-medium">
                        {e.count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-zinc-600">
                  By Type
                </h3>
                <div className="space-y-1 text-sm">
                  {stats.byType.slice(0, 5).map((t) => (
                    <div key={t.type} className="flex justify-between">
                      <span>{t.type}:</span>
                      <span className="font-medium">
                        {t.count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 rounded-lg border bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Filters</h2>
            <button
              onClick={resetFilters}
              className="text-sm text-blue-600 hover:underline"
            >
              Reset All
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {/* Search */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Search
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Symbol or name..."
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>

            {/* Name */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Name
              </label>
              <select
                value={selectedName}
                onChange={(e) => {
                  setSelectedName(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All Names</option>
                {filters?.names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {/* Expiry Date */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Expiry Date
              </label>
              <select
                value={selectedExpiry}
                onChange={(e) => {
                  setSelectedExpiry(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All Expiries</option>
                {filters?.expiries.map((expiry) => (
                  <option key={expiry} value={expiry}>
                    {expiry}
                  </option>
                ))}
              </select>
            </div>

            {/* Exchange */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Exchange
              </label>
              <select
                value={selectedExchange}
                onChange={(e) => {
                  setSelectedExchange(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All Exchanges</option>
                {filters?.exchanges.map((exchange) => (
                  <option key={exchange} value={exchange}>
                    {exchange}
                  </option>
                ))}
              </select>
            </div>

            {/* Segment */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Segment
              </label>
              <select
                value={selectedSegment}
                onChange={(e) => {
                  setSelectedSegment(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All Segments</option>
                {filters?.segments.map((segment) => (
                  <option key={segment} value={segment}>
                    {segment}
                  </option>
                ))}
              </select>
            </div>

            {/* Instrument Type */}
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Type
              </label>
              <select
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">All Types</option>
                {filters?.instrumentTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Results Summary */}
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-zinc-600">
            Showing {instruments.length > 0 ? (page - 1) * limit + 1 : 0} -{" "}
            {Math.min(page * limit, total)} of {total.toLocaleString()} results
          </p>
          {loading && <span className="text-sm text-zinc-500">Loading...</span>}
        </div>

        {/* Instruments Table */}
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="border-b bg-zinc-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Exchange</th>
                <th className="px-4 py-3 text-left font-medium">Segment</th>
                <th className="px-4 py-3 text-left font-medium">Expiry</th>
                <th className="px-4 py-3 text-right font-medium">Strike</th>
                <th className="px-4 py-3 text-right font-medium">Lot Size</th>
                <th className="px-4 py-3 text-right font-medium">Token</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {instruments.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    {loading ? "Loading..." : "No instruments found"}
                  </td>
                </tr>
              ) : (
                instruments.map((inst) => (
                  <tr key={inst.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {inst.tradingsymbol}
                    </td>
                    <td className="px-4 py-3">{inst.name || "-"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                          inst.instrumentType === "CE"
                            ? "bg-green-100 text-green-700"
                            : inst.instrumentType === "PE"
                              ? "bg-red-100 text-red-700"
                              : inst.instrumentType === "FUT"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        {inst.instrumentType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{inst.exchange}</td>
                    <td className="px-4 py-3 text-xs">{inst.segment}</td>
                    <td className="px-4 py-3 text-xs">{inst.expiry || "-"}</td>
                    <td className="px-4 py-3 text-right">
                      {inst.strike > 0 ? inst.strike : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">{inst.lotSize}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-zinc-500">
                      {inst.instrumentToken}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page === 1}
              className="rounded-md border bg-white px-4 py-2 text-sm disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-zinc-600">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
              className="rounded-md border bg-white px-4 py-2 text-sm disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

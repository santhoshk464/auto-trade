"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { ThemeToggle } from "@/components/theme-toggle";

type Broker = {
  id: string;
  type: string;
  name: string;
  brokerIdMasked: string;
  appIdMasked: string;
  appSecretMasked: string;
  status: "ACTIVE" | "INACTIVE";
  connectionStatus: "Connected" | "Not Connected";
  lastTokenGeneratedAt: string | null;
  addedAt: string;
};

export default function BrokersPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [loadingBrokers, setLoadingBrokers] = useState(false);
  // NSE broker (KITE / ANGEL) — used by option-monitor, trade-terminal etc.
  const [selectedBrokerId, setSelectedBrokerId] = useState<string | null>(null);
  // Crypto broker (DELTA) — independent selection, does not affect NSE pages
  const [selectedDeltaBrokerId, setSelectedDeltaBrokerId] = useState<
    string | null
  >(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("at.selectedBrokerId");
      setSelectedBrokerId(saved || null);
      const savedDelta = window.localStorage.getItem(
        "at.selectedDeltaBrokerId",
      );
      setSelectedDeltaBrokerId(savedDelta || null);
    } catch {
      setSelectedBrokerId(null);
      setSelectedDeltaBrokerId(null);
    }
  }, []);

  const userInitials = (() => {
    const name = user?.name?.trim();
    if (!name) return "U";
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || "U";
    const second = parts.length > 1 ? parts[1]?.[0] : "";
    return (first + second).toUpperCase();
  })();

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  async function load() {
    setLoadingBrokers(true);
    try {
      const res = await apiFetch<{ brokers: Broker[] }>("/brokers");
      setBrokers(res.brokers);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load brokers");
    } finally {
      setLoadingBrokers(false);
    }
  }

  useEffect(() => {
    if (!loading && user) {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  async function connect(brokerId: string) {
    try {
      const res = await apiFetch<{ loginUrl: string | null; message?: string }>(
        `/brokers/kite/login-url?brokerId=${encodeURIComponent(brokerId)}`,
      );
      if (!res.loginUrl) {
        toast.error(res.message || "Cannot connect this broker");
        return;
      }
      window.location.href = res.loginUrl;
    } catch (err: any) {
      toast.error(err?.message || "Failed to start connection");
    }
  }

  async function deleteBroker(brokerId: string) {
    const ok = window.confirm("Delete this broker?");
    if (!ok) return;
    try {
      await apiFetch(`/brokers/${encodeURIComponent(brokerId)}`, {
        method: "DELETE",
      });
      toast.success("Broker deleted");
      await load();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete broker");
    }
  }

  function toggleSelectedBroker(brokerId: string, brokerType: string) {
    if (brokerType === "DELTA") {
      // Delta selection is independent — does not touch NSE broker
      const next = selectedDeltaBrokerId === brokerId ? null : brokerId;
      setSelectedDeltaBrokerId(next);
      try {
        if (next) window.localStorage.setItem("at.selectedDeltaBrokerId", next);
        else window.localStorage.removeItem("at.selectedDeltaBrokerId");
      } catch {
        /* ignore */
      }
    } else {
      // NSE broker (KITE / ANGEL) — single active selection for NSE pages
      const next = selectedBrokerId === brokerId ? null : brokerId;
      setSelectedBrokerId(next);
      try {
        if (next) window.localStorage.setItem("at.selectedBrokerId", next);
        else window.localStorage.removeItem("at.selectedBrokerId");
      } catch {
        /* ignore */
      }
    }
  }

  function openTradeWindow() {
    if (!selectedBrokerId) {
      toast.error("Select a broker to trade");
      return;
    }
    const url = "/trade-terminal";

    const width = 1280;
    const height = 720;
    const left = Math.max(0, Math.floor((window.screen.width - width) / 2));
    const top = Math.max(0, Math.floor((window.screen.height - height) / 2));

    const features = [
      "popup=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
      "toolbar=no",
      "menubar=no",
      "location=no",
      "status=no",
      "noopener=yes",
      "noreferrer=yes",
    ].join(",");

    const win = window.open(url, "tradeWindow", features);
    if (!win) {
      toast.error("Popup blocked: allow popups to open Trade Window");
      return;
    }
    try {
      win.focus();
    } catch {
      // ignore
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* ── Header ── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
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
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Dashboard
            </Link>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span className="text-sm font-semibold text-slate-900 dark:text-white">
              Brokers
            </span>
          </div>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-600 text-xs font-bold text-white">
              {userInitials}
            </div>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* Page title + actions */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              Broker Accounts
            </h1>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Connect and manage your trading broker integrations
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
              onClick={load}
              disabled={loadingBrokers}
              type="button"
            >
              <svg
                className={`w-4 h-4 ${loadingBrokers ? "animate-spin" : ""}`}
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
              {loadingBrokers ? "Refreshing…" : "Refresh"}
            </button>

            <button
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              onClick={openTradeWindow}
              type="button"
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
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              Trade Window
            </button>

            <Link
              href="/brokers/add"
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-sm font-semibold text-white transition-colors shadow-sm"
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
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Broker
            </Link>
          </div>
        </div>

        {/* ── Broker table ── */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[2fr_1.2fr_1.4fr_1fr_1fr_auto] gap-0 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            <span>Broker</span>
            <span>App ID</span>
            <span>Secret</span>
            <span>Connection</span>
            <span>Added</span>
            <span className="text-right">Actions</span>
          </div>

          {loadingBrokers ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {[1, 2, 3].map((i) => (
                <div key={i} className="grid grid-cols-[2fr_1.2fr_1.4fr_1fr_1fr_auto] gap-0 items-center px-5 py-4 animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-lg bg-slate-100 dark:bg-slate-800" />
                    <div className="space-y-1.5">
                      <div className="h-3.5 w-28 rounded bg-slate-100 dark:bg-slate-800" />
                      <div className="h-2.5 w-20 rounded bg-slate-100 dark:bg-slate-800" />
                    </div>
                  </div>
                  <div className="h-3 w-24 rounded bg-slate-100 dark:bg-slate-800" />
                  <div className="h-3 w-32 rounded bg-slate-100 dark:bg-slate-800" />
                  <div className="h-3 w-20 rounded bg-slate-100 dark:bg-slate-800" />
                  <div className="h-3 w-16 rounded bg-slate-100 dark:bg-slate-800" />
                  <div className="h-7 w-24 rounded bg-slate-100 dark:bg-slate-800 ml-auto" />
                </div>
              ))}
            </div>
          ) : brokers.length === 0 ? (
            <div className="px-8 py-16 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
                <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">No brokers yet</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Add your first broker to start trading.</p>
              <Link href="/brokers/add" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-2 text-sm font-semibold text-white transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Broker
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {brokers.map((b) => {
                const isSelected =
                  b.type === "DELTA"
                    ? selectedDeltaBrokerId === b.id
                    : selectedBrokerId === b.id;
                const isConnected = b.connectionStatus === "Connected";
                const isDelta = b.type === "DELTA";
                return (
                  <div
                    key={b.id}
                    className={`group grid grid-cols-[2fr_1.2fr_1.4fr_1fr_1fr_auto] gap-0 items-center px-5 py-4 transition-colors ${
                      isSelected
                        ? "bg-cyan-50/60 dark:bg-cyan-900/10"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    }`}
                  >
                    {/* Broker name + type + status */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                        isDelta
                          ? "bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400"
                          : "bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400"
                      }`}>
                        {b.type.slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">{b.name}</span>
                          {isSelected && (
                            <span className="shrink-0 rounded-full bg-cyan-600 px-2 py-0.5 text-[10px] font-semibold text-white">Active</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${
                            b.status === "ACTIVE"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-slate-400 dark:text-slate-500"
                          }`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${b.status === "ACTIVE" ? "bg-emerald-500" : "bg-slate-400"}`} />
                            {b.status}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate">{b.brokerIdMasked}</span>
                        </div>
                      </div>
                    </div>

                    {/* App ID */}
                    <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate pr-3">
                      {b.appIdMasked}
                    </span>

                    {/* Secret — truncated, never overflow */}
                    <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate pr-3 max-w-45">
                      {b.appSecretMasked}
                    </span>

                    {/* Connection */}
                    <div>
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                        isConnected ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-emerald-500" : "bg-amber-500"}`} />
                        {b.connectionStatus}
                      </span>
                      {b.lastTokenGeneratedAt && (
                        <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                          {new Date(b.lastTokenGeneratedAt).toLocaleString()}
                        </div>
                      )}
                    </div>

                    {/* Added */}
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {new Date(b.addedAt).toLocaleDateString()}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-1.5">
                      {/* Generate Token — Kite only */}
                      {!isDelta && (
                        <button
                          className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors"
                          onClick={() => connect(b.id)}
                          type="button"
                          title="Generate access token"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          Token
                        </button>
                      )}

                      {/* Select / deselect */}
                      <button
                        className={`inline-flex items-center justify-center rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          isSelected
                            ? "border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400"
                            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
                        }`}
                        onClick={() => toggleSelectedBroker(b.id, b.type)}
                        type="button"
                        title={isSelected ? "Deselect" : "Select for trading"}
                      >
                        {isSelected ? (
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6z"/><path d="M14 5h4v14h-4z"/></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        )}
                      </button>

                      {/* Delete */}
                      <button
                        className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800 transition-colors"
                        onClick={() => deleteBroker(b.id)}
                        type="button"
                        title="Delete broker"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

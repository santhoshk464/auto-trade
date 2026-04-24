"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";

interface SymbolSettings {
  symbol: string;
  hedgeLots: number;
  sellLots: number;
  paperLots: number;
  bufferPoints: number;
  liveEnabled: boolean;
  placeQtyBasedOnSL: boolean;
  perTradeLoss: number;
  perDayLoss: number;
  enableNiftyTrendFilter: boolean;
  enableConfluenceChecker: boolean;
  deduplicateSignals: boolean;
}

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"];

export default function SettingsPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [activeTab, setActiveTab] = useState("NIFTY");
  const [settings, setSettings] = useState<Record<string, SymbolSettings>>({});
  const [saving, setSaving] = useState(false);
  const [togglingLive, setTogglingLive] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);

  // Form state for current tab
  const [hedgeLots, setHedgeLots] = useState(1);
  const [sellLots, setSellLots] = useState(1);
  const [paperLots, setPaperLots] = useState(1);
  const [bufferPoints, setBufferPoints] = useState(5);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [placeQtyBasedOnSL, setPlaceQtyBasedOnSL] = useState(false);
  const [perTradeLoss, setPerTradeLoss] = useState(20000);
  const [perDayLoss, setPerDayLoss] = useState(40000);
  const [enableNiftyTrendFilter, setEnableNiftyTrendFilter] = useState(false);
  const [enableConfluenceChecker, setEnableConfluenceChecker] = useState(false);
  const [deduplicateSignals, setDeduplicateSignals] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  // Load all settings on mount
  useEffect(() => {
    if (loading || !user) return;

    const loadSettings = async () => {
      try {
        const response = await apiFetch<SymbolSettings[]>("/settings/trading");
        const settingsMap: Record<string, SymbolSettings> = {};

        // Initialize with defaults
        SYMBOLS.forEach((symbol) => {
          settingsMap[symbol] = {
            symbol,
            hedgeLots: 1,
            sellLots: 1,
            paperLots: 1,
            bufferPoints: 5,
            liveEnabled: false,
            placeQtyBasedOnSL: false,
            perTradeLoss: 20000,
            perDayLoss: 40000,
            enableNiftyTrendFilter: false,
            enableConfluenceChecker: false,
            deduplicateSignals: true,
          };
        });

        // Override with saved settings
        response.forEach((s) => {
          settingsMap[s.symbol] = s;
        });

        setSettings(settingsMap);

        // Set form values for active tab
        const activeSettings = settingsMap[activeTab];
        if (activeSettings) {
          setHedgeLots(activeSettings.hedgeLots);
          setSellLots(activeSettings.sellLots);
          setPaperLots(activeSettings.paperLots ?? 1);
          setBufferPoints(activeSettings.bufferPoints);
          setLiveEnabled(activeSettings.liveEnabled ?? false);
          setPlaceQtyBasedOnSL(activeSettings.placeQtyBasedOnSL ?? false);
          setPerTradeLoss(activeSettings.perTradeLoss ?? 20000);
          setPerDayLoss(activeSettings.perDayLoss ?? 40000);
          setEnableNiftyTrendFilter(
            activeSettings.enableNiftyTrendFilter ?? false,
          );
          setEnableConfluenceChecker(
            activeSettings.enableConfluenceChecker ?? false,
          );
          setDeduplicateSignals(activeSettings.deduplicateSignals ?? true);
        }
      } catch (error: any) {
        console.error("Failed to load settings:", error);
        toast.error("Failed to load settings");
      } finally {
        setLoadingSettings(false);
      }
    };

    loadSettings();
  }, [loading, user]);

  // Update form values when tab changes
  useEffect(() => {
    const activeSettings = settings[activeTab];
    if (activeSettings) {
      setHedgeLots(activeSettings.hedgeLots);
      setSellLots(activeSettings.sellLots);
      setPaperLots(activeSettings.paperLots ?? 1);
      setBufferPoints(activeSettings.bufferPoints);
      setLiveEnabled(activeSettings.liveEnabled ?? false);
      setPlaceQtyBasedOnSL(activeSettings.placeQtyBasedOnSL ?? false);
      setPerTradeLoss(activeSettings.perTradeLoss ?? 20000);
      setPerDayLoss(activeSettings.perDayLoss ?? 40000);
      setEnableNiftyTrendFilter(activeSettings.enableNiftyTrendFilter ?? false);
      setEnableConfluenceChecker(
        activeSettings.enableConfluenceChecker ?? false,
      );
      setDeduplicateSignals(activeSettings.deduplicateSignals ?? true);
    }
  }, [activeTab, settings]);

  const handleToggleLive = async () => {
    const newValue = !liveEnabled;
    setLiveEnabled(newValue);
    setTogglingLive(true);
    try {
      const response = await apiFetch<SymbolSettings>("/settings/trading", {
        method: "POST",
        json: {
          symbol: activeTab,
          hedgeLots,
          sellLots,
          paperLots,
          bufferPoints,
          liveEnabled: newValue,
          placeQtyBasedOnSL,
          perTradeLoss,
          perDayLoss,
          enableNiftyTrendFilter,
          enableConfluenceChecker,
          deduplicateSignals,
        },
      });
      setSettings((prev) => ({ ...prev, [activeTab]: response }));
      toast.success(
        newValue
          ? `🟢 Live trading ON for ${activeTab}`
          : `⚪ Live trading OFF for ${activeTab}`,
      );
    } catch (error: any) {
      // Revert toggle on error
      setLiveEnabled(!newValue);
      toast.error(error?.message || "Failed to update live trading setting");
    } finally {
      setTogglingLive(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await apiFetch<SymbolSettings>("/settings/trading", {
        method: "POST",
        json: {
          symbol: activeTab,
          hedgeLots,
          sellLots,
          paperLots,
          bufferPoints,
          liveEnabled,
          placeQtyBasedOnSL,
          perTradeLoss,
          perDayLoss,
          enableNiftyTrendFilter,
          enableConfluenceChecker,
          deduplicateSignals,
        },
      });

      setSettings((prev) => ({
        ...prev,
        [activeTab]: response,
      }));

      toast.success(`${activeTab} settings saved successfully!`);
    } catch (error: any) {
      console.error("Failed to save settings:", error);
      toast.error(error?.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading || loadingSettings) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="text-zinc-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between p-4">
          <div className="font-semibold">⚙️ Settings</div>
          <Link
            href="/dashboard"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-100"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl p-6">
        <div className="rounded-xl border bg-white p-6">
          <h1 className="text-lg font-semibold mb-4">Trading Settings</h1>
          <p className="text-sm text-zinc-600 mb-6">
            Configure lot sizes for hedge positions and sell orders per symbol.
            These settings will be used when placing live orders.
          </p>

          {/* Symbol Tabs */}
          <div className="border-b border-zinc-200 mb-6">
            <nav className="flex space-x-4" aria-label="Tabs">
              {SYMBOLS.map((symbol) => (
                <button
                  key={symbol}
                  onClick={() => setActiveTab(symbol)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === symbol
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {symbol}
                </button>
              ))}
            </nav>
          </div>

          {/* Settings Form */}
          <div className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <h3 className="font-medium text-blue-800 mb-2">
                📊 {activeTab} Order Settings
              </h3>
              <p className="text-sm text-blue-700">
                Configure lot sizes for {activeTab} options trading. Hedge
                position will be bought first at ₹5 to reduce margin, then the
                main sell order will be placed.
              </p>
            </div>

            {/* Hedge Lots Input */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                Hedge Position Quantity (Lots)
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={hedgeLots}
                onChange={(e) => setHedgeLots(Number(e.target.value) || 1)}
                className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
              />
              <p className="mt-1 text-sm text-zinc-500">
                Number of lots for ₹5 hedge option (same type as signal - CE for
                CE, PE for PE)
              </p>
            </div>

            {/* Sell Lots Input */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                Sell Position Quantity (Lots)
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={sellLots}
                onChange={(e) => setSellLots(Number(e.target.value) || 1)}
                className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
              />
              <p className="mt-1 text-sm text-zinc-500">
                Number of lots for the main SELL order when signal is generated
              </p>
            </div>

            {/* Paper Trade Lots Input */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                📄 Paper Trade Lots
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={paperLots}
                onChange={(e) => setPaperLots(Number(e.target.value) || 1)}
                className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
              />
              {(() => {
                const lotSizes: Record<string, number> = {
                  NIFTY: 65,
                  BANKNIFTY: 30,
                  FINNIFTY: 65,
                  SENSEX: 20,
                };
                const unitSize = lotSizes[activeTab] ?? 1;
                return (
                  <p className="mt-1 text-sm text-zinc-500">
                    P&L will be calculated as{" "}
                    <strong>
                      {paperLots} lot{paperLots > 1 ? "s" : ""} × {unitSize} qty
                      = {paperLots * unitSize} units
                    </strong>{" "}
                    per trade on the Paper Trading page.
                  </p>
                );
              })()}
            </div>

            {/* Buffer Points Input */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-2">
                Buffer Points for Limit Order
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={bufferPoints}
                onChange={(e) => setBufferPoints(Number(e.target.value) || 5)}
                className="w-full rounded-lg border border-zinc-300 px-4 py-3 text-lg focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
              />
              <p className="mt-1 text-sm text-zinc-500">
                Points to add to signal price for limit order (e.g., Signal @
                ₹150 → Limit order @ ₹{150 + bufferPoints})
              </p>
            </div>

            {/* Live Trading Toggle */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-zinc-700">
                    🟢 Enable Live Trading
                  </label>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When enabled, real orders will be placed on your Kite
                    account when a {activeTab} signal fires.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggleLive}
                  disabled={togglingLive}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed ${
                    liveEnabled ? "bg-green-500" : "bg-zinc-300"
                  }`}
                  aria-checked={liveEnabled}
                  role="switch"
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      liveEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {liveEnabled && (
                <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                  ⚠️ <strong>Live trading is ON.</strong> Real orders will be
                  placed on your Kite account. Hedge + SELL orders will be sent
                  automatically when a signal is generated.
                </div>
              )}
            </div>

            {/* EMA Rejection – Dynamic Position Sizing */}
            <div className="rounded-lg border border-zinc-200 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-zinc-700">
                    📐 Place Qty Based on SL
                  </label>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When enabled, EMA Rejection lot size is auto-calculated from
                    Per Trade Loss ÷ (SL points × lot size). Wide SL → smaller
                    qty, tight SL → larger qty.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPlaceQtyBasedOnSL((v) => !v)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    placeQtyBasedOnSL ? "bg-blue-500" : "bg-zinc-300"
                  }`}
                  aria-checked={placeQtyBasedOnSL}
                  role="switch"
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      placeQtyBasedOnSL ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {placeQtyBasedOnSL && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">
                      💰 Per Trade Loss (₹)
                    </label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={perTradeLoss}
                      onChange={(e) =>
                        setPerTradeLoss(Number(e.target.value) || 20000)
                      }
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
                    />
                    <p className="mt-0.5 text-xs text-zinc-500">
                      Max loss per EMA Rejection trade (INR)
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-700 mb-1">
                      📅 Per Day Loss (₹)
                    </label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={perDayLoss}
                      onChange={(e) =>
                        setPerDayLoss(Number(e.target.value) || 40000)
                      }
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none"
                    />
                    <p className="mt-0.5 text-xs text-zinc-500">
                      EMA Rejection stops for the day after this loss (INR)
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* NIFTY Futures Trend Filter */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-zinc-700">
                    📈 NIFTY Futures Trend Filter
                  </label>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When enabled, checks NIFTY Futures 5m chart before firing
                    any CE/PE sell signal. Uses SuperTrend(10,2) + VWAP +
                    VWMA(20) — all three must agree. CE sell only when trend is
                    DOWN. PE sell only when trend is UP. Volume gate: futures 1m
                    candle must be &gt; 120,000.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnableNiftyTrendFilter((v) => !v)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    enableNiftyTrendFilter ? "bg-indigo-500" : "bg-zinc-300"
                  }`}
                  aria-checked={enableNiftyTrendFilter}
                  role="switch"
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      enableNiftyTrendFilter ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {enableNiftyTrendFilter && (
                <div className="mt-3 rounded-md bg-indigo-50 border border-indigo-200 p-3 text-xs text-indigo-800">
                  ✅ <strong>Trend filter is ON.</strong> Signals that conflict
                  with the NIFTY Futures trend direction will be suppressed.
                  Uses 5-minute candles with 1-minute volume confirmation.
                </div>
              )}
            </div>

            {/* Confluence Checker */}
            <div className="bg-white border border-zinc-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <label className="text-sm font-medium text-zinc-800">
                    🎯 Confluence Checker
                  </label>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Grades each signal A++ / A / B / C using 5 checks:
                    SuperTrend(5m), VWAP(5m), Daily 20-EMA trend, INDIA VIX
                    direction, option prevDay close position. Score 0–8 is
                    stored on every signal. Does NOT block signals — use Trend
                    Filter for blocking.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnableConfluenceChecker((v) => !v)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    enableConfluenceChecker ? "bg-emerald-500" : "bg-zinc-300"
                  }`}
                  aria-checked={enableConfluenceChecker}
                  role="switch"
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      enableConfluenceChecker
                        ? "translate-x-5"
                        : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {enableConfluenceChecker && (
                <div className="mt-3 rounded-md bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800">
                  ✅ <strong>Confluence checker is ON.</strong> Each signal will
                  be scored and graded. <strong>A++ (7–8)</strong> = high
                  confidence | <strong>A (5–6)</strong> = normal |{" "}
                  <strong>B (3–4)</strong> = caution | <strong>C (0–2)</strong>{" "}
                  = weak. Grade is saved to the signal record and shown in logs.
                </div>
              )}
            </div>

            {/* Deduplicate Signals */}
            <div className="bg-white border border-zinc-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <label className="text-sm font-medium text-zinc-800">
                    🔁 Deduplicate Signals
                  </label>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When ON, shows only the earliest SELL + earliest BUY per
                    option per day. Multiple sub-strategy signals (EMA, DLB,
                    DHR, Day Reversal) on the same option are collapsed into
                    one. If the first SELL hits SL, one re-entry is allowed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDeduplicateSignals((v) => !v)}
                  className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    deduplicateSignals ? "bg-violet-500" : "bg-zinc-300"
                  }`}
                  aria-checked={deduplicateSignals}
                  role="switch"
                >
                  <span
                    className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      deduplicateSignals ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {!deduplicateSignals && (
                <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                  ⚠️ <strong>Deduplication is OFF.</strong> All sub-strategy
                  signals will be shown. Multiple SELL signals may appear for
                  the same option in Trade Finder and auto-trade.
                </div>
              )}
            </div>

            {/* Lot Size Info */}
            <div className="bg-zinc-100 rounded-lg p-4">
              <h4 className="text-sm font-medium text-zinc-700 mb-2">
                📋 Lot Size Reference
              </h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-zinc-600">NIFTY:</span>{" "}
                  <span className="font-medium">65 per lot</span>
                </div>
                <div>
                  <span className="text-zinc-600">BANKNIFTY:</span>{" "}
                  <span className="font-medium">30 per lot</span>
                </div>
                <div>
                  <span className="text-zinc-600">FINNIFTY:</span>{" "}
                  <span className="font-medium">65 per lot</span>
                </div>
                <div>
                  <span className="text-zinc-600">SENSEX:</span>{" "}
                  <span className="font-medium">20 per lot</span>
                </div>
              </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-4">
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : `Save ${activeTab} Settings`}
              </button>
            </div>
          </div>

          {/* Current Settings Summary */}
          <div className="mt-8 border-t pt-6">
            <h3 className="text-sm font-medium text-zinc-700 mb-4">
              📝 All Saved Settings
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {SYMBOLS.map((symbol) => {
                const s = settings[symbol];
                return (
                  <div
                    key={symbol}
                    className={`p-3 rounded-lg border ${
                      symbol === activeTab
                        ? "border-blue-300 bg-blue-50"
                        : "border-zinc-200 bg-zinc-50"
                    }`}
                  >
                    <div className="font-medium text-sm">{symbol}</div>
                    <div className="text-xs text-zinc-600 mt-1">
                      Hedge: {s?.hedgeLots || 1} lots
                    </div>
                    <div className="text-xs text-zinc-600">
                      Sell: {s?.sellLots || 1} lots
                    </div>
                    <div className="text-xs text-zinc-600">
                      Buffer: {s?.bufferPoints || 5} pts
                    </div>
                    <div
                      className={`text-xs font-medium mt-1 ${
                        s?.liveEnabled ? "text-green-600" : "text-zinc-400"
                      }`}
                    >
                      {s?.liveEnabled ? "🟢 Live ON" : "⚪ Live OFF"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

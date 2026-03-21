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
                  className={`relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed ${
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

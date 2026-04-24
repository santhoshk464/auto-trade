"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";

// ─── DHR param types ──────────────────────────────────────────────────────────

interface DhrConfigFields {
  // Zone detection
  touchTolerance: number;
  sweepBuffer: number;
  zoneCooldownCandles: number;
  zoneRearmMoveAwayPts: number;
  minRearmCandles: number;
  // Rejection quality
  minUpperWickRatio: number;
  minBearishBodyRatio: number;
  maxLowerWickRatio: number;
  // Stop loss
  stopLossBuffer: number;
  // Session gate
  ema20SessionTolerance: number;
  // 1-minute confirmation
  useOneMinuteEntryConfirmation: boolean;
  oneMinuteConfirmationWindow: number;
  enableTwoCandleConfirm: boolean;
  enableLowBreakConfirm: boolean;
  enableLowerHighBreakConfirm: boolean;
  enableFiveMinuteSignalLowBreakConfirm: boolean;
  oneMinuteStopBuffer: number;
  fiveMinuteSignalStopBuffer: number;
  // Direct entry quality
  minDirectEntryBodyRatio: number;
  minDirectEntryWickRatio: number;
  preferWickRejection: boolean;
  // Room-to-move filter
  enableRoomToMoveFilter: boolean;
  minRoomToMovePts: number;
  minRoomToMoveRiskRatio: number;
  // Session compression filter
  enableSessionCompressionFilter: boolean;
  compressionFirstHourCandles: number;
  compressionFirstHourAtrRatio: number;
  compressionRecentWindow: number;
  compressionOverlapThreshold: number;
  blockRepeatedSignalsWhenCompressed: boolean;
  // Trade time window
  tradeStartMins: number;
  tradeEndMins: number;
}

interface StrategyConfigResponse {
  strategyName: string;
  defaults: DhrConfigFields;
  saved: Partial<DhrConfigFields>;
  effective: DhrConfigFields;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function minsToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

// ─── Field components ────────────────────────────────────────────────────────

function NumberField({
  label,
  value,
  defaultValue,
  onChange,
  step = 1,
  min,
  description,
}: {
  label: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  description?: string;
}) {
  const isCustom = value !== defaultValue;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        {isCustom && (
          <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded">
            custom
          </span>
        )}
      </div>
      {description && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      <div className="flex gap-2 items-center">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-28 px-2 py-1.5 text-sm border rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent"
        />
        {isCustom && (
          <button
            onClick={() => onChange(defaultValue)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 underline"
          >
            reset ({defaultValue})
          </button>
        )}
        {!isCustom && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            default
          </span>
        )}
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  defaultValue,
  onChange,
  description,
}: {
  label: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
  description?: string;
}) {
  const isCustom = value !== defaultValue;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        {isCustom && (
          <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded">
            custom
          </span>
        )}
      </div>
      {description && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      <div className="flex gap-2 items-center">
        <input
          type="time"
          value={minsToTime(value)}
          onChange={(e) => onChange(timeToMins(e.target.value))}
          className="px-2 py-1.5 text-sm border rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-fuchsia-500 focus:border-transparent"
        />
        {isCustom && (
          <button
            onClick={() => onChange(defaultValue)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 underline"
          >
            reset ({minsToTime(defaultValue)})
          </button>
        )}
        {!isCustom && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            default
          </span>
        )}
      </div>
    </div>
  );
}

function ToggleField({
  label,
  value,
  defaultValue,
  onChange,
  description,
}: {
  label: string;
  value: boolean;
  defaultValue: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  const isCustom = value !== defaultValue;
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {label}
          </span>
          {isCustom && (
            <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded">
              custom
            </span>
          )}
        </div>
        {description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {description}
          </p>
        )}
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-fuchsia-500 focus:ring-offset-1 ${
          value ? "bg-fuchsia-600" : "bg-gray-200 dark:bg-gray-700"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 pb-1 mt-6 mb-3">
      {title}
    </h3>
  );
}

// ─── DHR Tab ─────────────────────────────────────────────────────────────────

function DhrTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState<DhrConfigFields | null>(null);
  const [form, setForm] = useState<DhrConfigFields | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const data = await apiFetch<StrategyConfigResponse>(
        "/strategy-config/DAY_HIGH_REJECTION",
      );
      setDefaults(data.defaults as DhrConfigFields);
      setForm(data.effective as DhrConfigFields);
    } catch {
      toast.error("Failed to load DHR config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const set = <K extends keyof DhrConfigFields>(
    key: K,
    value: DhrConfigFields[K],
  ) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/strategy-config/DAY_HIGH_REJECTION", {
        method: "PUT",
        json: { config: form },
      });
      toast.success("DHR config saved");
    } catch {
      toast.error("Failed to save DHR config");
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = async () => {
    if (!defaults) return;
    setSaving(true);
    try {
      await apiFetch("/strategy-config/DAY_HIGH_REJECTION", {
        method: "PUT",
        json: { config: {} },
      });
      setForm({ ...defaults });
      toast.success("DHR config reset to defaults");
    } catch {
      toast.error("Failed to reset DHR config");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form || !defaults) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-fuchsia-600" />
      </div>
    );
  }

  const countCustom = Object.keys(form).filter(
    (k) =>
      form[k as keyof DhrConfigFields] !== defaults[k as keyof DhrConfigFields],
  ).length;

  return (
    <div className="space-y-2">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Day High Rejection (DHR)
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Bearish sell setup — candle touches rolling session high and shows
            rejection.
            {countCustom > 0 && (
              <span className="ml-2 text-amber-600 dark:text-amber-400 font-medium">
                {countCustom} custom value{countCustom !== 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleResetAll}
            disabled={saving || countCustom === 0}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Reset All
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-fuchsia-600 hover:bg-fuchsia-700 disabled:bg-fuchsia-400 text-white rounded-lg transition-colors font-medium"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0">
        {/* Zone Detection */}
        <div>
          <SectionHeader title="Zone Detection" />
          <div className="space-y-4">
            <NumberField
              label="Touch Tolerance (pts)"
              value={form.touchTolerance}
              defaultValue={defaults.touchTolerance}
              onChange={(v) => set("touchTolerance", v)}
              min={0}
              description="Max pts candle high can be above/below rolling high for zone test"
            />
            <NumberField
              label="Sweep Buffer (pts)"
              value={form.sweepBuffer}
              defaultValue={defaults.sweepBuffer}
              onChange={(v) => set("sweepBuffer", v)}
              min={0}
              description="Max pts a candle can overshoot the zone and still qualify as sweep"
            />
            <NumberField
              label="Zone Cooldown Candles"
              value={form.zoneCooldownCandles}
              defaultValue={defaults.zoneCooldownCandles}
              onChange={(v) => set("zoneCooldownCandles", v)}
              min={1}
              description="Candles to suppress re-signals from same zone after a signal fires"
            />
            <NumberField
              label="Zone Rearm Move Away (pts)"
              value={form.zoneRearmMoveAwayPts}
              defaultValue={defaults.zoneRearmMoveAwayPts}
              onChange={(v) => set("zoneRearmMoveAwayPts", v)}
              min={0}
              description="Zone rearmed early if close drops this many pts below zone"
            />
            <NumberField
              label="Min Rearm Candles"
              value={form.minRearmCandles}
              defaultValue={defaults.minRearmCandles}
              onChange={(v) => set("minRearmCandles", v)}
              min={1}
              description="Minimum candles before move-away can trigger early rearm"
            />
          </div>
        </div>

        {/* Rejection Quality */}
        <div>
          <SectionHeader title="Rejection Quality" />
          <div className="space-y-4">
            <NumberField
              label="Min Upper Wick Ratio"
              value={form.minUpperWickRatio}
              defaultValue={defaults.minUpperWickRatio}
              onChange={(v) => set("minUpperWickRatio", v)}
              step={0.05}
              min={0}
              description="Min upper-wick / total-range for wick-based rejection (0–1)"
            />
            <NumberField
              label="Min Bearish Body Ratio"
              value={form.minBearishBodyRatio}
              defaultValue={defaults.minBearishBodyRatio}
              onChange={(v) => set("minBearishBodyRatio", v)}
              step={0.05}
              min={0}
              description="Min bearish-body / total-range for body-based rejection (0–1)"
            />
            <NumberField
              label="Max Lower Wick Ratio"
              value={form.maxLowerWickRatio}
              defaultValue={defaults.maxLowerWickRatio}
              onChange={(v) => set("maxLowerWickRatio", v)}
              step={0.05}
              min={0}
              description="Lower wick must be ≤ this ratio of upper wick (blocks bullish demand)"
            />
            <NumberField
              label="Stop Loss Buffer (pts)"
              value={form.stopLossBuffer}
              defaultValue={defaults.stopLossBuffer}
              onChange={(v) => set("stopLossBuffer", v)}
              min={0}
              description="Points above zone reference for stop-loss placement"
            />
          </div>

          <SectionHeader title="Session Gate" />
          <div className="space-y-4">
            <NumberField
              label="EMA20 Session Tolerance"
              value={form.ema20SessionTolerance}
              defaultValue={defaults.ema20SessionTolerance}
              onChange={(v) => set("ema20SessionTolerance", v)}
              step={0.001}
              min={0}
              description="Fractional tolerance above EMA20 for session activation (e.g. 0.005 = 0.5%)"
            />
          </div>
        </div>

        {/* Direct Entry */}
        <div>
          <SectionHeader title="Direct Entry Quality Gate" />
          <div className="space-y-4">
            <NumberField
              label="Min Direct Entry Body Ratio"
              value={form.minDirectEntryBodyRatio}
              defaultValue={defaults.minDirectEntryBodyRatio}
              onChange={(v) => set("minDirectEntryBodyRatio", v)}
              step={0.05}
              min={0}
              description="Min bearish body ratio for direct (no-1m-confirmation) entry"
            />
            <NumberField
              label="Min Direct Entry Wick Ratio"
              value={form.minDirectEntryWickRatio}
              defaultValue={defaults.minDirectEntryWickRatio}
              onChange={(v) => set("minDirectEntryWickRatio", v)}
              step={0.05}
              min={0}
              description="Min upper-wick ratio for direct (no-1m-confirmation) entry"
            />
            <ToggleField
              label="Prefer Wick Rejection"
              value={form.preferWickRejection}
              defaultValue={defaults.preferWickRejection}
              onChange={(v) => set("preferWickRejection", v)}
              description="Only body-only rejections skip direct entry; wick always allowed"
            />
          </div>
        </div>

        {/* 1-Minute Confirmation */}
        <div>
          <SectionHeader title="1-Minute Confirmation" />
          <div className="space-y-2">
            <ToggleField
              label="Use 1-Minute Entry Confirmation"
              value={form.useOneMinuteEntryConfirmation}
              defaultValue={defaults.useOneMinuteEntryConfirmation}
              onChange={(v) => set("useOneMinuteEntryConfirmation", v)}
              description="Wait for 1m candle confirmation before firing the signal"
            />
            <NumberField
              label="1m Confirmation Window"
              value={form.oneMinuteConfirmationWindow}
              defaultValue={defaults.oneMinuteConfirmationWindow}
              onChange={(v) => set("oneMinuteConfirmationWindow", v)}
              min={1}
              description="Max 1m candles to look at after 5m setup candle (0 = no limit)"
            />
            <ToggleField
              label="Two-Candle Confirm (Option A)"
              value={form.enableTwoCandleConfirm}
              defaultValue={defaults.enableTwoCandleConfirm}
              onChange={(v) => set("enableTwoCandleConfirm", v)}
              description="Two consecutive bearish 1m candles → entry"
            />
            <ToggleField
              label="Low-Break Confirm (Option B)"
              value={form.enableLowBreakConfirm}
              defaultValue={defaults.enableLowBreakConfirm}
              onChange={(v) => set("enableLowBreakConfirm", v)}
              description="Rejection candle then next breaks its low → entry"
            />
            <ToggleField
              label="Lower-High Break Confirm (Option C)"
              value={form.enableLowerHighBreakConfirm}
              defaultValue={defaults.enableLowerHighBreakConfirm}
              onChange={(v) => set("enableLowerHighBreakConfirm", v)}
              description="1m lower-high forms then local support breaks → entry (noisier)"
            />
            <ToggleField
              label="5m Signal Low-Break Confirm (Option D)"
              value={form.enableFiveMinuteSignalLowBreakConfirm}
              defaultValue={defaults.enableFiveMinuteSignalLowBreakConfirm}
              onChange={(v) => set("enableFiveMinuteSignalLowBreakConfirm", v)}
              description="1m close below 5m setup candle low → entry"
            />
            <NumberField
              label="1m Stop Buffer (pts)"
              value={form.oneMinuteStopBuffer}
              defaultValue={defaults.oneMinuteStopBuffer}
              onChange={(v) => set("oneMinuteStopBuffer", v)}
              min={0}
              description="Extra buffer above 1m trigger candle high for stop-loss"
            />
            <NumberField
              label="5m Signal Stop Buffer (pts)"
              value={form.fiveMinuteSignalStopBuffer}
              defaultValue={defaults.fiveMinuteSignalStopBuffer}
              onChange={(v) => set("fiveMinuteSignalStopBuffer", v)}
              min={0}
              description="Buffer above 5m setup candle high for Option D stop-loss"
            />
          </div>
        </div>

        {/* Room to Move */}
        <div>
          <SectionHeader title="Room-to-Move Filter" />
          <div className="space-y-3">
            <ToggleField
              label="Enable Room-to-Move Filter"
              value={form.enableRoomToMoveFilter}
              defaultValue={defaults.enableRoomToMoveFilter}
              onChange={(v) => set("enableRoomToMoveFilter", v)}
              description="Skip signals without enough downside room to session low"
            />
            <NumberField
              label="Min Room to Move (pts)"
              value={form.minRoomToMovePts}
              defaultValue={defaults.minRoomToMovePts}
              onChange={(v) => set("minRoomToMovePts", v)}
              min={0}
              description="Min fixed points required between entry and session low"
            />
            <NumberField
              label="Min Room / Risk Ratio"
              value={form.minRoomToMoveRiskRatio}
              defaultValue={defaults.minRoomToMoveRiskRatio}
              onChange={(v) => set("minRoomToMoveRiskRatio", v)}
              step={0.1}
              min={0}
              description="(entry − session low) must be ≥ this ratio × risk"
            />
          </div>
        </div>

        {/* Session Compression */}
        <div>
          <SectionHeader title="Session Compression Filter" />
          <div className="space-y-3">
            <ToggleField
              label="Enable Compression Filter"
              value={form.enableSessionCompressionFilter}
              defaultValue={defaults.enableSessionCompressionFilter}
              onChange={(v) => set("enableSessionCompressionFilter", v)}
              description="Restrict signals on range-bound / compressed sessions"
            />
            <NumberField
              label="First Hour Candles"
              value={form.compressionFirstHourCandles}
              defaultValue={defaults.compressionFirstHourCandles}
              onChange={(v) => set("compressionFirstHourCandles", v)}
              min={1}
              description="Number of opening candles used as first-hour sample"
            />
            <NumberField
              label="First Hour ATR Ratio"
              value={form.compressionFirstHourAtrRatio}
              defaultValue={defaults.compressionFirstHourAtrRatio}
              onChange={(v) => set("compressionFirstHourAtrRatio", v)}
              step={0.05}
              min={0}
              description="Max first-hour range as fraction of ATR for 'compressed' flag"
            />
            <NumberField
              label="Recent Candle Window"
              value={form.compressionRecentWindow}
              defaultValue={defaults.compressionRecentWindow}
              onChange={(v) => set("compressionRecentWindow", v)}
              min={1}
              description="How many recent candles to examine for overlap scoring"
            />
            <NumberField
              label="Overlap Threshold"
              value={form.compressionOverlapThreshold}
              defaultValue={defaults.compressionOverlapThreshold}
              onChange={(v) => set("compressionOverlapThreshold", v)}
              step={0.05}
              min={0}
              description="Fraction of recent candles that must overlap for compressed flag"
            />
            <ToggleField
              label="Block Repeated Signals When Compressed"
              value={form.blockRepeatedSignalsWhenCompressed}
              defaultValue={defaults.blockRepeatedSignalsWhenCompressed}
              onChange={(v) => set("blockRepeatedSignalsWhenCompressed", v)}
              description="When compressed AND a prior signal fired, block further signals"
            />
          </div>
        </div>

        {/* Trade Time Window */}
        <div>
          <SectionHeader title="Trade Time Window" />
          <div className="space-y-4">
            <TimeField
              label="Trade Start Time"
              value={form.tradeStartMins}
              defaultValue={defaults.tradeStartMins}
              onChange={(v) => set("tradeStartMins", v)}
              description="Earliest time a signal is allowed (IST)"
            />
            <TimeField
              label="Trade End Time"
              value={form.tradeEndMins}
              defaultValue={defaults.tradeEndMins}
              onChange={(v) => set("tradeEndMins", v)}
              description="Latest time a signal is allowed (IST)"
            />
          </div>
        </div>
      </div>

      {/* Bottom save */}
      <div className="flex justify-end gap-3 mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={handleResetAll}
          disabled={saving || countCustom === 0}
          className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Reset All to Defaults
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 text-sm bg-fuchsia-600 hover:bg-fuchsia-700 disabled:bg-fuchsia-400 text-white rounded-lg transition-colors font-semibold"
        >
          {saving ? "Saving…" : "Save DHR Config"}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "DHR", label: "Day High Rejection" },
  { id: "SIGNALS", label: "Signals" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ─── Signals Tab ─────────────────────────────────────────────────────────────

function SignalsTab() {
  const [deduplicateSignals, setDeduplicateSignals] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{ deduplicateSignals?: boolean }>("/settings/trading/NIFTY")
      .then((s) => setDeduplicateSignals(s.deduplicateSignals ?? true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async (value: boolean) => {
    setSaving(true);
    try {
      // Fetch current settings first so we don't clobber other fields
      const current = await apiFetch<Record<string, unknown>>(
        "/settings/trading/NIFTY",
      );
      // Only send DTO-allowed fields — spreading the full DB row causes
      // forbidNonWhitelisted validation errors (id, userId, createdAt, etc.)
      await apiFetch("/settings/trading", {
        method: "POST",
        json: {
          symbol: "NIFTY",
          hedgeLots: current.hedgeLots ?? 1,
          sellLots: current.sellLots ?? 1,
          paperLots: current.paperLots,
          bufferPoints: current.bufferPoints,
          liveEnabled: current.liveEnabled,
          placeQtyBasedOnSL: current.placeQtyBasedOnSL,
          perTradeLoss: current.perTradeLoss,
          perDayLoss: current.perDayLoss,
          enableNiftyTrendFilter: current.enableNiftyTrendFilter,
          enableConfluenceChecker: current.enableConfluenceChecker,
          deduplicateSignals: value,
        },
      });
      setDeduplicateSignals(value);
      toast.success(
        value ? "Signal deduplication ON" : "Signal deduplication OFF",
      );
    } catch {
      toast.error("Failed to save setting");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-fuchsia-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Signal Filtering
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Controls how multiple sub-strategy signals on the same option are
          handled within a trading day.
        </p>
      </div>

      {/* Deduplication toggle */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-900 dark:text-gray-100">
              🔁 Deduplicate Signals
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              When <strong>ON</strong>: shows only the <em>earliest</em> SELL +
              earliest BUY per option per day. If the first SELL hits SL, one
              re-entry is allowed.
              <br />
              When <strong>OFF</strong>: all sub-strategy signals are shown (EMA
              Rejection, DLB, DHR may all appear for the same option).
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => save(!deduplicateSignals)}
            className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-60 ${
              deduplicateSignals
                ? "bg-fuchsia-600"
                : "bg-gray-300 dark:bg-gray-600"
            }`}
            role="switch"
            aria-checked={deduplicateSignals}
          >
            <span
              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                deduplicateSignals ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {deduplicateSignals ? (
          <div className="mt-3 rounded-md bg-fuchsia-50 dark:bg-fuchsia-900/20 border border-fuchsia-200 dark:border-fuchsia-800 p-3 text-xs text-fuchsia-800 dark:text-fuchsia-300">
            ✅ <strong>Deduplication is ON.</strong> Trade Finder and auto-trade
            will show at most 1 SELL + 1 BUY per option per day.
          </div>
        ) : (
          <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300">
            ⚠️ <strong>Deduplication is OFF.</strong> All sub-strategy signals
            will be shown. Multiple SELL signals on the same option may appear.
          </div>
        )}
      </div>
    </div>
  );
}

export default function StrategiesPage() {
  const router = useRouter();
  const { user, loading } = useMe();
  const [activeTab, setActiveTab] = useState<TabId>("DHR");

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-fuchsia-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              ← Dashboard
            </Link>
            <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Strategy Configuration
            </h1>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Description */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Manage signal detection parameters for each strategy. Changes take
          effect immediately on new scans. Hardcoded defaults are used as
          fallback when no custom value is saved.
        </p>

        {/* Tab bar */}
        <div className="border-b border-gray-200 dark:border-gray-700 mb-6">
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t.id
                    ? "border-fuchsia-600 text-fuchsia-600 dark:text-fuchsia-400"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          {activeTab === "DHR" && <DhrTab />}
          {activeTab === "SIGNALS" && <SignalsTab />}
        </div>
      </div>
    </div>
  );
}

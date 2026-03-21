"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { ThemeToggle } from "@/components/theme-toggle";

type BrokerType = "KITE" | "ANGEL" | "DELTA";

const BROKER_LABELS: Record<BrokerType, string> = {
  KITE: "Zerodha Kite",
  ANGEL: "Angel Broking",
  DELTA: "Delta.Exchange",
};

const BROKER_DEFAULT_NAMES: Record<BrokerType, string> = {
  KITE: "Kite",
  ANGEL: "Angel",
  DELTA: "Delta.Exchange",
};

export default function AddBrokerPage() {
  const router = useRouter();
  const { user, loading } = useMe();

  const [type, setType] = useState<BrokerType>("KITE");
  const [name, setName] = useState("Kite");
  const [nameEdited, setNameEdited] = useState(false);

  function handleTypeChange(t: BrokerType) {
    setType(t);
    if (!nameEdited) setName(BROKER_DEFAULT_NAMES[t]);
  }
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch<{ broker: { id: string } }>("/brokers", {
        method: "POST",
        json: { type, name, apiKey, apiSecret },
      });
      toast.success("Broker added successfully");
      router.push("/brokers");
    } catch (err: any) {
      toast.error(err?.message || "Failed to add broker");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* ── Header ── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/brokers"
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
              Brokers
            </Link>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span className="text-sm font-semibold text-slate-900 dark:text-white">
              Add Broker
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* ── Main ── */}
      <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Add a Broker
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Connect your trading account by providing the broker API
            credentials.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm">
          <form className="space-y-5" onSubmit={onSubmit}>
            {/* Broker type */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Broker Type
              </label>
              <div className="flex gap-2 flex-wrap">
                {(["KITE", "ANGEL", "DELTA"] as BrokerType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => handleTypeChange(t)}
                    className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                      type === t
                        ? "border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400"
                        : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700"
                    }`}
                  >
                    {BROKER_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Name Tag
              </label>
              <input
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
                placeholder="e.g. My Zerodha Account"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
                required
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                A friendly label to identify this broker.
              </p>
            </div>

            {/* API Key */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                API Key
              </label>
              <input
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition font-mono"
                placeholder="Paste your API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
            </div>

            {/* Secret Key */}
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                API Secret
              </label>
              <input
                type="password"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition font-mono"
                placeholder="Paste your API secret"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                required
              />
            </div>

            {/* Info box — changes based on broker type */}
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3">
              {type === "KITE" && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Where to find credentials?
                  </span>{" "}
                  Log in to{" "}
                  <a
                    href="https://developers.kite.trade"
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-600 hover:underline"
                  >
                    developers.kite.trade
                  </a>
                  , create an app, and copy the API Key &amp; Secret from the
                  app settings.
                </p>
              )}
              {type === "ANGEL" && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Where to find credentials?
                  </span>{" "}
                  Log in to{" "}
                  <a
                    href="https://smartapi.angelbroking.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-600 hover:underline"
                  >
                    smartapi.angelbroking.com
                  </a>
                  , create an app, and copy the API Key &amp; Secret.
                </p>
              )}
              {type === "DELTA" && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Where to find credentials?
                  </span>{" "}
                  Log in to{" "}
                  <a
                    href="https://www.delta.exchange/app/account/manage-api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-600 hover:underline"
                  >
                    delta.exchange → Profile → API Keys
                  </a>
                  . Create a key with <strong>Trade</strong> +{" "}
                  <strong>Read</strong> permissions and copy the API Key &amp;
                  Secret.
                </p>
              )}
            </div>

            {/* Submit */}
            <div className="flex items-center gap-3 pt-1">
              <button
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-60 shadow-sm"
                disabled={saving}
                type="submit"
              >
                {saving ? (
                  <>
                    <svg
                      className="w-4 h-4 animate-spin"
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
                        d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
                      />
                    </svg>
                    Saving…
                  </>
                ) : (
                  <>
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
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    Save Broker
                  </>
                )}
              </button>
              <Link
                href="/brokers"
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

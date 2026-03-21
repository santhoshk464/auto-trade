"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

export default function TradeWindowClient() {
  const router = useRouter();
  const search = useSearchParams();
  const { user, loading } = useMe();

  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [loadingBrokers, setLoadingBrokers] = useState(false);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>("");

  const brokerIdFromQuery = useMemo(
    () => search.get("brokerId") || "",
    [search]
  );

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("at.selectedBrokerId") || "";
      setSelectedBrokerId(brokerIdFromQuery || saved);
    } catch {
      setSelectedBrokerId(brokerIdFromQuery);
    }
  }, [brokerIdFromQuery]);

  useEffect(() => {
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

    if (!loading && user) {
      load();
    }
  }, [loading, user]);

  useEffect(() => {
    if (!selectedBrokerId) return;
    try {
      window.localStorage.setItem("at.selectedBrokerId", selectedBrokerId);
    } catch {
      // ignore
    }
  }, [selectedBrokerId]);

  const selectedBroker = brokers.find((b) => b.id === selectedBrokerId) || null;

  return (
    <div className="min-h-screen bg-white">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-600">Broker:</div>
          <select
            className="min-w-64 rounded-md border bg-white px-3 py-2 text-sm"
            value={selectedBrokerId}
            onChange={(e) => setSelectedBrokerId(e.target.value)}
            disabled={loadingBrokers}
          >
            <option value="">Select broker</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.brokerIdMasked})
              </option>
            ))}
          </select>
        </div>

        <div className="text-xs text-zinc-500">
          {new Date().toLocaleString()}
        </div>
      </div>

      <div className="p-6">
        {!selectedBrokerId ? (
          <div className="rounded-lg border bg-zinc-50 p-4 text-sm text-zinc-700">
            Select a broker from the dropdown to start trading.
          </div>
        ) : !selectedBroker ? (
          <div className="rounded-lg border bg-zinc-50 p-4 text-sm text-zinc-700">
            Selected broker not found (it may have been deleted). Please select
            another broker.
          </div>
        ) : (
          <div className="rounded-lg border bg-white p-4">
            <div className="text-sm font-semibold text-zinc-900">
              Trading terminal (coming next)
            </div>
            <div className="mt-1 text-sm text-zinc-600">
              Selected: {selectedBroker.type} • {selectedBroker.name} •{" "}
              {selectedBroker.brokerIdMasked}
            </div>
            <div className="mt-4 text-sm text-zinc-600">
              Next step: we’ll build order placing, order book, positions and
              P&L on this page.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

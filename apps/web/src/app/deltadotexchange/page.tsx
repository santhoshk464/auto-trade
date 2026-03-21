"use client";

// ─── FULL DELTA.EXCHANGE DASHBOARD ──────────────────────────────────────────
// Replaced placeholder. Full implementation below.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import { apiFetch } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { ThemeToggle } from "@/components/theme-toggle";

// ── Types ─────────────────────────────────────────────────────────────────────

type DeltaBroker = { id: string; name: string; type: string };

type WalletAsset = {
  asset_symbol: string;
  available_balance: string;
  balance: string;
  unvested_amount: string;
};

type Position = {
  product_id: number;
  product_symbol: string;
  size: number;
  entry_price: string;
  mark_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
  margin: string;
  side: "buy" | "sell";
};

type Order = {
  id: number;
  product_symbol: string;
  side: "buy" | "sell";
  order_type: string;
  size: number;
  limit_price: string | null;
  avg_fill_price: string | null;
  state: string;
  created_at: string;
};

type Product = {
  id: number;
  symbol: string;
  description: string;
  contract_type: string;
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DeltaExchangePage() {
  const router = useRouter();
  const { user, loading } = useMe();

  const [brokerId, setBrokerId] = useState<string>("");
  const [deltaBrokers, setDeltaBrokers] = useState<DeltaBroker[]>([]);

  const [wallet, setWallet] = useState<WalletAsset[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [openOrders, setOpenOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [loadingData, setLoadingData] = useState(false);
  const [activeTab, setActiveTab] = useState<"positions" | "open" | "orders">(
    "positions",
  );

  // Order form
  const [orderProductId, setOrderProductId] = useState<string>("");
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market_order" | "limit_order">(
    "market_order",
  );
  const [orderSize, setOrderSize] = useState<string>("1");
  const [orderPrice, setOrderPrice] = useState<string>("");
  const [placingOrder, setPlacingOrder] = useState(false);

  // ── Auth + broker load ───────────────────────────────────────────────────

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.push("/login");
      return;
    }

    const savedId = localStorage.getItem("at.selectedDeltaBrokerId");

    apiFetch<{ brokers: Array<{ id: string; name: string; type: string }> }>(
      "/brokers",
    )
      .then((res) => {
        const delta = res.brokers.filter((b) => b.type === "DELTA");
        setDeltaBrokers(delta);
        const initial =
          savedId && delta.find((b) => b.id === savedId)
            ? savedId
            : delta[0]?.id || "";
        setBrokerId(initial);
      })
      .catch(() => toast.error("Failed to load brokers"));
  }, [loading, user, router]);

  // ── Data fetch ────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    if (!brokerId) return;
    setLoadingData(true);
    try {
      const [walletRes, posRes, ordersRes, openRes] = await Promise.allSettled([
        apiFetch<any>(`/delta/wallet?brokerId=${brokerId}`),
        apiFetch<any>(`/delta/positions?brokerId=${brokerId}`),
        apiFetch<any>(`/delta/orders?brokerId=${brokerId}&state=all&page=1`),
        apiFetch<any>(`/delta/open-orders?brokerId=${brokerId}`),
      ]);

      if (walletRes.status === "fulfilled")
        setWallet(walletRes.value?.result || []);
      if (posRes.status === "fulfilled")
        setPositions(
          (posRes.value?.result || []).filter((p: Position) => p.size !== 0),
        );
      if (ordersRes.status === "fulfilled")
        setOrders(ordersRes.value?.result || []);
      if (openRes.status === "fulfilled")
        setOpenOrders(openRes.value?.result || []);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load data");
    } finally {
      setLoadingData(false);
    }
  }, [brokerId]);

  // Load products (public endpoint — no brokerId needed)
  useEffect(() => {
    apiFetch<any>("/delta/products?contractTypes=perpetual_futures")
      .then((r) => setProducts(r?.result || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (brokerId) loadAll();
  }, [brokerId, loadAll]);

  // ── Place order ───────────────────────────────────────────────────────────

  async function handlePlaceOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!brokerId || !orderProductId || !orderSize) return;
    setPlacingOrder(true);
    try {
      const body: Record<string, unknown> = {
        product_id: parseInt(orderProductId, 10),
        side: orderSide,
        order_type: orderType,
        size: parseInt(orderSize, 10),
      };
      if (orderType === "limit_order" && orderPrice) {
        body.limit_price = orderPrice;
      }
      await apiFetch(`/delta/orders?brokerId=${brokerId}`, {
        method: "POST",
        json: body,
      });
      toast.success("Order placed!");
      setOrderSize("1");
      setOrderPrice("");
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || "Failed to place order");
    } finally {
      setPlacingOrder(false);
    }
  }

  async function handleCancelOrder(order: Order) {
    if (!window.confirm(`Cancel order #${order.id}?`)) return;
    try {
      // productId param used by backend to identify the product for signing
      await apiFetch(
        `/delta/orders/${order.id}?brokerId=${brokerId}&productId=${order.product_symbol}`,
        { method: "DELETE" },
      );
      toast.success("Order cancelled");
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || "Cancel failed");
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const totalUSDT = wallet.find((a) => a.asset_symbol === "USDT");
  const totalUnrealised = positions.reduce(
    (s, p) => s + parseFloat(p.unrealized_pnl || "0"),
    0,
  );

  if (loading) return null;
  if (!user) return null;

  // No Delta broker added yet
  if (!loading && user && deltaBrokers.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-zinc-950 p-8">
        <div className="text-center max-w-sm">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            No Delta Broker Found
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-sm">
            Add a Delta.Exchange broker from the Brokers page to get started.
          </p>
          <Link
            href="/brokers/add"
            className="rounded-lg bg-orange-500 hover:bg-orange-400 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            + Add Delta Broker
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950">
      {/* ── Header ── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              ← Dashboard
            </Link>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-md bg-orange-500 flex items-center justify-center">
                <svg
                  className="w-3.5 h-3.5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 2L2 19h20L12 2z"
                  />
                </svg>
              </div>
              <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                Delta.Exchange
              </span>
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400">
                MAINNET
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {deltaBrokers.length > 1 && (
              <select
                value={brokerId}
                onChange={(e) => setBrokerId(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 focus:outline-none"
              >
                {deltaBrokers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={loadAll}
              disabled={loadingData}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {loadingData ? "Loading…" : "↻ Refresh"}
            </button>
            <Link
              href="/deltadotexchange/trade-finder"
              className="rounded-lg border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 px-3 py-1.5 text-xs font-semibold text-orange-700 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40 transition-colors"
            >
              📉 Trade Finder
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-6">
        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="USDT Balance"
            value={
              totalUSDT ? `$${parseFloat(totalUSDT.balance).toFixed(2)}` : "—"
            }
            sub={
              totalUSDT
                ? `Available: $${parseFloat(totalUSDT.available_balance).toFixed(2)}`
                : undefined
            }
            color="text-zinc-900 dark:text-zinc-100"
          />
          <StatCard
            label="Unrealised P&L"
            value={`$${totalUnrealised.toFixed(2)}`}
            color={
              totalUnrealised >= 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-500 dark:text-red-400"
            }
          />
          <StatCard
            label="Open Positions"
            value={String(positions.length)}
            color="text-blue-600 dark:text-blue-400"
          />
          <StatCard
            label="Open Orders"
            value={String(openOrders.length)}
            color="text-amber-600 dark:text-amber-400"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ── Place order + Wallet ── */}
          <div className="lg:col-span-1 space-y-4">
            {/* Order form */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-900 p-5">
              <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-4">
                Place Order
              </h2>
              <form onSubmit={handlePlaceOrder} className="space-y-3">
                {/* Product */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Product
                  </label>
                  <select
                    value={orderProductId}
                    onChange={(e) => setOrderProductId(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">Select product…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.symbol}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Side */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Side
                  </label>
                  <div className="flex gap-2">
                    {(["buy", "sell"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setOrderSide(s)}
                        className={`flex-1 rounded-lg border py-2 text-sm font-semibold transition-colors ${
                          orderSide === s
                            ? s === "buy"
                              ? "border-green-500 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                              : "border-red-500 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
                            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {s.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Order type */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Order Type
                  </label>
                  <div className="flex gap-2">
                    {(["market_order", "limit_order"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setOrderType(t)}
                        className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-colors ${
                          orderType === t
                            ? "border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400"
                            : "border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {t === "market_order" ? "Market" : "Limit"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Size */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Size (contracts)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={orderSize}
                    onChange={(e) => setOrderSize(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                {/* Limit price */}
                {orderType === "limit_order" && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Limit Price (USD)
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={orderPrice}
                      onChange={(e) => setOrderPrice(e.target.value)}
                      required
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={placingOrder || !brokerId}
                  className={`w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                    orderSide === "buy"
                      ? "bg-green-600 hover:bg-green-500"
                      : "bg-red-600 hover:bg-red-500"
                  }`}
                >
                  {placingOrder
                    ? "Placing…"
                    : `${orderSide === "buy" ? "BUY" : "SELL"} ${orderType === "market_order" ? "Market" : "Limit"}`}
                </button>
              </form>
            </div>

            {/* Wallet breakdown */}
            {wallet.filter((a) => parseFloat(a.balance) > 0).length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-900 p-5">
                <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-3">
                  Wallet
                </h2>
                <div className="space-y-2">
                  {wallet
                    .filter((a) => parseFloat(a.balance) > 0)
                    .map((a) => (
                      <div
                        key={a.asset_symbol}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {a.asset_symbol}
                        </span>
                        <div className="text-right">
                          <div className="text-zinc-900 dark:text-zinc-100 font-mono">
                            {parseFloat(a.balance).toFixed(4)}
                          </div>
                          <div className="text-zinc-400 dark:text-zinc-500">
                            avail: {parseFloat(a.available_balance).toFixed(4)}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Positions / Orders tabs ── */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-900 overflow-hidden">
              {/* Tab bar */}
              <div className="flex border-b border-slate-200 dark:border-slate-700">
                {(["positions", "open", "orders"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-3 text-xs font-semibold transition-colors ${
                      activeTab === tab
                        ? "border-b-2 border-orange-500 text-orange-600 dark:text-orange-400 bg-orange-50/60 dark:bg-orange-900/10"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
                    }`}
                  >
                    {tab === "positions" && `Positions (${positions.length})`}
                    {tab === "open" && `Open Orders (${openOrders.length})`}
                    {tab === "orders" && "Order History"}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto">
                {/* Positions tab */}
                {activeTab === "positions" &&
                  (positions.length === 0 ? (
                    <Empty text="No open positions" />
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500">
                          <Th>Symbol</Th>
                          <Th>Side</Th>
                          <Th>Size</Th>
                          <Th>Entry</Th>
                          <Th>Mark</Th>
                          <Th>Unrealised P&L</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((p, i) => (
                          <tr
                            key={i}
                            className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-zinc-800/40"
                          >
                            <Td>{p.product_symbol}</Td>
                            <Td>
                              <span
                                className={`rounded-full px-2 py-0.5 font-bold ${p.size > 0 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}
                              >
                                {p.size > 0 ? "LONG" : "SHORT"}
                              </span>
                            </Td>
                            <Td>{Math.abs(p.size)}</Td>
                            <Td>${parseFloat(p.entry_price).toFixed(2)}</Td>
                            <Td>${parseFloat(p.mark_price).toFixed(2)}</Td>
                            <Td>
                              <span
                                className={
                                  parseFloat(p.unrealized_pnl) >= 0
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-500 dark:text-red-400"
                                }
                              >
                                ${parseFloat(p.unrealized_pnl).toFixed(2)}
                              </span>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}

                {/* Open orders tab */}
                {activeTab === "open" &&
                  (openOrders.length === 0 ? (
                    <Empty text="No open orders" />
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500">
                          <Th>Symbol</Th>
                          <Th>Side</Th>
                          <Th>Type</Th>
                          <Th>Size</Th>
                          <Th>Price</Th>
                          <Th>Action</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {openOrders.map((o) => (
                          <tr
                            key={o.id}
                            className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-zinc-800/40"
                          >
                            <Td>{o.product_symbol}</Td>
                            <Td>
                              <span
                                className={`rounded-full px-2 py-0.5 font-bold ${o.side === "buy" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}
                              >
                                {o.side.toUpperCase()}
                              </span>
                            </Td>
                            <Td>{o.order_type.replace("_order", "")}</Td>
                            <Td>{o.size}</Td>
                            <Td>
                              {o.limit_price ? `$${o.limit_price}` : "Market"}
                            </Td>
                            <Td>
                              <button
                                onClick={() => handleCancelOrder(o)}
                                className="rounded px-2 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors font-medium"
                              >
                                Cancel
                              </button>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}

                {/* Order history tab */}
                {activeTab === "orders" &&
                  (orders.length === 0 ? (
                    <Empty text="No order history" />
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500">
                          <Th>Symbol</Th>
                          <Th>Side</Th>
                          <Th>Type</Th>
                          <Th>Size</Th>
                          <Th>Avg Fill</Th>
                          <Th>Status</Th>
                          <Th>Time</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((o) => (
                          <tr
                            key={o.id}
                            className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-zinc-800/40"
                          >
                            <Td>{o.product_symbol}</Td>
                            <Td>
                              <span
                                className={`rounded-full px-2 py-0.5 font-bold ${o.side === "buy" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}
                              >
                                {o.side.toUpperCase()}
                              </span>
                            </Td>
                            <Td>{o.order_type.replace("_order", "")}</Td>
                            <Td>{o.size}</Td>
                            <Td>
                              {o.avg_fill_price
                                ? `$${parseFloat(o.avg_fill_price).toFixed(2)}`
                                : "—"}
                            </Td>
                            <Td>
                              <StatusBadge state={o.state} />
                            </Td>
                            <Td>
                              {new Date(o.created_at).toLocaleTimeString()}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Small reusable components ─────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-zinc-900 p-4">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-bold ${color}`}>{value}</p>
      {sub && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
          {sub}
        </p>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left font-semibold uppercase tracking-wider text-[10px]">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3">{children}</td>;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
      {text}
    </div>
  );
}

function StatusBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    filled:
      "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    cancelled:
      "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
    open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    rejected: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-bold capitalize ${map[state] || "bg-slate-100 text-slate-500"}`}
    >
      {state}
    </span>
  );
}

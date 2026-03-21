"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const NSE_SYMBOL_GROUPS: Array<{ label: string; options: string[] }> = [
  {
    label: "Index",
    options: ["BANKNIFTY", "NIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"],
  },
  {
    label: "Stock",
    options: [
      "360ONE",
      "ABB",
      "ABCAPITAL",
      "ADANIENSOL",
      "ADANIENT",
      "ADANIGREEN",
      "ADANIPORTS",
      "ALKEM",
      "AMBER",
      "AMBUJACEM",
      "ANGELONE",
      "APLAPOLLO",
      "APOLLOHOSP",
      "ASHOKLEY",
      "ASIANPAINT",
      "ASTRAL",
      "AUBANK",
      "AUROPHARMA",
      "AXISBANK",
      "BAJAJ-AUTO",
      "BAJAJFINSV",
      "BAJFINANCE",
      "BANDHANBNK",
      "BANKBARODA",
      "BANKINDIA",
      "BDL",
      "BEL",
      "BHARATFORG",
      "BHARTIARTL",
      "BHEL",
      "BIOCON",
      "BLUESTARCO",
      "BOSCHLTD",
      "BPCL",
      "BRITANNIA",
      "BSE",
      "CAMS",
      "CANBK",
      "CDSL",
      "CGPOWER",
      "CHOLAFIN",
      "CIPLA",
      "COALINDIA",
      "COFORGE",
      "COLPAL",
      "CONCOR",
      "CROMPTON",
      "CUMMINSIND",
      "CYIENT",
      "DABUR",
      "DALBHARAT",
      "DELHIVERY",
      "DIVISLAB",
      "DIXON",
      "DLF",
      "DMART",
      "DRREDDY",
      "EICHERMOT",
      "ETERNAL",
      "EXIDEIND",
      "FEDERALBNK",
      "FORTIS",
      "GAIL",
      "GLENMARK",
      "GMRAIRPORT",
      "GODREJCP",
      "GODREJPROP",
      "GRASIM",
      "HAL",
      "HAVELLS",
      "HCLTECH",
      "HDFCAMC",
      "HDFCBANK",
      "HDFCLIFE",
      "HEROMOTOCO",
      "HFCL",
      "HINDALCO",
      "HINDPETRO",
      "HINDUNILVR",
      "HINDZINC",
      "HUDCO",
      "ICICIBANK",
      "ICICIGI",
      "ICICIPRULI",
      "IDEA",
      "IDFCFIRSTB",
      "IEX",
      "IIFL",
      "INDHOTEL",
      "INDIANB",
      "INDIGO",
      "INDUSINDBK",
      "INDUSTOWER",
      "INFY",
      "INOXWIND",
      "IOC",
      "IRCTC",
      "IREDA",
      "IRFC",
      "ITC",
      "JINDALSTEL",
      "JIOFIN",
      "JSWENERGY",
      "JSWSTEEL",
      "JUBLFOOD",
      "KALYANKJIL",
      "KAYNES",
      "KEI",
      "KFINTECH",
      "KOTAKBANK",
      "KPITTECH",
      "LAURUSLABS",
      "LICHSGFIN",
      "LICI",
      "LODHA",
      "LT",
      "LTF",
      "LTIM",
      "LUPIN",
      "MANAPPURAM",
      "MANKIND",
      "MARICO",
      "MARUTI",
      "MAXHEALTH",
      "MAZDOCK",
      "MCX",
      "MFSL",
      "M&M",
      "MOTHERSON",
      "MPHASIS",
      "MUTHOOTFIN",
      "NATIONALUM",
      "NAUKRI",
      "NBCC",
      "NCC",
      "NESTLEIND",
      "NHPC",
      "NMDC",
      "NTPC",
      "NUVAMA",
      "NYKAA",
      "OBEROIRLTY",
      "OFSS",
      "OIL",
      "ONGC",
      "PAGEIND",
      "PATANJALI",
      "PAYTM",
      "PERSISTENT",
      "PETRONET",
      "PFC",
      "PGEL",
      "PHOENIXLTD",
      "PIDILITIND",
      "PIIND",
      "PNB",
      "PNBHOUSING",
      "POLICYBZR",
      "POLYCAB",
      "POWERGRID",
      "POWERINDIA",
      "PPLPHARMA",
      "PRESTIGE",
      "RBLBANK",
      "RECLTD",
      "RELIANCE",
      "RVNL",
      "SAIL",
      "SAMMAANCAP",
      "SBICARD",
      "SBILIFE",
      "SBIN",
      "SHREECEM",
      "SHRIRAMFIN",
      "SIEMENS",
      "SOLARINDS",
      "SONACOMS",
      "SRF",
      "SUNPHARMA",
      "SUPREMEIND",
      "SUZLON",
      "SYNGENE",
      "TATACONSUM",
      "TATAELXSI",
      "TATAPOWER",
      "TATASTEEL",
      "TATATECH",
      "TCS",
      "TECHM",
      "TIINDIA",
      "TITAGARH",
      "TITAN",
      "TMPV",
      "TORNTPHARM",
      "TORNTPOWER",
      "TRENT",
      "TVSMOTOR",
      "ULTRACEMCO",
      "UNIONBANK",
      "UNITDSPR",
      "UNOMINDA",
      "UPL",
      "VBL",
      "VEDL",
      "VOLTAS",
      "WIPRO",
      "YESBANK",
      "ZYDUSLIFE",
    ],
  },
];

const BSE_SYMBOL_GROUPS: Array<{
  label: string;
  options: Array<{ value: string; label: string }>;
}> = [
  {
    label: "Index",
    options: [
      { value: "", label: "Please select a options name" },
      { value: "SENSEX", label: "SENSEX" },
      { value: "BANKEX", label: "BANKEX" },
      { value: "SENSEX50", label: "SENSEX50" },
    ],
  },
];

type TabKey = "positions" | "orderBook" | "tradeBook" | "holdings" | "funda";

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatDateTime(date: Date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} / ${hh}:${mi}:${ss}`;
}

export default function TradeTerminalClient() {
  const router = useRouter();
  const { user, loading } = useMe();

  const [now, setNow] = useState<Date>(() => new Date());

  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [loadingBrokers, setLoadingBrokers] = useState(false);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>("");

  // Form state (UI-only for now)
  const [exchange, setExchange] = useState("NSE");
  const [segment, setSegment] = useState("Options");
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiryDate, setExpiryDate] = useState("");
  const [callStrike, setCallStrike] = useState("59000");
  const [putStrike, setPutStrike] = useState("59000");
  const [qtyLots, setQtyLots] = useState("1");
  const [productType, setProductType] = useState("Margin");

  const [orderType, setOrderType] = useState("Market");
  const [marketProtection, setMarketProtection] = useState("10%");

  const [usePredefinedSl, setUsePredefinedSl] = useState(false);
  const [predefinedSl, setPredefinedSl] = useState("");
  const [usePredefinedTarget, setUsePredefinedTarget] = useState(false);
  const [predefinedTarget, setPredefinedTarget] = useState("");

  const [positionType, setPositionType] = useState("F&O positions only");
  const [positionView, setPositionView] = useState("All positions");
  const [oneClickEnabled, setOneClickEnabled] = useState(false);

  const [tab, setTab] = useState<TabKey>("positions");

  // Tab data
  const [positions, setPositions] = useState<any>({ net: [], day: [] });
  const [orders, setOrders] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [holdings, setHoldings] = useState<any[]>([]);
  const [margins, setMargins] = useState<any>(null);
  const [totalPnl, setTotalPnl] = useState<number>(0);
  const [loadingTabData, setLoadingTabData] = useState(false);

  // Store fee offset for each position (to preserve Kite's P&L calculation including fees)
  const positionFeeOffsets = useRef<Map<number, number>>(new Map());

  // Position SL and Target values (indexed by position index)
  const [positionSL, setPositionSL] = useState<Record<number, string>>({});
  const [positionTarget, setPositionTarget] = useState<Record<number, string>>(
    {}
  );

  // Dynamic options data
  const [expiryDates, setExpiryDates] = useState<string[]>([]);
  const [lotSize, setLotSize] = useState<number>(1);
  const [qtyOptions, setQtyOptions] = useState<number[]>([]);
  const [availableStrikes, setAvailableStrikes] = useState<number[]>([]);
  const [callLtp, setCallLtp] = useState<number | null>(null);
  const [putLtp, setPutLtp] = useState<number | null>(null);
  const [underlyingLtp, setUnderlyingLtp] = useState<number | null>(null);

  // Store tradingsymbols for order placement
  const [callTradingsymbol, setCallTradingsymbol] = useState<string>("");
  const [putTradingsymbol, setPutTradingsymbol] = useState<string>("");
  const [placingOrder, setPlacingOrder] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const symbolGroups = useMemo(() => {
    if (exchange === "NSE") return NSE_SYMBOL_GROUPS;
    return [];
  }, [exchange]);

  const bseSymbolGroups = useMemo(() => {
    if (exchange === "BSE") return BSE_SYMBOL_GROUPS;
    return [];
  }, [exchange]);

  const isNseSymbol = useMemo(() => {
    if (exchange !== "NSE") return false;
    const all = new Set(symbolGroups.flatMap((g) => g.options));
    return all.has(symbol);
  }, [exchange, symbol, symbolGroups]);

  const isBseSymbol = useMemo(() => {
    if (exchange !== "BSE") return false;
    const all = new Set(
      bseSymbolGroups
        .flatMap((g) => g.options.map((o) => o.value))
        .filter(Boolean)
    );
    return all.has(symbol);
  }, [exchange, symbol, bseSymbolGroups]);

  useEffect(() => {
    if (exchange !== "NSE") return;
    const all = new Set(symbolGroups.flatMap((g) => g.options));
    if (!all.has(symbol)) setSymbol("NIFTY");
  }, [exchange, symbol, symbolGroups]);

  useEffect(() => {
    if (exchange !== "BSE") return;
    const all = new Set(
      bseSymbolGroups
        .flatMap((g) => g.options.map((o) => o.value))
        .filter((v) => v !== "")
    );

    // Default to SENSEX for BSE
    if (symbol === "" || !all.has(symbol)) setSymbol("SENSEX");
  }, [exchange, symbol, bseSymbolGroups]);

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("at.selectedBrokerId") || "";
      setSelectedBrokerId(saved);
    } catch {
      setSelectedBrokerId("");
    }
  }, []);

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
    try {
      if (selectedBrokerId) {
        window.localStorage.setItem("at.selectedBrokerId", selectedBrokerId);
      } else {
        window.localStorage.removeItem("at.selectedBrokerId");
      }
    } catch {
      // ignore
    }
  }, [selectedBrokerId]);

  const selectedBroker = useMemo(
    () => brokers.find((b) => b.id === selectedBrokerId) || null,
    [brokers, selectedBrokerId]
  );

  const tabs: Array<{ key: TabKey; label: string }> = useMemo(
    () => [
      { key: "positions", label: "Positions" },
      { key: "orderBook", label: "Order book" },
      { key: "tradeBook", label: "Trade Book" },
      { key: "holdings", label: "Holdings" },
      { key: "funda", label: "Funds" },
    ],
    []
  );

  // Fetch expiry dates when segment=Options/Futures and symbol changes
  useEffect(() => {
    if (
      (segment !== "Options" && segment !== "Futures") ||
      !symbol ||
      !exchange
    ) {
      setExpiryDates([]);
      setExpiryDate("");
      return;
    }

    async function loadExpiry() {
      try {
        const res = await apiFetch<{ expiries: string[] }>(
          `/kite/expiry-dates?exchange=${encodeURIComponent(
            exchange
          )}&symbol=${encodeURIComponent(symbol)}&segment=${encodeURIComponent(
            segment
          )}`
        );
        setExpiryDates(res.expiries || []);
        // Auto-select first expiry (always reset to first when symbol changes)
        if (res.expiries && res.expiries.length > 0) {
          setExpiryDate(res.expiries[0]);
        } else {
          setExpiryDate("");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load expiry dates");
        setExpiryDates([]);
        setExpiryDate("");
      }
    }

    loadExpiry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, exchange, symbol]);

  // Fetch strikes when expiry changes
  useEffect(() => {
    if (segment !== "Options" || !symbol || !exchange || !expiryDate) {
      setAvailableStrikes([]);
      setCallStrike("");
      setPutStrike("");
      return;
    }

    async function loadStrikes() {
      try {
        const res = await apiFetch<{ strikes: number[] }>(
          `/kite/strikes?exchange=${encodeURIComponent(
            exchange
          )}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(
            expiryDate
          )}`
        );
        setAvailableStrikes(res.strikes || []);
        // Auto-select middle strike (always reset when expiry/symbol changes)
        if (res.strikes && res.strikes.length > 0) {
          const mid = Math.floor(res.strikes.length / 2);
          setCallStrike(String(res.strikes[mid]));
          setPutStrike(String(res.strikes[mid]));
        } else {
          setCallStrike("");
          setPutStrike("");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to load strikes");
        setAvailableStrikes([]);
        setCallStrike("");
        setPutStrike("");
      }
    }

    loadStrikes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, exchange, symbol, expiryDate]);

  // Fetch lot size when symbol/segment changes
  useEffect(() => {
    if (
      (segment !== "Options" && segment !== "Futures") ||
      !symbol ||
      !exchange
    ) {
      setLotSize(1);
      setQtyOptions([]);
      setQtyLots("1");
      return;
    }

    async function loadLotSize() {
      try {
        const params = new URLSearchParams({
          exchange,
          symbol,
          segment,
        });
        if (expiryDate) params.append("expiry", expiryDate);

        const res = await apiFetch<{ lotSize: number }>(
          `/kite/lot-size?${params.toString()}`
        );
        const lot = res.lotSize || 1;

        // Generate quantity options: 1 lot to 10 lots
        const options = [];
        for (let i = 1; i <= 10; i++) {
          options.push(i * lot);
        }

        // Update state together to avoid race condition
        setLotSize(lot);
        setQtyOptions(options);
        setQtyLots(String(lot)); // Set to first option (1 lot)
      } catch (err: any) {
        setLotSize(1);
        setQtyOptions([]);
        setQtyLots("1");
      }
    }

    loadLotSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment, exchange, symbol, expiryDate]);

  // WebSocket ticker for real-time LTP updates
  useEffect(() => {
    if (
      segment !== "Options" ||
      !symbol ||
      !exchange ||
      !expiryDate ||
      !callStrike ||
      !putStrike ||
      !selectedBrokerId
    ) {
      return;
    }

    // Clear previous LTP values when symbol changes
    setCallLtp(null);
    setPutLtp(null);
    setUnderlyingLtp(null);

    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isMounted = true; // Flag to prevent updates after unmount
    let currentTokens: number[] = []; // Track current subscription tokens

    async function setupWebSocket() {
      // Don't reconnect if component unmounted or symbol changed
      if (!isMounted) return;

      try {
        // Fetch initial quotes and instrument tokens
        const res = await apiFetch<{
          quotes: Array<{
            type: "CE" | "PE" | "UNDERLYING";
            tradingsymbol: string;
            last_price: number;
            instrument_token: number;
          }>;
        }>("/kite/option-quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brokerId: selectedBrokerId,
            symbol,
            exchange,
            expiry: expiryDate,
            callStrike: Number(callStrike),
            putStrike: Number(putStrike),
          }),
        });

        if (!isMounted) return; // Check again after async operation

        // Set initial prices and create token map
        const tokenMap = new Map<number, "CE" | "PE" | "UNDERLYING">();
        for (const q of res.quotes || []) {
          if (q.type === "CE") {
            setCallLtp(q.last_price);
            setCallTradingsymbol(q.tradingsymbol);
            tokenMap.set(q.instrument_token, "CE");
          } else if (q.type === "PE") {
            setPutLtp(q.last_price);
            setPutTradingsymbol(q.tradingsymbol);
            tokenMap.set(q.instrument_token, "PE");
          } else if (q.type === "UNDERLYING") {
            setUnderlyingLtp(q.last_price);
            tokenMap.set(q.instrument_token, "UNDERLYING");
          }
        }

        if (res.quotes.length === 0) {
          return;
        }

        // Store current tokens for cleanup
        currentTokens = res.quotes.map((q) => q.instrument_token);

        // Get WebSocket credentials
        const credsRes = await apiFetch<{
          apiKey: string | null;
          accessToken: string | null;
        }>("/kite/ws-credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brokerId: selectedBrokerId }),
        });

        if (!isMounted || !credsRes.apiKey || !credsRes.accessToken) {
          return;
        }

        // Close existing WebSocket before creating new one
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          ws = null;
        }

        // Connect to Kite WebSocket ticker
        const wsUrl = `wss://ws.kite.trade?api_key=${credsRes.apiKey}&access_token=${credsRes.accessToken}`;
        ws = new WebSocket(wsUrl);

        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          if (!isMounted) {
            ws?.close();
            return;
          }
          // Subscribe to instrument tokens in LTP mode (mode: "ltp")
          const tokens = res.quotes.map((q) => q.instrument_token);
          const subscribeMsg = {
            a: "subscribe",
            v: tokens,
          };
          const modeMsg = {
            a: "mode",
            v: ["ltp", tokens],
          };
          ws?.send(JSON.stringify(subscribeMsg));
          ws?.send(JSON.stringify(modeMsg));
        };

        ws.onmessage = (event) => {
          if (!isMounted) return; // Ignore messages after unmount

          try {
            // Kite sends binary data, parse it
            const buffer = new Uint8Array(event.data);

            // Simple LTP parsing (instrument_token at offset 0-3, LTP at offset 4-7)
            // This is a simplified parser - full implementation would handle all tick formats
            // For now, we'll just parse text messages if available
            if (typeof event.data === "string") {
              const data = JSON.parse(event.data);
            } else {
              // Binary tick data - parse LTP updates
              // Format: 2 bytes packet count, then packets
              const view = new DataView(buffer.buffer);
              let offset = 0;

              // Read number of packets (2 bytes)
              if (buffer.length < 2) return;
              const packetCount = view.getUint16(offset, false);
              offset += 2;

              for (let i = 0; i < packetCount && offset < buffer.length; i++) {
                // Read packet length (2 bytes)
                if (offset + 2 > buffer.length) break;
                const packetLength = view.getUint16(offset, false);
                offset += 2;

                if (offset + packetLength > buffer.length) break;

                // Read instrument token (4 bytes)
                if (packetLength < 4) {
                  offset += packetLength;
                  continue;
                }
                const token = view.getUint32(offset, false);
                offset += 4;

                // LTP mode: 8 bytes packet (4 token + 4 LTP)
                if (packetLength === 8 && offset + 4 <= buffer.length) {
                  const ltp = view.getUint32(offset, false) / 100; // LTP is in paise
                  offset += 4;

                  const type = tokenMap.get(token);
                  if (type === "CE") {
                    setCallLtp(ltp);
                  } else if (type === "PE") {
                    setPutLtp(ltp);
                  } else if (type === "UNDERLYING") {
                    setUnderlyingLtp(ltp);
                  }
                } else {
                  offset += packetLength - 4;
                }
              }
            }
          } catch (err) {
            // Error parsing WebSocket message
          }
        };

        ws.onerror = (error) => {
          // WebSocket error
        };

        ws.onclose = () => {
          if (!isMounted) return; // Don't reconnect if unmounted
          // Attempt reconnect after 5 seconds
          reconnectTimeout = setTimeout(() => {
            setupWebSocket();
          }, 5000);
        };
      } catch (err) {
        // Failed to setup WebSocket
      }
    }

    setupWebSocket();

    return () => {
      isMounted = false; // Mark as unmounted
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        // Unsubscribe from current tokens before closing
        if (ws.readyState === WebSocket.OPEN && currentTokens.length > 0) {
          try {
            ws.send(JSON.stringify({ a: "unsubscribe", v: currentTokens }));
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
        ws.close();
      }
    };
  }, [
    segment,
    exchange,
    symbol,
    expiryDate,
    callStrike,
    putStrike,
    selectedBrokerId,
  ]);

  // Load tab data
  async function loadTabData() {
    if (!selectedBrokerId) return;

    setLoadingTabData(true);
    try {
      if (tab === "positions") {
        const res = await apiFetch<{ net: any[]; day: any[] }>(
          `/kite/positions?brokerId=${selectedBrokerId}`
        );

        // Calculate and store fee offset for each position
        // Fee offset = Kite's P&L - Simple P&L (to account for fees/charges)
        const feeOffsets = new Map<number, number>();
        (res.net || []).forEach((p: any) => {
          if (p.instrument_token && p.quantity !== 0) {
            const simplePnl = (p.last_price - p.average_price) * p.quantity;
            const feeOffset = p.pnl - simplePnl;
            feeOffsets.set(p.instrument_token, feeOffset);
            console.log(
              `📌 Position ${p.tradingsymbol}: Kite P&L=${p.pnl}, Simple P&L=${simplePnl}, Fee Offset=${feeOffset}`
            );
          }
        });
        positionFeeOffsets.current = feeOffsets;

        setPositions(res);
        // Calculate total P&L from positions
        const pnl = (res.net || []).reduce(
          (sum: number, p: any) => sum + (p.pnl || 0),
          0
        );
        setTotalPnl(pnl);
      } else if (tab === "orderBook") {
        const res = await apiFetch<{ orders: any[] }>(
          `/kite/orders?brokerId=${selectedBrokerId}`
        );
        setOrders(res.orders || []);
      } else if (tab === "tradeBook") {
        const res = await apiFetch<{ trades: any[] }>(
          `/kite/trades?brokerId=${selectedBrokerId}`
        );
        setTrades(res.trades || []);
      } else if (tab === "holdings") {
        const res = await apiFetch<{ holdings: any[] }>(
          `/kite/holdings?brokerId=${selectedBrokerId}`
        );
        setHoldings(res.holdings || []);
      } else if (tab === "funda") {
        const res = await apiFetch<{ equity: any; commodity: any }>(
          `/kite/margins?brokerId=${selectedBrokerId}`
        );
        setMargins(res);
      }
    } catch (err: any) {
      toast.error(err?.message || `Failed to load ${tab} data`);
    } finally {
      setLoadingTabData(false);
    }
  }

  // Load tab data when tab or broker changes
  useEffect(() => {
    if (selectedBrokerId && tab) {
      loadTabData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedBrokerId]);

  // Memoize position tokens to avoid unnecessary WebSocket reconnections
  const positionTokens = useMemo(() => {
    return positions.net
      .filter((p: any) => p.instrument_token)
      .map((p: any) => p.instrument_token)
      .sort((a: number, b: number) => a - b)
      .join(",");
  }, [positions.net]);

  // WebSocket subscription for positions LTP updates
  useEffect(() => {
    if (
      tab !== "positions" ||
      !selectedBrokerId ||
      positions.net.length === 0
    ) {
      return;
    }

    let ws: WebSocket | null = null;
    let isMounted = true;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let currentTokens: number[] = [];

    async function setupPositionsWebSocket() {
      try {
        // Get instrument tokens from positions
        const tokens = positions.net
          .filter((p: any) => p.instrument_token)
          .map((p: any) => p.instrument_token);

        if (tokens.length === 0) return;

        currentTokens = tokens;

        // Get WebSocket credentials
        const credsRes = await apiFetch<{
          apiKey: string | null;
          accessToken: string | null;
        }>("/kite/ws-credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brokerId: selectedBrokerId }),
        });

        if (!isMounted || !credsRes.apiKey || !credsRes.accessToken) {
          return;
        }

        // Close existing WebSocket before creating new one
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          ws = null;
        }

        // Connect to Kite WebSocket ticker
        const wsUrl = `wss://ws.kite.trade?api_key=${credsRes.apiKey}&access_token=${credsRes.accessToken}`;
        ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          if (!isMounted) {
            ws?.close();
            return;
          }
          // Subscribe to instrument tokens in LTP mode
          const subscribeMsg = {
            a: "subscribe",
            v: tokens,
          };
          const modeMsg = {
            a: "mode",
            v: ["ltp", tokens],
          };
          ws?.send(JSON.stringify(subscribeMsg));
          ws?.send(JSON.stringify(modeMsg));
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;

          try {
            const buffer = new Uint8Array(event.data);
            const view = new DataView(buffer.buffer);
            let offset = 0;

            // Read number of packets (2 bytes)
            if (buffer.length < 2) return;
            const packetCount = view.getUint16(offset, false);
            offset += 2;

            // Create map of token updates
            const ltpUpdates = new Map<number, number>();

            for (let i = 0; i < packetCount && offset < buffer.length; i++) {
              // Read packet length (2 bytes)
              if (offset + 2 > buffer.length) break;
              const packetLength = view.getUint16(offset, false);
              offset += 2;

              if (offset + packetLength > buffer.length) break;

              // Read instrument token (4 bytes)
              if (packetLength < 4) {
                offset += packetLength;
                continue;
              }
              const token = view.getUint32(offset, false);
              offset += 4;

              // LTP mode: 8 bytes packet (4 token + 4 LTP)
              if (packetLength === 8 && offset + 4 <= buffer.length) {
                const ltp = view.getUint32(offset, false) / 100; // LTP is in paise
                offset += 4;
                ltpUpdates.set(token, ltp);
              } else {
                offset += packetLength - 4;
              }
            }

            // Update positions with new LTP values
            if (ltpUpdates.size > 0) {
              console.log(
                "📊 WebSocket LTP Updates:",
                Array.from(ltpUpdates.entries())
              );

              setPositions((prev: any) => {
                const updatedNet = prev.net.map((p: any) => {
                  if (ltpUpdates.has(p.instrument_token)) {
                    const newLtp = ltpUpdates.get(p.instrument_token)!;

                    console.log(
                      `Position: ${p.tradingsymbol}, Token: ${p.instrument_token}, Old LTP: ${p.last_price}, New LTP: ${newLtp}, Qty: ${p.quantity}, Avg: ${p.average_price}`
                    );

                    // For closed positions (quantity === 0), keep original P&L (realized P&L)
                    if (p.quantity === 0) {
                      console.log(`  ↳ Closed position, keeping P&L: ${p.pnl}`);
                      return {
                        ...p,
                        last_price: newLtp,
                        pnl: p.pnl, // Explicitly preserve original P&L
                      };
                    }

                    // For open positions, recalculate P&L based on new LTP
                    // Include fee offset to match Kite's P&L calculation
                    const simplePnl = (newLtp - p.average_price) * p.quantity;
                    const feeOffset =
                      positionFeeOffsets.current.get(p.instrument_token) || 0;
                    const pnl = simplePnl + feeOffset;

                    console.log(
                      `  ↳ Open position, Old P&L: ${p.pnl}, Simple P&L: ${simplePnl}, Fee Offset: ${feeOffset}, New P&L: ${pnl}`
                    );

                    return {
                      ...p,
                      last_price: newLtp,
                      pnl: pnl,
                    };
                  }
                  return p;
                });

                // Recalculate total P&L after LTP update
                const totalPnl = updatedNet.reduce(
                  (sum: number, p: any) => sum + (p.pnl || 0),
                  0
                );
                console.log("💰 Total P&L:", totalPnl);
                setTotalPnl(totalPnl);

                return {
                  ...prev,
                  net: updatedNet,
                };
              });
            }
          } catch (err) {
            // Error parsing WebSocket message
          }
        };

        ws.onerror = () => {
          // WebSocket error
        };

        ws.onclose = () => {
          if (!isMounted) return;
          // Attempt reconnect after 5 seconds
          reconnectTimeout = setTimeout(() => {
            setupPositionsWebSocket();
          }, 5000);
        };
      } catch (err) {
        // Failed to setup WebSocket
      }
    }

    setupPositionsWebSocket();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        // Unsubscribe from current tokens before closing
        if (ws.readyState === WebSocket.OPEN && currentTokens.length > 0) {
          try {
            ws.send(JSON.stringify({ a: "unsubscribe", v: currentTokens }));
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
        ws.close();
      }
    };
  }, [tab, selectedBrokerId, positionTokens]);

  // Helper: Place order
  async function placeOrder(
    tradingsymbol: string,
    transactionType: "BUY" | "SELL",
    optionType: "CE" | "PE"
  ) {
    if (!selectedBrokerId) {
      toast.error("Please select a broker");
      return;
    }

    if (!tradingsymbol) {
      toast.error(`${optionType} tradingsymbol not available`);
      return;
    }

    // qtyLots already contains the actual quantity (not lot count)
    const quantity = parseInt(qtyLots) || 0;

    if (quantity <= 0) {
      toast.error("Please enter a valid quantity");
      return;
    }

    // Map productType to Kite product code
    const productMap: Record<string, string> = {
      Margin: "MIS",
      Normal: "NRML",
      Cover: "CO",
      Bracket: "BO",
    };
    const product = productMap[productType] || "MIS";

    // Map orderType to Kite order type (uppercase)
    const kiteOrderType = orderType.toUpperCase();

    // Map exchange to derivatives exchange for options
    const derivExchange =
      exchange === "NSE" ? "NFO" : exchange === "BSE" ? "BFO" : exchange;

    setPlacingOrder(true);
    try {
      const res = await apiFetch<{ orderId: string }>("/kite/place-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brokerId: selectedBrokerId,
          tradingsymbol,
          exchange: derivExchange,
          transactionType,
          quantity: quantity,
          product: product,
          orderType: kiteOrderType,
        }),
      });

      toast.success(
        `Order placed successfully!\nSymbol: ${tradingsymbol}\nType: ${transactionType}\nQty: ${quantity}\nOrder ID: ${res.orderId}`
      );

      // Refresh positions tab after order placement
      if (tab === "positions") {
        await loadTabData();
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to place order");
    } finally {
      setPlacingOrder(false);
    }
  }

  // Helper: adjust SL/Target values
  function adjustValue(currentValue: string, delta: number): string {
    const num = parseFloat(currentValue) || 0;
    const newValue = num + delta;
    // Prevent negative values
    return (newValue < 0 ? 0 : newValue).toFixed(2);
  }

  // Helper: format YYYY-MM-DD → 26DEC24 (Kite tradingsymbol format: DDMMMYY)
  function formatExpiryForTradingsymbol(expiry: string): string {
    if (!expiry) return "";
    const [y, m, d] = expiry.split("-");
    const months = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ];
    const dd = d || "";
    const mon = m ? months[parseInt(m, 10) - 1] || "" : "";
    const yy = y ? y.slice(2) : "";
    return `${dd}${mon}${yy}`;
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="flex items-center justify-between border-b border-[rgba(189,195,199,.58)] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-zinc-600">Broker:</div>
          <select
            className="min-w-72 rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
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

          <button
            type="button"
            className="ml-1 rounded-md border border-[rgba(189,195,199,.58)] px-2 py-2 text-zinc-600 hover:bg-zinc-50"
            aria-label="Settings"
            title="Settings"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
              <path d="M19.4 15a7.9 7.9 0 0 0 .1-2l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-1.7-1l-.4-2.6H11l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7.9 7.9 0 0 0 .1 2l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5Z" />
            </svg>
          </button>
        </div>

        <div className="text-xs text-zinc-500">{formatDateTime(now)}</div>
      </div>

      {!selectedBrokerId ? (
        <div className="p-6">
          <div className="rounded-lg border border-[rgba(189,195,199,.58)] bg-zinc-50 p-4 text-sm text-zinc-700">
            Select a broker from the dropdown to start trading.
          </div>
        </div>
      ) : !selectedBroker ? (
        <div className="p-6">
          <div className="rounded-lg border border-[rgba(189,195,199,.58)] bg-zinc-50 p-4 text-sm text-zinc-700">
            Selected broker not found (it may have been deleted). Please select
            another broker.
          </div>
        </div>
      ) : (
        <div className="p-4">
          {/* Top controls */}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Exchange</div>
              <select
                className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
              >
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Segment</div>
              <select
                className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
              >
                <option value="Options">Options</option>
                <option value="Futures">Futures</option>
                <option value="Equity">Equity</option>
              </select>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Symbol</div>
              {exchange === "NSE" ? (
                <select
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                >
                  {symbolGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : exchange === "BSE" ? (
                <select
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                >
                  {bseSymbolGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((opt) => (
                        <option
                          key={`${g.label}:${opt.value || "__empty__"}`}
                          value={opt.value}
                        >
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                />
              )}
              {exchange === "NSE" && !isNseSymbol ? (
                <div className="mt-1 text-[10px] text-zinc-400">
                  Select a valid NSE symbol
                </div>
              ) : exchange === "BSE" && symbol !== "" && !isBseSymbol ? (
                <div className="mt-1 text-[10px] text-zinc-400">
                  Select a valid BSE symbol
                </div>
              ) : null}
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Expiry Date</div>
              {(segment === "Options" || segment === "Futures") &&
              expiryDates.length > 0 ? (
                <select
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                >
                  {expiryDates.map((exp) => (
                    <option key={exp} value={exp}>
                      {exp}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  placeholder={
                    segment === "Options" || segment === "Futures"
                      ? "Loading..."
                      : "Expiry Date"
                  }
                />
              )}
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Call Strike</div>
              {segment === "Options" && availableStrikes.length > 0 ? (
                <select
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={callStrike}
                  onChange={(e) => setCallStrike(e.target.value)}
                >
                  {availableStrikes.map((strike) => (
                    <option key={`call-${strike}`} value={strike}>
                      {strike}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={callStrike}
                  onChange={(e) => setCallStrike(e.target.value)}
                />
              )}
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Put Strike</div>
              {segment === "Options" && availableStrikes.length > 0 ? (
                <select
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={putStrike}
                  onChange={(e) => setPutStrike(e.target.value)}
                >
                  {availableStrikes.map((strike) => (
                    <option key={`put-${strike}`} value={strike}>
                      {strike}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                  value={putStrike}
                  onChange={(e) => setPutStrike(e.target.value)}
                />
              )}
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">
                Qty (Lot Size:{" "}
                {lotSize > 0 ? Math.round(Number(qtyLots) / lotSize) : 1})
              </div>
              <div className="mt-1 flex">
                {qtyOptions.length > 0 ? (
                  <select
                    className="w-full rounded-l-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                    value={qtyLots}
                    onChange={(e) => {
                      setQtyLots(e.target.value);
                    }}
                  >
                    {qtyOptions.map((qty) => (
                      <option key={qty} value={String(qty)}>
                        {qty} Qty
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="w-full rounded-l-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                    value={qtyLots}
                    onChange={(e) => setQtyLots(e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="rounded-r-md bg-red-600 px-3 text-sm font-semibold text-white"
                >
                  Qty
                </button>
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Product Type</div>
              <select
                className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                value={productType}
                onChange={(e) => setProductType(e.target.value)}
              >
                <option value="Margin">Margin</option>
                <option value="CNC">CNC</option>
                <option value="MIS">MIS</option>
              </select>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Order Type</div>
              <select
                className="mt-1 w-full rounded-md border border-[rgba(189,195,199,.58)] bg-white px-3 py-2 text-sm"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value)}
              >
                <option value="Market">Market</option>
                <option value="Limit">Limit</option>
              </select>
            </div>

            {/* <div className="col-span-2">
              <div className="text-xs text-zinc-500">Market Protection %</div>
              <select
                className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm"
                value={marketProtection}
                onChange={(e) => setMarketProtection(e.target.value)}
              >
                <option value="10%">10%</option>
                <option value="5%">5%</option>
                <option value="0%">0%</option>
              </select>
            </div> 

            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Predefined SL</div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={usePredefinedSl}
                  onChange={(e) => setUsePredefinedSl(e.target.checked)}
                />
                <input
                  className="w-full rounded-md border bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
                  value={predefinedSl}
                  onChange={(e) => setPredefinedSl(e.target.value)}
                  disabled={!usePredefinedSl}
                  placeholder=""
                />
                <div className="text-xs text-zinc-500">Pts.</div>
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Predefined Target</div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={usePredefinedTarget}
                  onChange={(e) => setUsePredefinedTarget(e.target.checked)}
                />
                <input
                  className="w-full rounded-md border bg-white px-3 py-2 text-sm disabled:bg-zinc-50"
                  value={predefinedTarget}
                  onChange={(e) => setPredefinedTarget(e.target.value)}
                  disabled={!usePredefinedTarget}
                  placeholder=""
                />
                <div className="text-xs text-zinc-500">Pts.</div>
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Position Type</div>
              <select
                className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm"
                value={positionType}
                onChange={(e) => setPositionType(e.target.value)}
              >
                <option value="F&O positions only">F&O positions only</option>
                <option value="All positions">All positions</option>
              </select>
              <div className="mt-1 text-[10px] text-zinc-400">
                Changing type will reset all SL & Target
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Position View</div>
              <select
                className="mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm"
                value={positionView}
                onChange={(e) => setPositionView(e.target.value)}
              >
                <option value="All positions">All positions</option>
                <option value="Open positions">Open positions</option>
              </select>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-zinc-500">Action</div>
              <button
                type="button"
                className="mt-1 w-full rounded-md border border-red-600 px-3 py-2 text-sm font-semibold text-red-600"
              >
                Show Options List
              </button>
            </div> */}
            <div className="col-span-2 flex items-end justify-end">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={oneClickEnabled}
                  onChange={(e) => setOneClickEnabled(e.target.checked)}
                />
                <span>
                  One click:{" "}
                  <span className="text-zinc-500">
                    {oneClickEnabled ? "Enabled" : "Disabled"}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* LTP + actions row */}
          <div className="mt-4 grid grid-cols-12 items-center gap-3 border-t border-[rgba(189,195,199,.58)] pt-4">
            <div className="col-span-4">
              <div className="text-xs font-semibold text-zinc-700">
                {symbol || "—"}{" "}
                {expiryDate ? formatExpiryForTradingsymbol(expiryDate) : ""}{" "}
                {callStrike} CE
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                LTP: {callLtp !== null ? callLtp.toFixed(2) : "—"}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex rounded-md border border-[rgba(189,195,199,.58)] overflow-hidden">
                  <button
                    type="button"
                    className="bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    onClick={() => placeOrder(callTradingsymbol, "SELL", "CE")}
                    disabled={placingOrder || !callTradingsymbol}
                  >
                    Sell Call
                  </button>
                  <button
                    type="button"
                    className="bg-white px-3 py-2 text-zinc-600"
                    aria-label="Sell Call menu"
                    title="Sell Call menu"
                  >
                    ▾
                  </button>
                </div>

                <div className="flex rounded-md border border-[rgba(189,195,199,.58)] overflow-hidden">
                  <button
                    type="button"
                    className="bg-green-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    onClick={() => placeOrder(callTradingsymbol, "BUY", "CE")}
                    disabled={placingOrder || !callTradingsymbol}
                  >
                    Buy Call
                  </button>
                  <button
                    type="button"
                    className="bg-white px-3 py-2 text-zinc-600"
                    aria-label="Buy Call menu"
                    title="Buy Call menu"
                  >
                    ▾
                  </button>
                </div>
              </div>
            </div>

            <div className="col-span-4 text-center">
              <div className="text-xs font-semibold text-zinc-700">
                {symbol || "—"}
              </div>
              <div className="mt-1 text-sm">
                <span className="text-zinc-600">LTP:</span>{" "}
                <span className="font-semibold text-zinc-900">
                  {underlyingLtp !== null ? underlyingLtp.toFixed(2) : "—"}
                </span>{" "}
                <span className="font-semibold text-green-600">
                  {/* TODO: calculate change % */}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-[rgba(189,195,199,.58)] px-3 py-2 text-xs font-semibold text-red-600"
                >
                  Close All Positions / F6
                </button>
                <button
                  type="button"
                  className="rounded-md border border-[rgba(189,195,199,.58)] px-3 py-2 text-xs font-semibold text-red-600"
                >
                  Cancel All Orders / F7
                </button>
                <button
                  type="button"
                  className="rounded-md border border-[rgba(189,195,199,.58)] px-3 py-2 text-zinc-600 hover:bg-zinc-50"
                  aria-label="Refresh"
                  title="Refresh"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v7h-7" />
                  </svg>
                </button>
              </div>

              <div className="mt-2 text-xs text-zinc-500">Message: --</div>
            </div>

            <div className="col-span-4 text-right">
              <div className="text-xs font-semibold text-zinc-700">
                {symbol || "—"}{" "}
                {expiryDate ? formatExpiryForTradingsymbol(expiryDate) : ""}{" "}
                {putStrike} PE
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                LTP: {putLtp !== null ? putLtp.toFixed(2) : "—"}
              </div>
              <div className="mt-2 flex items-center justify-end gap-2">
                <div className="flex rounded-md border border-[rgba(189,195,199,.58)] overflow-hidden">
                  <button
                    type="button"
                    className="bg-green-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    onClick={() => placeOrder(putTradingsymbol, "BUY", "PE")}
                    disabled={placingOrder || !putTradingsymbol}
                  >
                    Buy Put
                  </button>
                  <button
                    type="button"
                    className="bg-white px-3 py-2 text-zinc-600"
                    aria-label="Buy Put menu"
                    title="Buy Put menu"
                  >
                    ▾
                  </button>
                </div>

                <div className="flex rounded-md border border-[rgba(189,195,199,.58)] overflow-hidden">
                  <button
                    type="button"
                    className="bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    onClick={() => placeOrder(putTradingsymbol, "SELL", "PE")}
                    disabled={placingOrder || !putTradingsymbol}
                  >
                    Sell Put
                  </button>
                  <button
                    type="button"
                    className="bg-white px-3 py-2 text-zinc-600"
                    aria-label="Sell Put menu"
                    title="Sell Put menu"
                  >
                    ▾
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Tabs + grid area */}
          <div className="mt-4 border-t border-[rgba(189,195,199,.58)] pt-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={classNames(
                      "rounded-md px-4 py-2 text-sm",
                      tab === t.key
                        ? "border border-[rgba(189,195,199,.58)] text-red-600 bg-[#f5f7f7]"
                        : "border border-transparent text-zinc-700 hover:bg-zinc-50"
                    )}
                  >
                    {t.label}
                  </button>
                ))}

                <button
                  type="button"
                  className="rounded-md px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  onClick={loadTabData}
                  disabled={loadingTabData}
                >
                  {loadingTabData ? "Refreshing..." : "Refresh Data"}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-6 text-xs text-zinc-600">
                <div>
                  Total P&L:{" "}
                  <span
                    className={
                      totalPnl > 0
                        ? "text-green-600"
                        : totalPnl < 0
                        ? "text-red-600"
                        : ""
                    }
                  >
                    {totalPnl.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-3 rounded-md border border-[rgba(189,195,199,.58)]">
              {tab === "positions" && (
                <>
                  <div className="border-b border-[rgba(189,195,199,.58)] px-4 py-3 text-xs text-red-600">
                    Net positions shown below:
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-225 text-left text-xs">
                      <thead className="bg-white text-zinc-500">
                        <tr className="border-b">
                          <th className="px-3 py-3 font-medium">
                            <input type="checkbox" aria-label="Select all" />
                          </th>
                          <th className="px-3 py-3 font-medium">
                            Tradingsymbol
                          </th>
                          <th className="px-3 py-3 font-medium">Product</th>
                          <th className="px-3 py-3 font-medium">Qty</th>
                          <th className="px-3 py-3 font-medium">Avg Price</th>
                          <th className="px-3 py-3 font-medium">LTP</th>
                          <th className="px-3 py-3 font-medium">SL</th>
                          <th className="px-3 py-3 font-medium">Target</th>
                          <th className="px-3 py-3 font-medium">P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loadingTabData ? (
                          <tr>
                            <td
                              colSpan={9}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              Loading...
                            </td>
                          </tr>
                        ) : positions.net.length === 0 ? (
                          <tr>
                            <td
                              colSpan={9}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              No Positions
                            </td>
                          </tr>
                        ) : (
                          positions.net.map((p: any, i: number) => {
                            const isClosed = p.quantity === 0;
                            const slValue = positionSL[i] || "";
                            const targetValue = positionTarget[i] || "";

                            return (
                              <tr
                                key={i}
                                className="border-b border-[rgba(189,195,199,.58)] even:bg-[#f5f7f7]"
                              >
                                <td className="px-3 py-2">
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${p.tradingsymbol}`}
                                    disabled={isClosed}
                                    className={
                                      isClosed
                                        ? "opacity-50 cursor-not-allowed"
                                        : ""
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">{p.tradingsymbol}</td>
                                <td className="px-3 py-2">{p.product}</td>
                                <td className="px-3 py-2">{p.quantity}</td>
                                <td className="px-3 py-2">
                                  {p.average_price?.toFixed(2)}
                                </td>
                                <td className="px-3 py-2">
                                  {p.last_price?.toFixed(2)}
                                </td>
                                <td className="px-3 py-2">
                                  {isClosed ? (
                                    <span className="text-zinc-400">—</span>
                                  ) : (
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        className="w-7 h-7 rounded-full bg-red-500 text-white hover:bg-red-600 flex items-center justify-center text-lg font-bold cursor-pointer"
                                        onClick={() => {
                                          setPositionSL((prev) => ({
                                            ...prev,
                                            [i]: adjustValue(slValue, -1),
                                          }));
                                        }}
                                        title="Decrease SL"
                                      >
                                        −
                                      </button>
                                      <input
                                        type="text"
                                        className="w-16 rounded border border-[rgba(189,195,199,.58)] px-2 py-1 text-center"
                                        placeholder="SL"
                                        value={slValue}
                                        onChange={(e) => {
                                          setPositionSL((prev) => ({
                                            ...prev,
                                            [i]: e.target.value,
                                          }));
                                        }}
                                      />
                                      <button
                                        type="button"
                                        className="w-7 h-7 rounded-full bg-green-500 text-white hover:bg-green-600 flex items-center justify-center text-lg font-bold cursor-pointer"
                                        onClick={() => {
                                          setPositionSL((prev) => ({
                                            ...prev,
                                            [i]: adjustValue(slValue, 1),
                                          }));
                                        }}
                                        title="Increase SL"
                                      >
                                        +
                                      </button>
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2">
                                  {isClosed ? (
                                    <span className="text-zinc-400">—</span>
                                  ) : (
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        className="w-7 h-7 rounded-full bg-red-500 text-white hover:bg-red-600 flex items-center justify-center text-lg font-bold cursor-pointer"
                                        onClick={() => {
                                          setPositionTarget((prev) => ({
                                            ...prev,
                                            [i]: adjustValue(targetValue, -1),
                                          }));
                                        }}
                                        title="Decrease Target"
                                      >
                                        −
                                      </button>
                                      <input
                                        type="text"
                                        className="w-16 rounded border border-[rgba(189,195,199,.58)] px-2 py-1 text-center"
                                        placeholder="Target"
                                        value={targetValue}
                                        onChange={(e) => {
                                          setPositionTarget((prev) => ({
                                            ...prev,
                                            [i]: e.target.value,
                                          }));
                                        }}
                                      />
                                      <button
                                        type="button"
                                        className="w-7 h-7 rounded-full bg-green-500 text-white hover:bg-green-600 flex items-center justify-center text-lg font-bold cursor-pointer"
                                        onClick={() => {
                                          setPositionTarget((prev) => ({
                                            ...prev,
                                            [i]: adjustValue(targetValue, 1),
                                          }));
                                        }}
                                        title="Increase Target"
                                      >
                                        +
                                      </button>
                                    </div>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 ${
                                    p.pnl > 0
                                      ? "text-green-600"
                                      : p.pnl < 0
                                      ? "text-red-600"
                                      : ""
                                  }`}
                                >
                                  {p.pnl?.toFixed(2)}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {tab === "orderBook" && (
                <>
                  <div className="border-b border-[rgba(189,195,199,.58)] px-4 py-3 text-xs text-red-600">
                    Order book:
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-225 text-left text-xs">
                      <thead className="bg-white text-zinc-500">
                        <tr className="border-b">
                          <th className="px-3 py-3 font-medium">Time</th>
                          <th className="px-3 py-3 font-medium">
                            Tradingsymbol
                          </th>
                          <th className="px-3 py-3 font-medium">Type</th>
                          <th className="px-3 py-3 font-medium">Qty</th>
                          <th className="px-3 py-3 font-medium">Price</th>
                          <th className="px-3 py-3 font-medium">Status</th>
                          <th className="px-3 py-3 font-medium">Product</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loadingTabData ? (
                          <tr>
                            <td
                              colSpan={7}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              Loading...
                            </td>
                          </tr>
                        ) : orders.length === 0 ? (
                          <tr>
                            <td
                              colSpan={7}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              No Orders
                            </td>
                          </tr>
                        ) : (
                          orders.map((o: any, i: number) => (
                            <tr
                              key={i}
                              className="border-b border-[rgba(189,195,199,.58)] even:bg-[#f5f7f7]"
                            >
                              <td className="px-3 py-2">{o.order_timestamp}</td>
                              <td className="px-3 py-2">{o.tradingsymbol}</td>
                              <td className="px-3 py-2">
                                {o.transaction_type}
                              </td>
                              <td className="px-3 py-2">{o.quantity}</td>
                              <td className="px-3 py-2">
                                {o.price?.toFixed(2)}
                              </td>
                              <td className="px-3 py-2">{o.status}</td>
                              <td className="px-3 py-2">{o.product}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {tab === "tradeBook" && (
                <>
                  <div className="border-b border-[rgba(189,195,199,.58)] px-4 py-3 text-xs text-red-600">
                    Trade book:
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-225 text-left text-xs">
                      <thead className="bg-white text-zinc-500">
                        <tr className="border-b">
                          <th className="px-3 py-3 font-medium">Time</th>
                          <th className="px-3 py-3 font-medium">
                            Tradingsymbol
                          </th>
                          <th className="px-3 py-3 font-medium">Type</th>
                          <th className="px-3 py-3 font-medium">Qty</th>
                          <th className="px-3 py-3 font-medium">Price</th>
                          <th className="px-3 py-3 font-medium">Trade ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loadingTabData ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              Loading...
                            </td>
                          </tr>
                        ) : trades.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              No Trades
                            </td>
                          </tr>
                        ) : (
                          trades.map((t: any, i: number) => (
                            <tr
                              key={i}
                              className="border-b border-[rgba(189,195,199,.58)] even:bg-[#f5f7f7]"
                            >
                              <td className="px-3 py-2">{t.fill_timestamp}</td>
                              <td className="px-3 py-2">{t.tradingsymbol}</td>
                              <td className="px-3 py-2">
                                {t.transaction_type}
                              </td>
                              <td className="px-3 py-2">{t.quantity}</td>
                              <td className="px-3 py-2">
                                {t.average_price?.toFixed(2)}
                              </td>
                              <td className="px-3 py-2">{t.trade_id}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {tab === "holdings" && (
                <>
                  <div className="border-b border-[rgba(189,195,199,.58)] px-4 py-3 text-xs text-red-600">
                    Holdings:
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full min-w-225 text-left text-xs">
                      <thead className="bg-[#f5f7f7] text-zinc-500">
                        <tr className="border-b border-[rgba(189,195,199,.58)]">
                          <th className="px-3 py-3 font-medium">Exchange</th>
                          <th className="px-3 py-3 font-medium">
                            Tradingsymbol
                          </th>
                          <th className="px-3 py-3 font-medium">Qty</th>
                          <th className="px-3 py-3 font-medium">Avg Price</th>
                          <th className="px-3 py-3 font-medium">LTP</th>
                          <th className="px-3 py-3 font-medium">P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loadingTabData ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              Loading...
                            </td>
                          </tr>
                        ) : holdings.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-20 text-center text-zinc-500"
                            >
                              No Holdings
                            </td>
                          </tr>
                        ) : (
                          holdings.map((h: any, i: number) => (
                            <tr
                              key={i}
                              className="border-b border-[rgba(189,195,199,.58)] even:bg-[#f5f7f7]"
                            >
                              <td className="px-3 py-2">{h.exchange}</td>
                              <td className="px-3 py-2">{h.tradingsymbol}</td>
                              <td className="px-3 py-2">{h.quantity}</td>
                              <td className="px-3 py-2">
                                {h.average_price?.toFixed(2)}
                              </td>
                              <td className="px-3 py-2">
                                {h.last_price?.toFixed(2)}
                              </td>
                              <td
                                className={`px-3 py-2 ${
                                  h.pnl > 0
                                    ? "text-green-600"
                                    : h.pnl < 0
                                    ? "text-red-600"
                                    : ""
                                }`}
                              >
                                {h.pnl?.toFixed(2)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {tab === "funda" && (
                <>
                  <div className="border-b border-[rgba(189,195,199,.58)] px-4 py-3 text-xs text-red-600">
                    Funds & Margins:
                  </div>

                  <div className="p-4">
                    {loadingTabData ? (
                      <div className="py-20 text-center text-zinc-500">
                        Loading...
                      </div>
                    ) : margins ? (
                      <div className="space-y-4">
                        {margins.equity && (
                          <div>
                            <div className="font-medium text-zinc-700">
                              Equity
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                              <div>
                                Available Cash:{" "}
                                {margins.equity.available?.cash?.toFixed(2)}
                              </div>
                              <div>
                                Used:{" "}
                                {margins.equity.utilised?.debits?.toFixed(2)}
                              </div>
                              <div>
                                Available Margin:{" "}
                                {margins.equity.available?.live_balance?.toFixed(
                                  2
                                )}
                              </div>
                              <div>
                                Opening Balance:{" "}
                                {margins.equity.available?.opening_balance?.toFixed(
                                  2
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {margins.commodity && (
                          <div>
                            <div className="font-medium text-zinc-700">
                              Commodity
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                              <div>
                                Available Cash:{" "}
                                {margins.commodity.available?.cash?.toFixed(2)}
                              </div>
                              <div>
                                Used:{" "}
                                {margins.commodity.utilised?.debits?.toFixed(2)}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="py-20 text-center text-zinc-500">
                        No margin data
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 text-xs text-zinc-500">
              <div className="font-semibold text-zinc-600">
                Notes & Disclaimer:
              </div>
              <div className="mt-1 space-y-1">
                <div>
                  1. Stoploss and Trailing Stoploss feature will only work if
                  Trade Terminal window is opened.
                </div>
                <div>
                  2. Stoploss and Trailing Stoploss will be removed if window is
                  reloaded.
                </div>
                <div>
                  3. Orders placed after market hours may get placed with AMO
                  flag (when enabled).
                </div>
                <div>
                  4. We are not responsible for any losses you may incur using
                  this terminal.
                </div>
                <div>
                  5. Please consult your investment/financial adviser before
                  trading/investing.
                </div>
              </div>
            </div>

            <div className="mt-3 text-[11px] text-zinc-400">
              Selected broker: {selectedBroker.type} • {selectedBroker.name} •{" "}
              {selectedBroker.brokerIdMasked}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";
import type { IChartApi } from "lightweight-charts";
import { io, Socket } from "socket.io-client";

type ChartCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

// Delta API returns UTC timestamps; shift to IST (UTC+5:30) for display
const IST_OFFSET = 5.5 * 3600; // 19800 seconds
const toIST = (c: ChartCandle): ChartCandle => ({
  ...c,
  time: c.time + IST_OFFSET,
});

type Props = {
  isOpen: boolean;
  onClose: () => void;
  symbol: string;
  interval: string;
};

function fmt(n: number) {
  if (n >= 1000)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export default function DeltaChartModal({
  isOpen,
  onClose,
  symbol,
  interval,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noData, setNoData] = useState(false);
  const [ltp, setLtp] = useState<number | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let destroyed = false;

    //  Init chart
    const initChart = async () => {
      setLoading(true);
      setError(null);
      setNoData(false);
      setLtp(null);

      await new Promise((r) => requestAnimationFrame(r));
      if (destroyed || !containerRef.current) return;

      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candleRef.current = null;

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 480,
        layout: { background: { color: "#1a1a1a" }, textColor: "#d1d4dc" },
        grid: {
          vertLines: { color: "#2b2b43" },
          horzLines: { color: "#2b2b43" },
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: false,
          borderColor: "#2b2b43",
        },
        rightPriceScale: { borderColor: "#2b2b43" },
      });
      chartRef.current = chart;

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderVisible: false,
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      });
      candleRef.current = candleSeries;

      setLoading(false);

      //  Connect WebSocket
      const apiUrl =
        process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
      const socket = io(apiUrl, {
        withCredentials: true,
        transports: ["websocket", "polling"],
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        setConnected(true);
        socket.emit("subscribe-delta-chart", { symbol, interval });
      });

      socket.on("disconnect", () => setConnected(false));

      socket.on(
        "delta-chart-full",
        (data: {
          symbol: string;
          interval: string;
          candles: ChartCandle[];
        }) => {
          if (destroyed || !candleRef.current || !chartRef.current) return;
          if (containerRef.current) {
            chartRef.current.applyOptions({
              width: containerRef.current.clientWidth,
            });
          }
          if (data.candles.length < 5) {
            setNoData(true);
          }
          candleRef.current.setData(data.candles.map(toIST) as any);
          chartRef.current.timeScale().fitContent();
          const last = data.candles[data.candles.length - 1];
          if (last) setLtp(last.close);
          setLastUpdate(new Date().toLocaleTimeString());
        },
      );

      socket.on(
        "delta-chart-candle",
        (data: { symbol: string; candle: ChartCandle }) => {
          if (destroyed || !candleRef.current) return;
          candleRef.current.update(toIST(data.candle) as any);
          setLtp(data.candle.close);
          setLastUpdate(new Date().toLocaleTimeString());
        },
      );

      socket.on("delta-chart-error", (data: { message: string }) => {
        if (!destroyed) setError(data.message || "Failed to load chart data");
      });
    };

    initChart();

    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
        });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      destroyed = true;
      window.removeEventListener("resize", handleResize);
      if (socketRef.current) {
        socketRef.current.emit("unsubscribe-delta-chart");
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candleRef.current = null;
    };
  }, [isOpen, symbol, interval]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
      onClick={onClose}
    >
      <div
        className="bg-[#1a1a1a] rounded-xl shadow-2xl w-[96%] max-w-5xl max-h-[92vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2b2b43]">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">{symbol}</h2>
                <span
                  className={`h-2 w-2 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-slate-500"}`}
                />
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                {interval} candles &nbsp;&nbsp; Delta Exchange
                {lastUpdate && <> &nbsp;&nbsp; Updated {lastUpdate}</>}
              </p>
            </div>
            {ltp != null && (
              <div className="rounded-lg bg-[#252525] border border-[#2b2b43] px-3 py-1.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">
                  Price
                </p>
                <p className="text-lg font-bold font-mono text-white tabular-nums">
                  ${fmt(ltp)}
                </p>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl font-bold w-8 h-8 flex items-center justify-center"
          ></button>
        </div>

        {/* Chart */}
        <div className="p-4">
          <div className="relative" style={{ height: 480 }}>
            {/* Chart container is always mounted so clientWidth is non-zero on init */}
            <div
              ref={containerRef}
              className="w-full"
              style={{ height: 480 }}
            />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
                <span className="ml-3 text-gray-300 text-sm">
                  Connecting to Delta Exchange
                </span>
              </div>
            )}
            {error && !loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}
            {noData && !loading && !error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <p className="text-yellow-400 text-sm font-medium">
                  Insufficient trading data
                </p>
                <p className="text-gray-500 text-xs mt-1">
                  {symbol} has very low liquidity on Delta Exchange at the{" "}
                  {interval} timeframe.
                </p>
                <p className="text-gray-500 text-xs">
                  Try switching to a longer interval (e.g. 5m or 15m).
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="px-5 pb-4 flex flex-wrap gap-5 text-xs text-gray-500 border-t border-[#2b2b43] pt-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-[#26a69a]" />{" "}
            Bullish
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-[#ef5350]" />{" "}
            Bearish
          </span>
        </div>
      </div>
    </div>
  );
}

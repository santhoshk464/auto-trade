"use client";

import { useEffect, useRef, useState } from "react";
import { createChart } from "lightweight-charts";
import type { IChartApi } from "lightweight-charts";
import { io, Socket } from "socket.io-client";
import toast from "react-hot-toast";

type ChartSignal = {
  time: number;
  type: "BUY" | "SELL";
  price: number;
  stopLoss: number;
  target: number;
  text: string;
};

type ChartCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type EmaPoint = {
  time: number;
  value: number;
};

type DetailedTrade = {
  entryLogic: string;
  entryPrice: number;
  exitPrice: number | null;
  exitReason: "SL_HIT" | "TARGET_HIT" | "OPEN";
  profitLoss: number;
  entryTime: number;
  exitTime: number | null;
};

type ChartData = {
  candles: ChartCandle[];
  signals: ChartSignal[];
  ema?: EmaPoint[];
  yesterdayHigh?: number;
  yesterdayLow?: number;
  statistics?: {
    totalTrades: number;
    slHits: number;
    targetHits: number;
    openTrades: number;
    totalProfitPerLot: number;
    trades?: DetailedTrade[];
  };
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  brokerId: string;
  instrumentToken: number;
  tradingsymbol: string;
  targetDate: string;
  interval: string;
  strategy: string;
  marginPoints: number;
  overrideSignals?: ChartSignal[];
};

export default function OptionChartModal({
  isOpen,
  onClose,
  brokerId,
  instrumentToken,
  tradingsymbol,
  targetDate,
  interval,
  strategy,
  marginPoints,
  overrideSignals,
}: Props) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const emaSeriesRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
  const pendingDataRef = useRef<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statistics, setStatistics] = useState<any>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<string>("");
  const [isConnected, setIsConnected] = useState(false);
  const [chartReady, setChartReady] = useState(false);

  // Helper function to render chart with data
  const renderChartData = (data: ChartData, shouldFitContent = false) => {
    if (!chartRef.current || !candleSeriesRef.current) {
      // Buffer data until chart is ready
      console.log("Chart not ready, buffering data");
      pendingDataRef.current = data;
      return;
    }

    if (!chartReady) {
      // Chart structure exists but not fully ready yet
      console.log("Chart not ready yet, buffering data");
      pendingDataRef.current = data;
      return;
    }

    const chart = chartRef.current;

    console.log("Rendering chart with data:", {
      candles: data.candles?.length,
      signals: data.signals?.length,
      statistics: data.statistics,
      strategy,
      marginPoints,
    });

    // Update candlestick data
    if (candleSeriesRef.current) {
      candleSeriesRef.current.setData(data.candles as any);
      console.log("Set candle data:", data.candles.length, "candles");
    }

    // Update 20 EMA data for all strategies
    if (data.ema && data.ema.length > 0 && emaSeriesRef.current) {
      emaSeriesRef.current.setData(data.ema as any);
      console.log("Set EMA data:", data.ema.length, "points");
    }

    // Update statistics — suppress when overrideSignals are present because the
    // backend computed these stats from its own SELL detection, which is irrelevant
    // for a complementary BUY chart.
    if (data.statistics && !(overrideSignals && overrideSignals.length > 0)) {
      setStatistics(data.statistics);
    }

    // Always clear markers first to remove old signals
    if (candleSeriesRef.current) {
      candleSeriesRef.current.setMarkers([]);
      console.log("Cleared all existing markers");
    }

    // Update markers if there are signals - must be done after setData
    // If overrideSignals were passed (e.g. complementary BUY injection), use those
    // instead of whatever the server re-detected for this instrument.
    const signalsToRender =
      overrideSignals && overrideSignals.length > 0
        ? overrideSignals
        : data.signals;
    if (
      signalsToRender &&
      signalsToRender.length > 0 &&
      candleSeriesRef.current
    ) {
      console.log(
        "📊 Processing",
        signalsToRender.length,
        "signals for markers",
      );
      console.log("📊 Signals data:", JSON.stringify(signalsToRender));

      // Sort markers ascending by time — lightweight-charts v3 requires sorted order
      const markers = signalsToRender
        .map((signal) => {
          console.log("📍 Signal:", signal.type, "at time:", signal.time);
          return {
            time: signal.time,
            position:
              signal.type === "BUY"
                ? ("belowBar" as const)
                : ("aboveBar" as const),
            color: signal.type === "BUY" ? "#4caf50" : "#f44336",
            shape:
              signal.type === "BUY"
                ? ("arrowUp" as const)
                : ("arrowDown" as const),
            text: signal.type,
          };
        })
        .sort((a, b) => (a.time as number) - (b.time as number));

      // Set markers after a small delay to ensure candle data is rendered
      setTimeout(() => {
        if (candleSeriesRef.current) {
          candleSeriesRef.current.setMarkers(markers);
          console.log(
            "Markers set:",
            markers.length,
            "times:",
            markers.map((m) => m.time),
          );
        }
      }, 100);
    } else {
      console.log("No signals to display - markers already cleared");
    }

    // Fit content if requested
    if (shouldFitContent && chart) {
      // Use setTimeout to ensure data is fully rendered before fitting
      setTimeout(() => {
        if (chartRef.current && chartContainerRef.current) {
          // Force chart to recalculate dimensions
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
          });
          chartRef.current.timeScale().fitContent();
          console.log("Chart content fitted and resized");
        }
      }, 100);
    }

    setLastUpdateTime(new Date().toLocaleTimeString());
  };

  useEffect(() => {
    if (!isOpen) return;

    const initializeChart = async () => {
      try {
        setLoading(true);
        setError(null);
        setStatistics(null); // Clear old statistics
        setChartReady(false); // Reset chart ready state
        pendingDataRef.current = null; // Clear pending data

        console.log("Initializing chart for:", {
          brokerId,
          instrumentToken,
          tradingsymbol,
          strategy,
          marginPoints,
        });

        // Validate required parameters
        if (!brokerId || brokerId.trim() === "") {
          console.error("Invalid broker ID:", brokerId);
          setError("Invalid broker ID. Please select a broker.");
          setLoading(false);
          return;
        }

        if (!instrumentToken || instrumentToken <= 0) {
          console.error("Invalid instrument token:", instrumentToken);
          setError("Invalid instrument token");
          setLoading(false);
          return;
        }

        // Wait for next frame to ensure DOM is ready
        await new Promise((resolve) => requestAnimationFrame(resolve));

        if (!chartContainerRef.current) {
          console.error("Chart container ref is still null after waiting");
          setError("Chart container not ready");
          setLoading(false);
          return;
        }

        // Clear existing chart and series references completely
        if (chartRef.current) {
          console.log("Removing existing chart and clearing all series");
          chartRef.current.remove();
          chartRef.current = null;
        }
        candleSeriesRef.current = null;
        emaSeriesRef.current = null;

        // Create chart
        console.log(
          "Creating chart with width:",
          chartContainerRef.current.clientWidth,
        );
        const chart = createChart(chartContainerRef.current, {
          width: chartContainerRef.current.clientWidth,
          height: 500,
          layout: {
            background: { color: "#1a1a1a" },
            textColor: "#d1d4dc",
          },
          grid: {
            vertLines: { color: "#2b2b43" },
            horzLines: { color: "#2b2b43" },
          },
          timeScale: {
            timeVisible: true,
            secondsVisible: false,
            borderColor: "#2b2b43",
          },
          rightPriceScale: {
            borderColor: "#2b2b43",
          },
        });

        chartRef.current = chart;

        // Add candlestick series
        const candleSeries = chart.addCandlestickSeries({
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderVisible: false,
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        });
        candleSeriesRef.current = candleSeries;

        // Add 20 EMA line on all charts
        const emaSeries = chart.addLineSeries({
          color: "#ff9800",
          lineWidth: 2,
        });
        emaSeriesRef.current = emaSeries;

        console.log("Chart structure created, waiting for data...");
        setLoading(false);
        setChartReady(true);

        // Render any pending data
        if (pendingDataRef.current) {
          console.log("Rendering pending data after chart ready");
          // Use setTimeout to ensure chart is fully mounted
          setTimeout(() => {
            if (pendingDataRef.current && chartRef.current) {
              // Ensure chart has proper dimensions
              if (chartContainerRef.current) {
                chartRef.current.applyOptions({
                  width: chartContainerRef.current.clientWidth,
                });
              }
              renderChartData(pendingDataRef.current, true);
              pendingDataRef.current = null;
            }
          }, 100);
        }
      } catch (err: any) {
        console.error("Failed to initialize chart:", err);
        setError(err.message || "Failed to initialize chart");
        toast.error("Failed to initialize chart");
        setLoading(false);
      }
    };

    initializeChart();

    // Handle window resize
    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      console.log("Chart cleanup - removing chart instance");
      window.removeEventListener("resize", handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candleSeriesRef.current = null;
      emaSeriesRef.current = null;
      pendingDataRef.current = null;
      setChartReady(false);
    };
  }, [
    isOpen,
    brokerId,
    instrumentToken,
    targetDate,
    interval,
    strategy,
    marginPoints,
  ]);

  // WebSocket connection for real-time updates
  useEffect(() => {
    if (!isOpen || !chartReady) return; // Wait for chart to be ready

    console.log("Setting up WebSocket with params:", {
      strategy,
      marginPoints,
      instrumentToken,
    });

    // Connect to WebSocket server immediately
    const apiUrl =
      process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
    const socket = io(apiUrl, {
      withCredentials: true,
      transports: ["websocket", "polling"],
      forceNew: true, // Force new connection to avoid stale data
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("WebSocket connected for params:", {
        strategy,
        marginPoints,
        instrumentToken,
      });
      setIsConnected(true);

      // Subscribe to chart data updates with timestamp for cache busting
      socket.emit("subscribe-chart", {
        brokerId,
        instrumentToken,
        targetDate,
        interval,
        strategy,
        marginPoints,
        _timestamp: Date.now(), // Cache buster
      });
    });

    socket.on("disconnect", () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
    });

    socket.on("chart-data", (response: { type: string; data: ChartData }) => {
      console.log("Received chart data via WebSocket", {
        type: response.type,
        candles: response.data?.candles?.length,
        signals: response.data?.signals?.length,
        chartReady,
      });

      if (
        response.type === "full" &&
        response.data &&
        response.data.candles &&
        response.data.candles.length > 0
      ) {
        // Ensure chart has proper dimensions before rendering
        if (chartRef.current && chartContainerRef.current) {
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
          });
        }

        // Render chart data (will be buffered if chart not ready, then auto-rendered)
        console.log("Rendering full chart data from WebSocket");
        renderChartData(response.data, true);
      } else {
        console.warn("Received invalid or empty chart data", response);
      }
    });

    socket.on(
      "chart-update",
      (update: { candle: ChartCandle; ema?: EmaPoint; statistics?: any }) => {
        console.log("Received chart update via WebSocket");

        if (update.candle && candleSeriesRef.current) {
          // Update only the last candle for smooth real-time updates
          candleSeriesRef.current.update(update.candle as any);
        }

        if (update.ema && emaSeriesRef.current) {
          emaSeriesRef.current.update(update.ema as any);
        }

        if (update.statistics) {
          setStatistics(update.statistics);
        }

        setLastUpdateTime(new Date().toLocaleTimeString());
      },
    );

    socket.on("chart-error", (error: { message: string }) => {
      console.error("WebSocket chart error:", error);
      toast.error(error.message || "Failed to fetch chart data");
    });

    return () => {
      console.log("WebSocket cleanup - disconnecting");
      if (socketRef.current) {
        try {
          socketRef.current.emit("unsubscribe-chart");
          socketRef.current.disconnect();
        } catch (error) {
          console.error("Error during WebSocket cleanup:", error);
        } finally {
          socketRef.current = null;
        }
      }
      setIsConnected(false);
    };
  }, [
    isOpen,
    chartReady,
    brokerId,
    instrumentToken,
    targetDate,
    interval,
    strategy,
    marginPoints,
  ]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-[#1a1a1a] rounded-lg shadow-2xl w-[95%] max-w-6xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-3">
              {tradingsymbol}
              {isConnected && (
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              )}
            </h2>
            <p className="text-sm text-gray-400">
              {strategy === "20_EMA"
                ? "20 EMA Rejection"
                : strategy === "DAY_SELLING"
                  ? "Day Selling Strategy"
                  : strategy === "DAY_SELLING_V2"
                    ? "Day Selling V2 (3-Setup Engine)"
                    : strategy === "DAY_SELLING_V2_ENHANCED"
                      ? "Day Selling V2 Enhanced (V2 + V4 Filters)"
                      : strategy === "DAY_SELLING_V1V2"
                        ? "Day Selling V1+V2 (Combined)"
                        : strategy === "DAY_SELLING_V3"
                          ? "Day Selling V3 (4-Engine)"
                          : strategy === "DAY_BUYING"
                            ? "Day Buying Strategy"
                            : strategy === "SMART_SELL"
                              ? "Smart Sell (Advanced Filters)"
                              : "Previous Day High/Low"}{" "}
              - {interval} | Margin: {marginPoints}pts
            </p>
            {lastUpdateTime && (
              <p className="text-xs mt-1 text-gray-500">
                Last updated: {lastUpdateTime}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl font-bold w-8 h-8 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        {/* Chart Container */}
        <div className="p-4">
          {loading && (
            <div className="flex items-center justify-center h-125">
              <div className="text-white text-lg">Loading chart...</div>
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-125">
              <div className="text-red-500 text-lg">{error}</div>
            </div>
          )}
          <div
            ref={chartContainerRef}
            className="w-full"
            style={{
              display: loading || error ? "none" : "block",
              minHeight: "500px",
              height: "500px",
            }}
          />
        </div>

        {/* Legend */}
        <div className="px-4 pb-4 flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-[#26a69a]"></div>
            <span className="text-gray-300">Bullish Candle</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 bg-[#ef5350]"></div>
            <span className="text-gray-300">Bearish Candle</span>
          </div>
          {(strategy === "DAY_SELLING" ||
            strategy === "DAY_SELLING_V2" ||
            strategy === "DAY_SELLING_V2_ENHANCED" ||
            strategy === "DAY_SELLING_V1V2" ||
            strategy === "DAY_SELLING_V3") && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-0.5 bg-[#f44336] border-dashed"></div>
              <span className="text-gray-300">Yesterday High</span>
            </div>
          )}
          {strategy === "DAY_BUYING" && (
            <div className="flex items-center gap-2">
              <div className="w-8 h-0.5 bg-[#4caf50] border-dashed"></div>
              <span className="text-gray-300">Yesterday Low</span>
            </div>
          )}
          {strategy === "SMART_SELL" && (
            <>
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 bg-[#f44336] border-dashed"></div>
                <span className="text-gray-300">Yesterday High</span>
              </div>
              <div className="mt-2 p-2 bg-blue-900/30 rounded border border-blue-700/50">
                <p className="text-xs text-blue-300">
                  🎯 <strong>Advanced Filters:</strong> RSI &gt; 60 | Time:
                  10:30 AM - 2:30 PM | Volume &gt; 1.2x avg | 2+ patterns
                  required
                </p>
              </div>
            </>
          )}
          {strategy === "PREV_DAY_HIGH_LOW" && (
            <>
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 bg-[#f44336] border-dashed"></div>
                <span className="text-gray-300">Yesterday High</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-0.5 bg-[#4caf50] border-dashed"></div>
                <span className="text-gray-300">Yesterday Low</span>
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-[#ff9800]"></div>
            <span className="text-gray-300">20 EMA</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#4caf50] text-xl">▲</span>
            <span className="text-gray-300">Buy Signal</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#f44336] text-xl">▼</span>
            <span className="text-gray-300">Sell Signal</span>
          </div>
        </div>

        {/* Trade Statistics */}
        {statistics && !loading && !error && (
          <div className="px-4 pb-4">
            <div className="bg-[#252525] rounded-lg p-4 border border-gray-700">
              <h3 className="text-white font-semibold mb-3 text-lg">
                Trade Results
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-400">
                    {statistics.totalTrades}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">Total Trades</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-400">
                    {statistics.targetHits}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">Target Hit</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-400">
                    {statistics.slHits}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">SL Hit</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-yellow-400">
                    {statistics.openTrades}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">Open Trades</div>
                </div>
                <div className="text-center">
                  <div
                    className={`text-2xl font-bold ${
                      statistics.totalProfitPerLot >= 0
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                  >
                    {statistics.totalProfitPerLot >= 0 ? "+" : ""}
                    {statistics.totalProfitPerLot}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    Profit/Lot (₹)
                  </div>
                </div>
              </div>

              {/* Detailed Trade List */}
              {statistics.trades && statistics.trades.length > 0 && (
                <div className="mt-6">
                  <h4 className="text-white font-semibold mb-3 text-base">
                    Trade Details
                  </h4>
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-[#1e1e1e] border-b border-gray-700">
                        <tr>
                          <th className="text-left text-gray-400 font-medium py-2 px-3">
                            Entry Logic
                          </th>
                          <th className="text-right text-gray-400 font-medium py-2 px-3">
                            Entry Price
                          </th>
                          <th className="text-right text-gray-400 font-medium py-2 px-3">
                            Exit Price
                          </th>
                          <th className="text-center text-gray-400 font-medium py-2 px-3">
                            Exit Reason
                          </th>
                          <th className="text-right text-gray-400 font-medium py-2 px-3">
                            P/L
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {statistics.trades.map(
                          (trade: DetailedTrade, index: number) => (
                            <tr
                              key={index}
                              className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
                            >
                              <td className="text-gray-300 py-3 px-3 text-xs">
                                {trade.entryLogic}
                              </td>
                              <td className="text-right text-blue-400 py-3 px-3 font-mono">
                                ₹{trade.entryPrice.toFixed(2)}
                              </td>
                              <td className="text-right text-gray-300 py-3 px-3 font-mono">
                                {trade.exitPrice
                                  ? `₹${trade.exitPrice.toFixed(2)}`
                                  : "-"}
                              </td>
                              <td className="text-center py-3 px-3">
                                <span
                                  className={`px-2 py-1 rounded text-xs font-medium ${
                                    trade.exitReason === "TARGET_HIT"
                                      ? "bg-green-500/20 text-green-400"
                                      : trade.exitReason === "SL_HIT"
                                        ? "bg-red-500/20 text-red-400"
                                        : "bg-yellow-500/20 text-yellow-400"
                                  }`}
                                >
                                  {trade.exitReason === "TARGET_HIT"
                                    ? "Target"
                                    : trade.exitReason === "SL_HIT"
                                      ? "Stop Loss"
                                      : "Open"}
                                </span>
                              </td>
                              <td
                                className={`text-right py-3 px-3 font-mono font-medium ${
                                  trade.profitLoss > 0
                                    ? "text-green-400"
                                    : trade.profitLoss < 0
                                      ? "text-red-400"
                                      : "text-gray-400"
                                }`}
                              >
                                {trade.profitLoss > 0 ? "+" : ""}
                                {trade.profitLoss.toFixed(2)}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

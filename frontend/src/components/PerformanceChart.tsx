import { useEffect, useRef, useMemo } from "react";
import { createChart, type IChartApi, type ISeriesApi, AreaSeries, ColorType, LineStyle } from "lightweight-charts";

type PerformanceItem = {
  createdAt: string;
  model?: { name?: string };
  modelId?: string;
  netPortfolio: string | number;
};

type Stats = {
  totalTrades: number;
  currentValue: number;
  startingValue: number;
  pnl: number;
};

type Props = {
  data: PerformanceItem[];
  stats: Stats | null;
};

export default function PerformanceChart({ data, stats }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    const points = data
      .map((item) => ({
        time: Math.floor(new Date(item.createdAt).getTime() / 1000) as import("lightweight-charts").UTCTimestamp,
        value: Number(item.netPortfolio),
      }))
      .filter((p) => Number.isFinite(p.value))
      .sort((a, b) => (a.time as number) - (b.time as number));

    // Deduplicate by time
    const seen = new Set<number>();
    return points.filter((p) => {
      if (seen.has(p.time as number)) return false;
      seen.add(p.time as number);
      return true;
    });
  }, [data]);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0f" },
        textColor: "#6b7280",
        fontFamily: "monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1a1a24", style: LineStyle.Dotted },
        horzLines: { color: "#1a1a24", style: LineStyle.Dotted },
      },
      crosshair: {
        vertLine: { color: "#00ff8840", labelBackgroundColor: "#111118" },
        horzLine: { color: "#00ff8840", labelBackgroundColor: "#111118" },
      },
      rightPriceScale: {
        borderColor: "#2a2a35",
        scaleMargins: { top: 0.1, bottom: 0.05 },
      },
      timeScale: {
        borderColor: "#2a2a35",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScale: true,
      handleScroll: true,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#00ff88",
      lineWidth: 2,
      topColor: "rgba(0, 255, 136, 0.25)",
      bottomColor: "rgba(0, 255, 136, 0.02)",
      crosshairMarkerBackgroundColor: "#00ff88",
      crosshairMarkerBorderColor: "#00ff88",
      crosshairMarkerRadius: 4,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update data
  useEffect(() => {
    if (seriesRef.current && chartData.length > 0) {
      seriesRef.current.setData(chartData);
      chartRef.current?.timeScale().fitContent();
    }
  }, [chartData]);

  const pnlPercent =
    stats && stats.startingValue > 0
      ? ((stats.currentValue - stats.startingValue) / stats.startingValue) * 100
      : 0;
  const pnlPositive = stats ? stats.pnl >= 0 : true;

  return (
    <div className="relative flex flex-1 flex-col bg-terminal-bg min-h-0">
      <div className="px-4 pt-3 pb-1">
        <div className="text-[10px] font-bold text-terminal-muted tracking-widest mb-1">
          PORTFOLIO VALUE
        </div>
        {stats && (
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-terminal-text">
              ${stats.currentValue.toFixed(2)}
            </span>
            <span
              className={`text-sm font-semibold ${
                pnlPositive ? "text-terminal-green" : "text-terminal-red"
              }`}
            >
              {pnlPositive ? "+" : ""}{pnlPercent.toFixed(2)}%
            </span>
            <span
              className={`text-sm ${
                pnlPositive ? "text-terminal-green" : "text-terminal-red"
              }`}
            >
              ({pnlPositive ? "+$" : "-$"}{Math.abs(stats.pnl).toFixed(2)})
            </span>
          </div>
        )}
      </div>

      {chartData.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-terminal-muted text-sm">
          Waiting for data... bot runs every 2 min
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 min-h-0" />
      )}
    </div>
  );
}

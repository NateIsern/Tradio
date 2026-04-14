import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

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

const CHART_GREEN = "#00ff88";
const CHART_GREEN_DIM = "#00ff8830";

export default function PerformanceChart({ data, stats }: Props) {
  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    const points = data
      .map((item) => ({
        t: new Date(item.createdAt).getTime(),
        v: Number(item.netPortfolio),
      }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);

    if (points.length === 0) return [];

    const gaps: number[] = [];
    for (let i = 1; i < points.length; i++) {
      gaps.push(points[i].t - points[i - 1].t);
    }
    const medianGap = gaps.length
      ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
      : 60_000;
    const tolerance = Math.min(
      5 * 60_000,
      Math.max(5_000, Math.floor((medianGap || 60_000) * 1.5))
    );

    const rows: Array<{ t: number; value: number }> = [];
    let bucketStart = points[0].t;
    let bucketEnd = points[0].t;
    let bucketValues: number[] = [];

    const flush = () => {
      const center = Math.round((bucketStart + bucketEnd) / 2);
      const avg =
        bucketValues.reduce((s, v) => s + v, 0) / bucketValues.length;
      rows.push({ t: center, value: avg });
      bucketValues = [];
    };

    for (const p of points) {
      if (p.t - bucketEnd > tolerance) {
        flush();
        bucketStart = p.t;
        bucketEnd = p.t;
      }
      bucketEnd = Math.max(bucketEnd, p.t);
      bucketValues.push(p.v);
    }
    flush();

    return rows;
  }, [data]);

  const pnlPercent =
    stats && stats.startingValue > 0
      ? ((stats.currentValue - stats.startingValue) / stats.startingValue) * 100
      : 0;
  const pnlPositive = stats ? stats.pnl >= 0 : true;

  return (
    <div className="relative flex flex-col bg-terminal-bg min-h-0">
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
          Waiting for data... bot runs every 5 min
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-2 pb-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 40, bottom: 8, left: 16 }}
            >
              <defs>
                <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_GREEN} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={CHART_GREEN} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 6"
                stroke="#1a1a24"
                strokeWidth={0.5}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => {
                  const date = new Date(v);
                  return date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                }}
                tick={{
                  fontSize: 10,
                  fontFamily: "monospace",
                  fill: "#6b7280",
                }}
                stroke="#2a2a35"
                strokeWidth={1}
                axisLine={{ stroke: "#2a2a35" }}
                tickLine={{ stroke: "#2a2a35" }}
              />
              <YAxis
                tick={{
                  fontSize: 10,
                  fontFamily: "monospace",
                  fill: "#6b7280",
                }}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                domain={["auto", "auto"]}
                stroke="#2a2a35"
                strokeWidth={1}
                axisLine={{ stroke: "#2a2a35" }}
                tickLine={{ stroke: "#2a2a35" }}
              />
              <Tooltip
                labelFormatter={(label: number) =>
                  new Date(label).toLocaleString()
                }
                contentStyle={{
                  backgroundColor: "#111118",
                  border: "1px solid #2a2a35",
                  borderRadius: "4px",
                  fontFamily: "monospace",
                  fontSize: "11px",
                  color: "#e5e7eb",
                }}
                itemStyle={{ color: CHART_GREEN }}
                formatter={(value: number) => [`$${value.toFixed(2)}`, "Value"]}
              />
              <Area
                type="monotone"
                dataKey="value"
                dot={false}
                strokeWidth={2}
                stroke={CHART_GREEN}
                fill="url(#chartGradient)"
                fillOpacity={1}
                strokeLinecap="round"
                strokeLinejoin="round"
                isAnimationActive={false}
                connectNulls
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

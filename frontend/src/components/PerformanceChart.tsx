import { useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer, ReferenceLine } from "recharts";

// Map model names to specific colors
const getModelColor = (modelName: string) => {
  const lowerName = modelName.toLowerCase();

  if (lowerName.includes('claude')) {
    return '#ff6b35';  // claude - orange
  } else if (lowerName.includes('deepseek')) {
    return '#4d6bfe';  // deepseek - blue
  } else if (lowerName.includes('qwen')) {
    return '#8b5cf6';  // qwen - purple
  }

  // Fallback for unknown models
  return '#6b7280';  // gray
};

type Props = { data: any[] };

export default function PerformanceChart({ data }: Props) {
  const { chartData, seriesNames } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return { chartData: [], seriesNames: [] as string[] };
    }

    const points = data
      .map((item: any) => ({
        t: new Date(item.createdAt).getTime(),
        name: item.model?.name ?? item.modelId ?? "unknown",
        v: Number(item.netPortfolio),
      }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);

    const names = new Set<string>();
    for (const p of points) names.add(p.name);

    const uniqueTs = Array.from(new Set(points.map((p) => p.t))).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < uniqueTs.length; i++) gaps.push(uniqueTs[i] - uniqueTs[i - 1]);
    const medianGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 60_000;
    const tolerance = Math.min(5 * 60_000, Math.max(5_000, Math.floor((medianGap || 60_000) * 1.5)));

    const rows: any[] = [];
    let bucketStart = points[0].t;
    let bucketEnd = points[0].t;
    let bucketRows: Record<string, number> = {};

    const flush = () => {
      const center = Math.round((bucketStart + bucketEnd) / 2);
      rows.push({ t: center, ...bucketRows });
      bucketRows = {};
    };

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.t - bucketEnd > tolerance) {
        flush();
        bucketStart = p.t;
        bucketEnd = p.t;
      }
      bucketEnd = Math.max(bucketEnd, p.t);
      bucketRows[p.name] = p.v;
    }
    flush();

    return { chartData: rows, seriesNames: Array.from(names.values()) };
  }, [data]);

  return (
    <div className="relative w-full flex flex-1 border-r-2 border-black" style={{ minHeight: 300 }}>
      {/* Title */}
      <div className="absolute left-1/2 top-2 -translate-x-1/2 z-10">
        <h2 className="text-sm font-bold text-black font-mono">TOTAL ACCOUNT VALUE</h2>
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center w-full h-full text-gray-400 font-mono text-sm">
          Waiting for data... bot runs every 5 min
        </div>
      ) : (
      <ResponsiveContainer width="100%" height="100%" minHeight={300}>
        <LineChart
          data={chartData}
          margin={{ top: 40, right: 80, bottom: 0, left: 20 }}
        >
          <CartesianGrid
            strokeDasharray="1,3"
            stroke="rgba(0, 0, 0, 0.1)"
            strokeWidth={0.5}
          />

          <XAxis
            dataKey="t"
            type="number"
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => {
              const date = new Date(v);
              return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            }}
            tick={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600, fill: 'rgba(0, 0, 0, 0.8)' }}
            stroke="rgba(0, 0, 0, 0.4)"
            strokeWidth={1.5}
          />

          <YAxis
            tick={{ fontSize: 12, fontFamily: 'Courier New, monospace', fontWeight: 600, fill: 'rgba(0, 0, 0, 0.8)' }}
            tickFormatter={(v: number) => `$${v.toLocaleString()}`}
            domain={['auto', 'auto']}
            stroke="rgba(0, 0, 0, 0.4)"
            strokeWidth={1.5}
          />

          <Tooltip
            labelFormatter={(label: any) => new Date(label).toLocaleString()}
            contentStyle={{
              backgroundColor: 'white',
              border: '2px solid black',
              fontFamily: 'monospace',
              fontSize: '12px'
            }}
          />

          <Legend
            wrapperStyle={{
              fontFamily: 'monospace',
              fontSize: '12px'
            }}
          />

          <ReferenceLine
            y={1000}
            stroke="rgba(0, 0, 0, 0.3)"
            strokeWidth={2}
            strokeDasharray="5 5"
          />

          {seriesNames.map((name) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              dot={false}
              strokeWidth={2}
              stroke={getModelColor(name)}
              strokeLinecap="round"
              strokeLinejoin="round"
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      )}
    </div>
  );
}

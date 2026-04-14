import { useEffect, useState, useCallback } from "react";
import PerformanceChart from "./components/PerformanceChart";
import RecentInvocations from "./components/RecentInvocations";
import PositionsPanel from "./components/PositionsPanel";
import Navbar from "./components/Navbar";
import StatusBar from "./components/StatusBar";

const BACKEND_URL = "http://localhost:3000";
const POLL_INTERVAL = 30_000;

type PerformanceItem = {
  createdAt: string;
  model?: { name?: string };
  modelId?: string;
  netPortfolio: string | number;
};

type Invocation = {
  id: string;
  response: string;
  createdAt: string | Date;
  model?: { name?: string };
  toolCalls?: {
    toolCallType: string;
    metadata: string;
    createdAt: string | Date;
  }[];
};

type Position = {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
};

type Stats = {
  totalTrades: number;
  currentValue: number;
  startingValue: number;
  pnl: number;
};

function ChartSkeleton() {
  return (
    <div className="flex flex-1 flex-col border-r border-terminal-border bg-terminal-bg">
      <div className="px-4 pt-3 pb-1">
        <div className="h-3 w-32 rounded bg-terminal-panel animate-pulse" />
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full h-full rounded bg-terminal-panel animate-pulse" />
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex w-[360px] flex-col bg-terminal-bg">
      <div className="p-4 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-terminal-panel animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [performanceData, setPerformanceData] = useState<
    PerformanceItem[] | null
  >(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [invocationsData, setInvocationsData] = useState<
    Invocation[] | null
  >(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [perfRes, invocRes, posRes, statsRes] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/performance`),
        fetch(`${BACKEND_URL}/invocations?limit=30`),
        fetch(`${BACKEND_URL}/positions`),
        fetch(`${BACKEND_URL}/stats`),
      ]);

      if (perfRes.status === "fulfilled" && perfRes.value.ok) {
        const perfData = await perfRes.value.json();
        setPerformanceData(perfData.data);
        setLastUpdated(
          perfData.lastUpdated ? new Date(perfData.lastUpdated) : new Date()
        );
      }

      if (invocRes.status === "fulfilled" && invocRes.value.ok) {
        const invocData = await invocRes.value.json();
        setInvocationsData(invocData.data);
      }

      if (posRes.status === "fulfilled" && posRes.value.ok) {
        const posData = await posRes.value.json();
        setPositions(posData.data ?? []);
      }

      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        const statsData = await statsRes.value.json();
        setStats(statsData);
      }
    } catch (err) {
      console.error("Error fetching data:", err);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const loading = !performanceData || !invocationsData;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-terminal-bg text-terminal-text font-mono">
      <Navbar />
      <div className="flex min-h-0 flex-1">
        {loading ? (
          <>
            <ChartSkeleton />
            <PanelSkeleton />
          </>
        ) : (
          <>
            <PerformanceChart data={performanceData} />
            <div className="flex w-[360px] shrink-0 flex-col bg-terminal-bg border-l border-terminal-border overflow-hidden">
              <PositionsPanel positions={positions} />
              <RecentInvocations data={invocationsData} />
            </div>
          </>
        )}
      </div>
      <StatusBar
        lastUpdated={lastUpdated}
        totalTrades={stats?.totalTrades ?? 0}
      />
    </div>
  );
}

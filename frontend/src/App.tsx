import { useEffect, useState, useCallback } from "react";
import PerformanceChart from "./components/PerformanceChart";
import ChatPanel from "./components/ChatPanel";
import PositionsPanel from "./components/PositionsPanel";
import Watchlist from "./components/Watchlist";
import Navbar from "./components/Navbar";
import StatusBar from "./components/StatusBar";
import SearchBar from "./components/SearchBar";

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

type MarketPrice = {
  price: number;
  change24h: number;
};

export default function App() {
  const [performanceData, setPerformanceData] = useState<PerformanceItem[] | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [invocationsData, setInvocationsData] = useState<Invocation[] | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [prices, setPrices] = useState<Record<string, MarketPrice>>({});

  const fetchAll = useCallback(async () => {
    try {
      const [perfRes, invocRes, posRes, statsRes, pricesRes] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/performance`),
        fetch(`${BACKEND_URL}/invocations?limit=30`),
        fetch(`${BACKEND_URL}/positions`),
        fetch(`${BACKEND_URL}/stats`),
        fetch(`${BACKEND_URL}/market-prices`),
      ]);

      if (perfRes.status === "fulfilled" && perfRes.value.ok) {
        const d = await perfRes.value.json();
        setPerformanceData(d.data);
        setLastUpdated(d.lastUpdated ? new Date(d.lastUpdated) : new Date());
      }
      if (invocRes.status === "fulfilled" && invocRes.value.ok) {
        const d = await invocRes.value.json();
        setInvocationsData(d.data);
      }
      if (posRes.status === "fulfilled" && posRes.value.ok) {
        const d = await posRes.value.json();
        setPositions(d.data ?? []);
      }
      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        setStats(await statsRes.value.json());
      }
      if (pricesRes.status === "fulfilled" && pricesRes.value.ok) {
        const d = await pricesRes.value.json();
        setPrices(d.prices ?? {});
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
      {/* Top ticker bar */}
      <Navbar prices={prices} stats={stats} />

      {/* Main content: Watchlist | Chart+Positions | Chat */}
      <div className="flex min-h-0 flex-1">
        {/* Left: Watchlist */}
        <div className="w-[140px] shrink-0">
          <Watchlist prices={prices} />
        </div>

        {/* Center: Chart + Positions */}
        <div className="flex flex-1 flex-col min-w-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-terminal-subtle text-xs animate-pulse">
              Loading dashboard...
            </div>
          ) : (
            <>
              <PerformanceChart data={performanceData} stats={stats} />
              <PositionsPanel positions={positions} />
            </>
          )}
        </div>

        {/* Right: AI Chat Panel */}
        <div className="w-[400px] shrink-0 border-l border-terminal-border">
          <ChatPanel data={invocationsData} />
        </div>
      </div>

      {/* Bottom status bar */}
      <StatusBar lastUpdated={lastUpdated} totalTrades={stats?.totalTrades ?? 0} />

      {/* Floating search */}
      <SearchBar prices={prices} />
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import PerformanceChart from "./components/PerformanceChart";
import RightPanel from "./components/RightPanel";
import PositionsPanel from "./components/PositionsPanel";
import Watchlist from "./components/Watchlist";
import Navbar from "./components/Navbar";
import StatusBar from "./components/StatusBar";
import SearchBar from "./components/SearchBar";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";
// Slow-changing stuff (P&L history, invocation list, stats) still polls at a
// leisurely cadence. Positions + prices now come over SSE /stream, so the
// watchlist and positions panel update in near-realtime without spamming
// Lighter.
const SLOW_POLL_INTERVAL = 90_000;

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

  const fetchSlow = useCallback(async () => {
    try {
      const [perfRes, invocRes, statsRes] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/performance`),
        fetch(`${BACKEND_URL}/invocations?limit=30`),
        fetch(`${BACKEND_URL}/stats`),
      ]);

      if (perfRes.status === "fulfilled" && perfRes.value.ok) {
        const d = (await perfRes.value.json()) as {
          data: PerformanceItem[];
          lastUpdated?: string;
        };
        setPerformanceData(d.data);
        setLastUpdated(d.lastUpdated ? new Date(d.lastUpdated) : new Date());
      }
      if (invocRes.status === "fulfilled" && invocRes.value.ok) {
        const d = (await invocRes.value.json()) as { data: Invocation[] };
        setInvocationsData(d.data);
      }
      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        setStats((await statsRes.value.json()) as Stats);
      }
    } catch (err) {
      console.error("Error fetching slow data:", err);
    }
  }, []);

  useEffect(() => {
    fetchSlow();
    const interval = setInterval(fetchSlow, SLOW_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchSlow]);

  // Realtime stream for positions + market prices. A single EventSource
  // replaces the old 30s poll and pushes a snapshot whenever the backend
  // cache changes (~every 3s). If the connection drops, the browser's
  // native retry kicks in automatically.
  useEffect(() => {
    const source = new EventSource(`${BACKEND_URL}/stream`);
    const handler = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as {
          positions?: Position[];
          marketPrices?: Record<string, MarketPrice>;
        };
        if (Array.isArray(snapshot.positions)) {
          setPositions(snapshot.positions);
        }
        if (snapshot.marketPrices) {
          setPrices(snapshot.marketPrices);
        }
        setLastUpdated(new Date());
      } catch (err) {
        console.error("stream parse error:", err);
      }
    };
    source.addEventListener("snapshot", handler);
    return () => {
      source.removeEventListener("snapshot", handler);
      source.close();
    };
  }, []);

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
          <RightPanel invocationsData={invocationsData} backendUrl={BACKEND_URL} />
        </div>
      </div>

      {/* Bottom status bar */}
      <StatusBar lastUpdated={lastUpdated} totalTrades={stats?.totalTrades ?? 0} />

      {/* Floating search */}
      <SearchBar prices={prices} />
    </div>
  );
}

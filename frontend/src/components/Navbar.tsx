import { useEffect, useState, useCallback } from "react";

const BACKEND_URL = "http://localhost:3000";

type Stats = {
  totalTrades: number;
  currentValue: number;
  startingValue: number;
  pnl: number;
};

export default function Navbar() {
  const [stats, setStats] = useState<Stats | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/stats`);
      const data: Stats = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to fetch stats:", err);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const pnlPositive = stats ? stats.pnl >= 0 : true;

  return (
    <nav className="border-b border-terminal-border bg-terminal-surface">
      <div className="flex h-12 items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tracking-wider text-terminal-green">
            TRADIO
          </span>
          <span className="h-4 w-px bg-terminal-border" />
          <span className="text-xs text-terminal-muted">LIVE</span>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-terminal-green opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-terminal-green" />
          </span>
        </div>

        {stats && (
          <div className="flex items-center gap-6 font-mono text-sm">
            <div className="flex items-center gap-2">
              <span className="text-terminal-muted text-xs">PORTFOLIO</span>
              <span className="text-terminal-text font-semibold">
                ${stats.currentValue.toFixed(2)}
              </span>
            </div>
            <span className="h-4 w-px bg-terminal-border" />
            <div className="flex items-center gap-2">
              <span className="text-terminal-muted text-xs">P&L</span>
              <span
                className={`font-semibold ${pnlPositive ? "text-terminal-green" : "text-terminal-red"}`}
              >
                {pnlPositive ? "+" : ""}${stats.pnl.toFixed(2)}
              </span>
            </div>
            <span className="h-4 w-px bg-terminal-border" />
            <div className="flex items-center gap-2">
              <span className="text-terminal-muted text-xs">TRADES</span>
              <span className="text-terminal-text font-semibold">
                {stats.totalTrades}
              </span>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}

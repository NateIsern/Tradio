import { useState, useEffect, useCallback } from "react";

const CYCLE_INTERVAL_MS = 5 * 60 * 1000;

type Props = {
  lastUpdated: Date | null;
  totalTrades: number;
};

export default function StatusBar({ lastUpdated, totalTrades }: Props) {
  const computeCountdown = useCallback((): string => {
    if (!lastUpdated) return "--:--";
    const nextCycle = new Date(lastUpdated.getTime() + CYCLE_INTERVAL_MS);
    const remaining = nextCycle.getTime() - Date.now();
    if (remaining <= 0) return "0:00";
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, [lastUpdated]);

  const [countdown, setCountdown] = useState(() => computeCountdown());

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(computeCountdown());
    }, 1000);
    return () => clearInterval(interval);
  }, [computeCountdown]);

  const lastCycleStr = lastUpdated
    ? lastUpdated.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "--:--";

  return (
    <div className="flex items-center justify-between border-t border-terminal-border bg-terminal-surface px-4 py-1.5 shrink-0">
      <div className="flex items-center gap-5 text-[10px] font-mono">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-terminal-green opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-terminal-green" />
          </span>
          <span className="text-terminal-green font-bold">LIVE</span>
        </div>
        <span className="text-terminal-border">|</span>
        <div className="flex items-center gap-1.5">
          <span className="text-terminal-subtle">Last</span>
          <span className="text-terminal-text">{lastCycleStr}</span>
        </div>
        <span className="text-terminal-border">|</span>
        <div className="flex items-center gap-1.5">
          <span className="text-terminal-subtle">Next cycle</span>
          <span className="text-terminal-green">{countdown}</span>
        </div>
        <span className="text-terminal-border">|</span>
        <div className="flex items-center gap-1.5">
          <span className="text-terminal-subtle">Trades</span>
          <span className="text-terminal-text">{totalTrades}</span>
        </div>
      </div>
      <div className="text-[9px] text-terminal-subtle">
        AUTO-REFRESH 30s
      </div>
    </div>
  );
}

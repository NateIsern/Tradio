type MarketPrice = {
  price: number;
  change24h: number;
};

type Stats = {
  totalTrades: number;
  currentValue: number;
  startingValue: number;
  pnl: number;
};

type Props = {
  prices?: Record<string, MarketPrice>;
  stats?: Stats | null;
};

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export default function Navbar({ prices, stats }: Props) {
  const entries = Object.entries(prices ?? {});

  return (
    <nav className="border-b border-terminal-border bg-terminal-surface">
      <div className="flex h-10 items-center px-4 gap-4">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-bold tracking-wider text-terminal-green">
            TRADIO
          </span>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-terminal-green opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-terminal-green" />
          </span>
        </div>

        <span className="h-4 w-px bg-terminal-border shrink-0" />

        <div className="flex items-center gap-4 overflow-x-auto min-w-0 flex-1 scrollbar-hide">
          {entries.map(([symbol, data]) => {
            const isPositive = data.change24h >= 0;
            return (
              <div key={symbol} className="flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] font-bold text-terminal-text">
                  {symbol}
                </span>
                <span className="text-[11px] text-terminal-muted">
                  ${formatPrice(data.price)}
                </span>
                <span
                  className={`text-[10px] font-medium ${
                    isPositive ? "text-terminal-green" : "text-terminal-red"
                  }`}
                >
                  {isPositive ? "+" : ""}{data.change24h.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>

        {stats && (
          <>
            <span className="h-4 w-px bg-terminal-border shrink-0" />
            <div className="flex items-center gap-4 shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-terminal-muted">PORTFOLIO</span>
                <span className="text-[11px] font-semibold text-terminal-text">
                  ${stats.currentValue.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-terminal-muted">P&L</span>
                <span
                  className={`text-[11px] font-semibold ${
                    stats.pnl >= 0 ? "text-terminal-green" : "text-terminal-red"
                  }`}
                >
                  {stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </nav>
  );
}

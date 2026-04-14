type MarketPrice = {
  price: number;
  change24h: number;
};

type Props = {
  prices: Record<string, MarketPrice>;
};

function formatPrice(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

export default function Watchlist({ prices }: Props) {
  const entries = Object.entries(prices);

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col border-r border-terminal-border bg-terminal-surface">
        <div className="px-3 py-2.5 border-b border-terminal-border">
          <h3 className="text-[10px] font-bold text-terminal-muted tracking-widest">
            WATCHLIST
          </h3>
        </div>
        <div className="flex flex-1 items-center justify-center text-terminal-subtle text-[10px]">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-r border-terminal-border bg-terminal-surface">
      <div className="px-3 py-2.5 border-b border-terminal-border">
        <h3 className="text-[10px] font-bold text-terminal-muted tracking-widest">
          WATCHLIST
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.map(([symbol, data]) => {
          const isPositive = data.change24h >= 0;
          return (
            <div
              key={symbol}
              className="px-3 py-2.5 border-b border-terminal-border hover:bg-terminal-panel/50 transition-colors cursor-default"
            >
              <div className="text-xs font-bold text-terminal-text">
                {symbol}
              </div>
              <div className="text-sm font-semibold text-terminal-text mt-0.5">
                {formatPrice(data.price)}
              </div>
              <div
                className={`text-[10px] font-medium mt-0.5 ${
                  isPositive ? "text-terminal-green" : "text-terminal-red"
                }`}
              >
                {isPositive ? "+" : ""}{data.change24h.toFixed(2)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

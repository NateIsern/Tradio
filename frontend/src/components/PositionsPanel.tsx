type Position = {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
};

type Props = {
  positions: Position[];
};

export default function PositionsPanel({ positions }: Props) {
  return (
    <div className="flex flex-col border-b border-terminal-border">
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-border bg-terminal-surface">
        <h3 className="text-xs font-bold text-terminal-muted tracking-widest">
          OPEN POSITIONS
        </h3>
        <span className="text-xs text-terminal-subtle">
          {positions.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-terminal-subtle text-xs">
            No open positions
          </div>
        ) : (
          <div className="divide-y divide-terminal-border">
            {positions.map((pos, idx) => {
              const isLong = pos.side === "LONG";
              const pnlPositive = pos.unrealizedPnl >= 0;
              const pnlPercent =
                pos.entryPrice > 0
                  ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice) *
                    100 *
                    (isLong ? 1 : -1)
                  : 0;

              return (
                <div
                  key={`${pos.symbol}-${idx}`}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-terminal-panel/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        isLong
                          ? "bg-terminal-green/15 text-terminal-green"
                          : "bg-terminal-red/15 text-terminal-red"
                      }`}
                    >
                      {pos.side}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-terminal-text">
                        {pos.symbol}
                      </div>
                      <div className="text-[10px] text-terminal-subtle">
                        ${pos.entryPrice.toFixed(2)} entry
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-terminal-text">
                      ${(pos.size * pos.markPrice).toFixed(2)}
                    </div>
                    <div
                      className={`text-[10px] font-medium ${
                        pnlPositive
                          ? "text-terminal-green"
                          : "text-terminal-red"
                      }`}
                    >
                      {pnlPositive ? "+" : ""}
                      {pos.unrealizedPnl.toFixed(2)} ({pnlPercent >= 0 ? "+" : ""}
                      {pnlPercent.toFixed(1)}%)
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

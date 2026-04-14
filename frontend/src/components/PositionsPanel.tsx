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
    <div className="flex flex-col min-h-0 border-t border-terminal-border">
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
        <h3 className="text-[10px] font-bold text-terminal-muted tracking-widest">
          POSITIONS
        </h3>
        <span className="text-[10px] text-terminal-subtle">
          {positions.length} open
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-terminal-subtle text-[10px]">
            No open positions
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] text-terminal-muted bg-terminal-panel/50">
                <th className="py-1.5 pl-4 pr-2 font-medium">Symbol</th>
                <th className="py-1.5 px-2 font-medium">Side</th>
                <th className="py-1.5 px-2 font-medium text-right">Size</th>
                <th className="py-1.5 px-2 font-medium text-right">Entry</th>
                <th className="py-1.5 px-2 font-medium text-right">Mark</th>
                <th className="py-1.5 px-2 font-medium text-right">P&L</th>
                <th className="py-1.5 pl-2 pr-4 font-medium text-right">P&L %</th>
              </tr>
            </thead>
            <tbody>
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
                  <tr
                    key={`${pos.symbol}-${idx}`}
                    className="border-b border-terminal-border/50 hover:bg-terminal-panel/30 transition-colors"
                  >
                    <td className="py-2 pl-4 pr-2 font-semibold text-terminal-text">
                      {pos.symbol}
                    </td>
                    <td className="py-2 px-2">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold ${
                          isLong
                            ? "bg-terminal-green/15 text-terminal-green"
                            : "bg-terminal-red/15 text-terminal-red"
                        }`}
                      >
                        {pos.side}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right text-terminal-text tabular-nums">
                      {pos.size < 1
                        ? pos.size.toPrecision(3)
                        : pos.size.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-terminal-muted tabular-nums">
                      ${pos.entryPrice < 1 ? pos.entryPrice.toPrecision(4) : pos.entryPrice.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-terminal-text tabular-nums">
                      ${pos.markPrice < 1 ? pos.markPrice.toPrecision(4) : pos.markPrice.toFixed(2)}
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-medium tabular-nums ${
                        pnlPositive ? "text-terminal-green" : "text-terminal-red"
                      }`}
                    >
                      {pnlPositive ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                    </td>
                    <td
                      className={`py-2 pl-2 pr-4 text-right font-medium tabular-nums ${
                        pnlPositive ? "text-terminal-green" : "text-terminal-red"
                      }`}
                    >
                      {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

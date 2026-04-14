import { useState, useRef, useEffect, useMemo } from "react";

type MarketPrice = {
  price: number;
  change24h: number;
};

type Props = {
  prices: Record<string, MarketPrice>;
};

type Result = {
  symbol: string;
  price: number;
  change24h: number;
};

export default function SearchBar({ prices }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+K to toggle
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
    }
  }, [open]);

  const results: Result[] = useMemo(() => {
    const all = Object.entries(prices ?? {}).map(([symbol, data]) => ({
      symbol,
      price: data.price,
      change24h: data.change24h,
    }));

    if (!query.trim()) return all.slice(0, 8);

    const q = query.toLowerCase();
    return all.filter((r) => r.symbol.toLowerCase().includes(q));
  }, [prices, query]);

  function formatPrice(p: number): string {
    if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (p >= 1) return `$${p.toFixed(2)}`;
    return `$${p.toFixed(4)}`;
  }

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-2xl border border-terminal-border bg-terminal-surface/95 backdrop-blur-md px-5 py-2.5 shadow-lg shadow-black/40 hover:border-terminal-green/40 hover:bg-terminal-panel transition-all cursor-text group"
      >
        <svg className="w-4 h-4 text-terminal-subtle group-hover:text-terminal-green transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="text-xs text-terminal-subtle group-hover:text-terminal-muted transition-colors">
          Search stocks, crypto, forex...
        </span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-terminal-border bg-terminal-bg px-1.5 py-0.5 text-[9px] text-terminal-subtle">
          <span>Ctrl</span><span>K</span>
        </kbd>
      </button>

      {/* Overlay + Search modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center pb-8"
          onClick={() => setOpen(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Search panel */}
          <div
            className="relative w-full max-w-[600px] rounded-2xl border border-terminal-border bg-terminal-surface shadow-2xl shadow-black/60 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Input */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-terminal-border">
              <svg className="w-5 h-5 text-terminal-green shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search stocks, crypto, forex..."
                className="flex-1 bg-transparent text-sm text-terminal-text placeholder-terminal-subtle outline-none"
              />
              <kbd
                onClick={() => setOpen(false)}
                className="cursor-pointer rounded border border-terminal-border bg-terminal-bg px-2 py-0.5 text-[10px] text-terminal-subtle hover:text-terminal-text transition-colors"
              >
                ESC
              </kbd>
            </div>

            {/* Results */}
            <div className="max-h-[360px] overflow-y-auto">
              {results.length === 0 ? (
                <div className="px-5 py-8 text-center text-terminal-subtle text-xs">
                  No results for "{query}"
                </div>
              ) : (
                results.map((r) => {
                  const isPositive = r.change24h >= 0;
                  return (
                    <div
                      key={r.symbol}
                      className="flex items-center justify-between px-5 py-3 hover:bg-terminal-panel/50 transition-colors cursor-default border-b border-terminal-border/30"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-[10px] font-bold ${
                          isPositive ? "bg-terminal-green/10 text-terminal-green" : "bg-terminal-red/10 text-terminal-red"
                        }`}>
                          {r.symbol.slice(0, 3)}
                        </div>
                        <div>
                          <div className="text-sm font-bold text-terminal-text">{r.symbol}</div>
                          <div className="text-[10px] text-terminal-subtle">Lighter DEX</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-terminal-text tabular-nums">
                          {formatPrice(r.price)}
                        </div>
                        <div className={`text-[11px] font-medium tabular-nums ${
                          isPositive ? "text-terminal-green" : "text-terminal-red"
                        }`}>
                          {isPositive ? "+" : ""}{r.change24h.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

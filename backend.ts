import express from "express";
import { PrismaClient, type PortfolioSize } from "./generated/prisma/client";
import cors from "cors";
import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";
import { MARKETS } from "./markets";
import { getIndicators } from "./stockData";

const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
let timeseriesDataGlobal: PortfolioSize[] = [];
let lastUpdatedGlobal: Date | null = null;
let invocationsCacheGlobal: any[] = [];
let invocationsLastUpdatedGlobal: Date | null = null;
let invocationsRefreshInFlight = false;

async function refreshInvocations(take: number) {
  if (invocationsRefreshInFlight) return;
  invocationsRefreshInFlight = true;
  try {
    const safeTake = Math.min(Math.max(take || 30, 1), 200);
    const invocations = await prisma.invocations.findMany({
      orderBy: { createdAt: "desc" },
      take: safeTake,
      include: {
        model: { select: { name: true } },
        toolCalls: {
          select: { toolCallType: true, metadata: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    invocationsCacheGlobal = invocations;
    invocationsLastUpdatedGlobal = new Date();
  } catch (err) {
    console.error("Error refreshing invocations:", err);
  } finally {
    invocationsRefreshInFlight = false;
  }
}

app.get("/performance", async (req, res) => {
  if (lastUpdatedGlobal && lastUpdatedGlobal.getTime() + 1000 * 60 * 5 > Date.now()) {
    res.json({data: timeseriesDataGlobal, lastUpdated: lastUpdatedGlobal});
    return;
  }
  const timeseriesData = await prisma.portfolioSize.findMany({
    orderBy: {
      createdAt: "asc",
    },
    include: {
      model: {
        select: { name: true },
      },
    },
  });
  timeseriesDataGlobal = timeseriesData;
  lastUpdatedGlobal = new Date();
  res.json({data: timeseriesDataGlobal, lastUpdated: lastUpdatedGlobal});
});

app.get("/invocations", async (req, res) => {
  const limitParam = Number(req.query.limit);
  const take = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 30;
  const now = Date.now();
  const isFresh = invocationsLastUpdatedGlobal && invocationsLastUpdatedGlobal.getTime() + 1000 * 60 * 2 > now;

  if (!invocationsCacheGlobal.length) {
    await refreshInvocations(take);
    res.json({ data: invocationsCacheGlobal.slice(0, take), lastUpdated: invocationsLastUpdatedGlobal });
    return;
  }

  res.json({ data: invocationsCacheGlobal.slice(0, take), lastUpdated: invocationsLastUpdatedGlobal, stale: !isFresh });

  if (!isFresh && !invocationsRefreshInFlight) {
    void refreshInvocations(take);
  }
});

app.get("/positions", async (_req, res) => {
  try {
    const token = getAuthToken();
    const accountIndex = process.env.ACCOUNT_INDEX ?? "0";
    const url = `${BASE_URL}/api/v1/account?by=index&value=${accountIndex}`;
    const raw = fetchH2(url, token);
    const account = JSON.parse(raw);
    const positions: Array<{
      symbol: string;
      side: "LONG" | "SHORT";
      size: number;
      entryPrice: number;
      markPrice: number;
      unrealizedPnl: number;
      liquidationPrice: number;
    }> = [];

    const acct = account.accounts?.[0];
    const markPrices = fetchLiveMarkPrices();

    if (acct?.positions && Array.isArray(acct.positions)) {
      for (const pos of acct.positions) {
        const size = Number(pos.position ?? pos.size ?? 0);
        if (size === 0) continue;
        const side =
          pos.sign === 1 || pos.sign === "1"
            ? ("LONG" as const)
            : ("SHORT" as const);
        const symbol = pos.symbol ?? "?";
        positions.push({
          symbol,
          side,
          size: Math.abs(size),
          entryPrice: Number(pos.avg_entry_price ?? 0),
          markPrice: markPrices[symbol] ?? 0,
          unrealizedPnl: Number(pos.unrealized_pnl ?? 0),
          liquidationPrice: Number(pos.liquidation_price ?? 0),
        });
      }
    }

    res.json({ data: positions });
  } catch (err) {
    console.error("Error fetching positions:", err);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

app.get("/stats", async (_req, res) => {
  try {
    const totalTrades = await prisma.invocations.count({
      where: {
        toolCalls: {
          some: {},
        },
      },
    });

    const latest = await prisma.portfolioSize.findFirst({
      orderBy: { createdAt: "desc" },
    });

    const first = await prisma.portfolioSize.findFirst({
      orderBy: { createdAt: "asc" },
    });

    const currentValue = latest ? Number(latest.netPortfolio) : 0;
    const startingValue = first ? Number(first.netPortfolio) : 0;
    const pnl = currentValue - startingValue;

    res.json({
      totalTrades,
      currentValue,
      startingValue,
      pnl,
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

type MarketPriceEntry = {
  price: number;
  change24h: number;
};

let marketPricesCache: Record<string, MarketPriceEntry> = {};
let marketPricesLastUpdated: Date | null = null;
let marketPricesRefreshInFlight = false;

async function refreshMarketPrices() {
  if (marketPricesRefreshInFlight) return;
  marketPricesRefreshInFlight = true;
  try {
    const token = getAuthToken();
    const results: Record<string, MarketPriceEntry> = {};

    const now = Date.now();
    for (const [symbol, market] of Object.entries(MARKETS)) {
      try {
        const url = `${BASE_URL}/api/v1/candles?market_id=${market.marketId}&resolution=1h&start_timestamp=${now - 86400000}&end_timestamp=${now}&count_back=25`;
        const raw = fetchH2(url, token);
        const data = JSON.parse(raw) as { c?: Array<{ o: number; c: number; h: number; l: number }> };
        const candles = data.c;

        if (candles && candles.length > 0) {
          const latest = candles[candles.length - 1];
          const currentPrice = latest.c;
          let change24h = 0;
          if (candles.length >= 2) {
            const oldPrice = candles[0].c;
            if (oldPrice > 0) {
              change24h = ((currentPrice - oldPrice) / oldPrice) * 100;
            }
          }
          results[symbol] = { price: currentPrice, change24h };
        }
      } catch (err) {
        // skip failed markets silently
      }
    }

    marketPricesCache = results;
    marketPricesLastUpdated = new Date();
  } catch (err) {
    console.error("Error refreshing market prices:", err);
  } finally {
    marketPricesRefreshInFlight = false;
  }
}

app.get("/market-prices", async (_req, res) => {
  const now = Date.now();
  const isFresh = marketPricesLastUpdated && marketPricesLastUpdated.getTime() + 1000 * 60 * 2 > now;

  if (Object.keys(marketPricesCache).length === 0) {
    await refreshMarketPrices();
    res.json({ prices: marketPricesCache, lastUpdated: marketPricesLastUpdated });
    return;
  }

  res.json({ prices: marketPricesCache, lastUpdated: marketPricesLastUpdated, stale: !isFresh });

  if (!isFresh && !marketPricesRefreshInFlight) {
    void refreshMarketPrices();
  }
});

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

const CHAT_SYSTEM_PROMPT = [
  "You are Tradio, an elite autonomous crypto trading assistant managing Nate's portfolio on Lighter DEX.",
  "In this conversational mode you answer Nate's questions about markets, strategy, indicators, and current positions.",
  "You are read-only here: do NOT execute trades, you only analyze and recommend. Trades are executed by the autonomous loop.",
  "Be concise, direct, and numbers-driven. Use Markdown for structure.",
].join("\n");

async function streamDOChat(
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken: (token: string) => void,
): Promise<void> {
  const response = await fetch("https://inference.do-ai.run/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env["DO_MODEL_ACCESS_KEY"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_completion_tokens: 2048, stream: true }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`DO API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nlIdx: number;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          error?: { message: string };
        };
        if (json.error) throw new Error(json.error.message);
        const token = json.choices?.[0]?.delta?.content;
        if (token) onToken(token);
      } catch (err) {
        if ((err as Error).message?.startsWith("Unexpected")) continue;
        throw err;
      }
    }
  }
}

type EnrichedPosition = {
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  unrealizedPnl: number;
  realizedPnl: number;
  liquidationPrice: number;
  entryPrice?: number;
  entryTime?: string;
  entryAmount?: number;
  markPrice?: number;
};

function fetchLiveMarkPrices(): Record<string, number> {
  const out: Record<string, number> = {};
  const token = getAuthToken();
  const now = Date.now();
  for (const [symbol, market] of Object.entries(MARKETS)) {
    try {
      const url = `${BASE_URL}/api/v1/candles?market_id=${market.marketId}&resolution=1m&start_timestamp=${now - 300000}&end_timestamp=${now}&count_back=1`;
      const raw = fetchH2(url, token);
      const data = JSON.parse(raw) as { c?: Array<{ c: number }> };
      const last = data.c?.[data.c.length - 1]?.c;
      if (typeof last === "number") out[symbol] = last;
    } catch {
      // ignore
    }
  }
  return out;
}

function fetchHistoricalPrice(marketId: number, timestampMs: number): number | null {
  const token = getAuthToken();
  const start = timestampMs - 5 * 60 * 1000;
  const end = timestampMs + 5 * 60 * 1000;
  try {
    const url = `${BASE_URL}/api/v1/candles?market_id=${marketId}&resolution=1m&start_timestamp=${start}&end_timestamp=${end}&count_back=2`;
    const raw = fetchH2(url, token);
    const data = JSON.parse(raw) as { c?: Array<{ o: number; c: number }> };
    const candle = data.c?.[0];
    if (!candle) return null;
    return Number(((candle.o + candle.c) / 2).toFixed(6));
  } catch {
    return null;
  }
}

async function buildLiveContext(modelId: string): Promise<string> {
  const lines: string[] = [];

  let portfolioTotal = "0";
  let portfolioAvailable = "0";
  const livePositions: EnrichedPosition[] = [];

  try {
    const token = getAuthToken();
    const accountIndex = process.env.ACCOUNT_INDEX ?? "0";
    const url = `${BASE_URL}/api/v1/account?by=index&value=${accountIndex}`;
    const raw = fetchH2(url, token);
    const account = JSON.parse(raw) as {
      accounts?: Array<{
        collateral?: string;
        available_balance?: string;
        positions?: Array<Record<string, unknown>>;
      }>;
    };
    const acct = account.accounts?.[0];
    if (acct) {
      portfolioTotal = acct.collateral ?? "0";
      portfolioAvailable = acct.available_balance ?? "0";
      for (const p of acct.positions ?? []) {
        const size = Number(p.position ?? 0);
        if (size === 0) continue;
        const sign = p.sign;
        const side: "LONG" | "SHORT" =
          sign === 1 || sign === "1" ? "LONG" : "SHORT";
        const entryFromApi = Number(p["avg_entry_price"] ?? 0);
        livePositions.push({
          symbol: String(p.symbol ?? ""),
          side,
          size: Math.abs(size),
          entryPrice: entryFromApi > 0 ? entryFromApi : undefined,
          unrealizedPnl: Number(
            p["unrealized_pnl"] ?? p.unrealizedPnl ?? 0,
          ),
          realizedPnl: Number(
            p["realized_pnl"] ?? p.realizedPnl ?? 0,
          ),
          liquidationPrice: Number(
            p["liquidation_price"] ?? p.liquidationPrice ?? 0,
          ),
        });
      }
    }
  } catch (err) {
    console.error("buildLiveContext account error:", (err as Error).message);
  }

  // Pull recent tool calls to figure out entry prices, amounts, and timestamps
  const recentToolCalls = await prisma.toolCalls.findMany({
    where: {
      invocation: { modelId },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { invocation: { select: { response: true, createdAt: true } } },
  });

  const entryByFirstSeen = new Map<string, { price: number; ts: Date; amount: number }>();
  for (let i = recentToolCalls.length - 1; i >= 0; i--) {
    const tc = recentToolCalls[i];
    if (!tc || tc.toolCallType !== "CREATE_POSITION") continue;
    try {
      const meta = JSON.parse(tc.metadata) as {
        symbol?: string;
        side?: string;
        amount?: number;
        quantity?: number;
        price?: number;
      };
      if (!meta.symbol) continue;
      if (!entryByFirstSeen.has(meta.symbol)) {
        entryByFirstSeen.set(meta.symbol, {
          price: Number(meta.price ?? 0),
          ts: tc.createdAt,
          amount: Number(meta.amount ?? 0),
        });
      }
    } catch {
      // skip malformed
    }
  }

  // Live mark prices for each market
  const markPrices = fetchLiveMarkPrices();

  // Enrich positions with entry info + mark price
  for (const p of livePositions) {
    const mark = markPrices[p.symbol];
    if (typeof mark === "number") p.markPrice = mark;
    const entry = entryByFirstSeen.get(p.symbol);
    if (entry) {
      p.entryTime = entry.ts.toISOString().slice(0, 16).replace("T", " ");
      if (entry.amount > 0) p.entryAmount = entry.amount;
      if (!p.entryPrice) {
        if (entry.price > 0) {
          p.entryPrice = entry.price;
        } else {
          const market = MARKETS[p.symbol as keyof typeof MARKETS];
          if (market) {
            const inferred = fetchHistoricalPrice(
              market.marketId,
              entry.ts.getTime(),
            );
            if (inferred && inferred > 0) p.entryPrice = inferred;
          }
        }
      }
    }
  }

  // === Portfolio summary ===
  lines.push("## Portfolio");
  lines.push(`Total: $${portfolioTotal} | Available cash: $${portfolioAvailable}`);

  // Starting / current values + total pnl from portfolio history
  try {
    const [first, latest] = await Promise.all([
      prisma.portfolioSize.findFirst({ where: { modelId }, orderBy: { createdAt: "asc" } }),
      prisma.portfolioSize.findFirst({ where: { modelId }, orderBy: { createdAt: "desc" } }),
    ]);
    if (first && latest) {
      const start = Number(first.netPortfolio);
      const current = Number(latest.netPortfolio);
      const pnl = current - start;
      const pct = start > 0 ? (pnl / start) * 100 : 0;
      lines.push(`Starting: $${start.toFixed(2)} → Current: $${current.toFixed(2)} (realized+unrealized: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
    }
  } catch {
    // ignore
  }

  // === Open positions ===
  lines.push("");
  lines.push("## Open positions");
  if (livePositions.length === 0) {
    lines.push("None.");
  } else {
    for (const p of livePositions) {
      const entryStr = p.entryPrice ? `$${p.entryPrice}` : "n/a";
      const markStr = p.markPrice ? `$${p.markPrice}` : "n/a";
      const pnlPct =
        p.entryPrice && p.markPrice
          ? ((p.markPrice - p.entryPrice) / p.entryPrice) *
            100 *
            (p.side === "LONG" ? 1 : -1)
          : null;
      const pnlPctStr = pnlPct === null ? "" : ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`;
      const timeStr = p.entryTime ? ` since ${p.entryTime}` : "";
      const amtStr = p.entryAmount ? ` risk=$${p.entryAmount}` : "";
      const liqStr = p.liquidationPrice > 0 ? ` liq=$${p.liquidationPrice}` : "";
      lines.push(
        `  - ${p.side} ${p.symbol} size=${p.size} entry=${entryStr} mark=${markStr} uPnL=$${p.unrealizedPnl.toFixed(2)}${pnlPctStr}${timeStr}${amtStr}${liqStr}`,
      );
    }
  }

  // === Recent trade history ===
  lines.push("");
  lines.push("## Recent trades (most recent first, last 15)");
  const recent = recentToolCalls.slice(0, 15);
  if (recent.length === 0) {
    lines.push("No trades recorded.");
  } else {
    for (const tc of recent) {
      if (!tc) continue;
      try {
        const meta = JSON.parse(tc.metadata) as {
          symbol?: string;
          side?: string;
          amount?: number;
          quantity?: number;
          price?: number;
          type?: string;
          triggerPrice?: number;
        };
        const ts = tc.createdAt.toISOString().slice(0, 16).replace("T", " ");
        if (tc.toolCallType === "CREATE_POSITION") {
          const kind = meta.type ?? "market";
          const priceStr = meta.price ? ` @ $${meta.price}` : "";
          const trigStr = meta.triggerPrice ? ` trigger=$${meta.triggerPrice}` : "";
          lines.push(
            `  [${ts}] ${kind.toUpperCase()} ${meta.side ?? ""} ${meta.symbol ?? ""} $${meta.amount ?? "?"}${priceStr}${trigStr}`,
          );
        } else if (tc.toolCallType === "CLOSE_POSITION") {
          lines.push(`  [${ts}] CLOSE ${meta.symbol ?? "ALL"}`);
        }
      } catch {
        // skip
      }
    }
  }

  // === Live indicators (5m + 4h) ===
  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  type MarketSnapshot = {
    slug: string;
    last5m: number;
    rsi5m: number;
    macd5m: number;
    ema5m: number;
    bbU5m: number;
    bbL5m: number;
    last4h: number;
    rsi4h: number;
    macd4h: number;
    ema4h: number;
    bbU4h: number;
    bbL4h: number;
  };
  const snapshots: MarketSnapshot[] = [];
  await Promise.all(
    marketSlugs.map(async (slug) => {
      try {
        const [i5, i4] = await Promise.all([
          getIndicators("5m", MARKETS[slug].marketId),
          getIndicators("4h", MARKETS[slug].marketId),
        ]);
        const pick = (arr: number[]) => arr[arr.length - 1] ?? 0;
        snapshots.push({
          slug,
          last5m: pick(i5.midPrices),
          rsi5m: pick(i5.rsi),
          macd5m: pick(i5.macd),
          ema5m: pick(i5.ema20s),
          bbU5m: pick(i5.bollingerBands.upper),
          bbL5m: pick(i5.bollingerBands.lower),
          last4h: pick(i4.midPrices),
          rsi4h: pick(i4.rsi),
          macd4h: pick(i4.macd),
          ema4h: pick(i4.ema20s),
          bbU4h: pick(i4.bollingerBands.upper),
          bbL4h: pick(i4.bollingerBands.lower),
        });
      } catch {
        // skip failed markets
      }
    }),
  );
  snapshots.sort((a, b) => a.slug.localeCompare(b.slug));

  if (snapshots.length > 0) {
    lines.push("");
    lines.push("## Markets (live indicators)");
    lines.push("Format: SYMBOL | 5m: price RSI MACD EMA20 BB[low..up] | 4h: price RSI MACD EMA20 BB[low..up]");
    for (const s of snapshots) {
      lines.push(
        `  ${s.slug} | 5m: $${s.last5m} RSI=${s.rsi5m.toFixed(1)} MACD=${s.macd5m.toFixed(3)} EMA20=${s.ema5m.toFixed(3)} BB[${s.bbL5m.toFixed(3)}..${s.bbU5m.toFixed(3)}] | 4h: $${s.last4h} RSI=${s.rsi4h.toFixed(1)} MACD=${s.macd4h.toFixed(3)} EMA20=${s.ema4h.toFixed(3)} BB[${s.bbL4h.toFixed(3)}..${s.bbU4h.toFixed(3)}]`,
      );
    }
  }

  // === Recent AI thinking ===
  try {
    const recentInvocations = await prisma.invocations.findMany({
      where: { modelId },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    if (recentInvocations.length > 0) {
      lines.push("");
      lines.push("## Recent AI reasoning (last 3 cycles)");
      for (const inv of recentInvocations) {
        const ts = inv.createdAt.toISOString().slice(0, 16).replace("T", " ");
        const summary = inv.response.length > 300 ? inv.response.slice(0, 300) + "..." : inv.response;
        lines.push(`  [${ts}] ${summary}`);
      }
    }
  } catch {
    // ignore
  }

  return lines.join("\n");
}

app.post("/chat", async (req, res) => {
  const rawMessages = req.body?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const history: ChatMessage[] = [];
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role as ChatRole;
    const content = typeof m.content === "string" ? m.content : "";
    if ((role === "user" || role === "assistant") && content.trim().length > 0) {
      history.push({ role, content });
    }
  }
  if (history.length === 0) {
    res.status(400).json({ error: "no valid user or assistant messages" });
    return;
  }

  const model = await prisma.models.findFirst();
  if (!model) {
    res.status(500).json({ error: "No model configured" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const abort = new AbortController();
  req.on("close", () => abort.abort());

  try {
    const liveContext = await buildLiveContext(model.id);
    const systemContent = liveContext
      ? `${CHAT_SYSTEM_PROMPT}\n\n## Live state\n${liveContext}`
      : CHAT_SYSTEM_PROMPT;

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...history,
    ];

    send("start", { model: model.name });

    await streamDOChat(model.openRoutermodelName, messages, abort.signal, (token) => {
      send("token", { content: token });
    });

    send("done", {});
    res.end();
  } catch (err) {
    if (abort.signal.aborted) {
      res.end();
      return;
    }
    console.error("Error in /chat stream:", (err as Error).message);
    send("error", { message: (err as Error).message || "chat failed" });
    res.end();
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
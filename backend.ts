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
    }> = [];

    const acct = account.accounts?.[0];
    if (acct?.positions && Array.isArray(acct.positions)) {
      for (const pos of acct.positions) {
        const size = Number(pos.position ?? pos.size ?? 0);
        if (size === 0) continue;
        const side = (pos.sign === 1 || pos.sign === "1") ? "LONG" as const : "SHORT" as const;
        positions.push({
          symbol: pos.symbol ?? "?",
          side,
          size: Math.abs(size),
          entryPrice: Number(pos.entryPrice ?? pos.entry_price ?? 0),
          markPrice: Number(pos.markPrice ?? pos.mark_price ?? 0),
          unrealizedPnl: Number(pos.unrealizedPnl ?? pos.unrealized_pnl ?? 0),
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

async function buildLiveContext(): Promise<string> {
  const lines: string[] = [];

  try {
    const token = getAuthToken();
    const accountIndex = process.env.ACCOUNT_INDEX ?? "0";
    const url = `${BASE_URL}/api/v1/account?by=index&value=${accountIndex}`;
    const raw = fetchH2(url, token);
    const account = JSON.parse(raw) as {
      accounts?: Array<{
        collateral?: string;
        available_balance?: string;
        positions?: Array<{
          symbol: string;
          position: string;
          sign: number | string;
          entryPrice?: string | number;
          markPrice?: string | number;
          unrealizedPnl?: string | number;
        }>;
      }>;
    };
    const acct = account.accounts?.[0];
    if (acct) {
      lines.push(`Portfolio: total=$${acct.collateral ?? "0"} available=$${acct.available_balance ?? "0"}`);
      const positions = (acct.positions ?? []).filter((p) => Number(p.position ?? 0) !== 0);
      if (positions.length === 0) {
        lines.push("Open positions: none");
      } else {
        lines.push("Open positions:");
        for (const p of positions) {
          const side = p.sign === 1 || p.sign === "1" ? "LONG" : "SHORT";
          lines.push(`  - ${side} ${p.symbol} size=${p.position} entry=${p.entryPrice ?? "?"} mark=${p.markPrice ?? "?"} uPnL=${p.unrealizedPnl ?? "?"}`);
        }
      }
    }
  } catch (err) {
    console.error("buildLiveContext account error:", (err as Error).message);
  }

  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  const marketSnippets: string[] = [];
  await Promise.all(
    marketSlugs.map(async (slug) => {
      try {
        const ind = await getIndicators("5m", MARKETS[slug].marketId);
        const last = ind.midPrices[ind.midPrices.length - 1] ?? 0;
        const rsi = ind.rsi[ind.rsi.length - 1] ?? 0;
        const macd = ind.macd[ind.macd.length - 1] ?? 0;
        marketSnippets.push(`${slug}: $${last} | RSI=${Number(rsi).toFixed(1)} | MACD=${Number(macd).toFixed(3)}`);
      } catch {
        // skip failed markets silently
      }
    }),
  );
  if (marketSnippets.length > 0) {
    lines.push("");
    lines.push("Live markets (5m):");
    for (const s of marketSnippets) lines.push(`  - ${s}`);
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
    const liveContext = await buildLiveContext();
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
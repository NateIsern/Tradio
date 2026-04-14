import express from "express";
import { PrismaClient, type PortfolioSize } from "./generated/prisma/client";
import cors from "cors";
import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";
import { MARKETS } from "./markets";

const prisma = new PrismaClient();

const app = express();
app.use(cors());
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

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
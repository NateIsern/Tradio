import express from "express";
import { PrismaClient, type PortfolioSize } from "./generated/prisma/client";
import cors from "cors";
import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";

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

    if (account.positions && Array.isArray(account.positions)) {
      for (const pos of account.positions) {
        const size = Number(pos.size ?? pos.quantity ?? 0);
        if (size === 0) continue;
        const entryPrice = Number(pos.entry_price ?? pos.entryPrice ?? 0);
        const markPrice = Number(pos.mark_price ?? pos.markPrice ?? entryPrice);
        const side = size > 0 ? "LONG" as const : "SHORT" as const;
        const absSize = Math.abs(size);
        const unrealizedPnl = side === "LONG"
          ? (markPrice - entryPrice) * absSize
          : (entryPrice - markPrice) * absSize;
        positions.push({
          symbol: pos.symbol ?? pos.market ?? `Market-${pos.market_index ?? pos.marketIndex ?? "?"}`,
          side,
          size: absSize,
          entryPrice,
          markPrice,
          unrealizedPnl,
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

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
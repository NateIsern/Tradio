import { execSync } from "child_process";
import type { Account } from "./accounts";
import { BASE_URL } from "./config";
import { MARKETS } from "./markets";
import { getAuthToken, fetchH2 } from "./auth";

function getLatestPrice(marketId: number): number {
    const token = getAuthToken();
    const now = Date.now();
    const url = `${BASE_URL}/api/v1/candles?market_id=${marketId}&resolution=1m&start_timestamp=${now - 300000}&end_timestamp=${now}&count_back=1`;
    const body = fetchH2(url, token);
    const data = JSON.parse(body) as { c: Array<{ c: number }> };
    const price = data.c[data.c.length - 1]?.c;
    if (!price) throw new Error("No latest price found");
    return price;
}

export async function createPosition(account: Account, symbol: string, side: "LONG" | "SHORT", quantity: number) {
    const market = MARKETS[symbol as keyof typeof MARKETS];
    const latestPrice = getLatestPrice(market.marketId);
    const price = Math.round((side === "LONG" ? latestPrice * 1.01 : latestPrice * 0.99) * market.priceDecimals);
    const baseAmount = Math.round(quantity * market.qtyDecimals);
    const isAsk = side === "LONG" ? "false" : "true";

    const result = execSync(
        `python3 trade.py create_order ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${price} ${isAsk} `,
        { cwd: import.meta.dir, env: process.env },
    ).toString().trim();

    const parsed = JSON.parse(result);
    if (parsed.error) throw new Error(`Trade failed: ${parsed.error}`);
    console.log(`Order placed: ${symbol} ${side} qty=${quantity} tx=${parsed.tx_hash}`);
}

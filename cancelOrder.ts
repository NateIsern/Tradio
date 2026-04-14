import { execSync } from "child_process";
import type { Account } from "./accounts";
import { BASE_URL } from "./config";
import { MARKETS } from "./markets";
import { getOpenPositions } from "./openPositions";
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

export async function cancelAllOrders(account: Account) {
    const openPositions = await getOpenPositions(account.apiKey, account.accountIndex);
    if (!openPositions?.length) return;

    const positionsData = openPositions
        .filter(p => Number(p.position) !== 0)
        .map(p => {
            const market = MARKETS[p.symbol as keyof typeof MARKETS];
            return {
                symbol: p.symbol,
                position: p.position,
                sign: p.sign,
                marketId: market.marketId,
                clientOrderIndex: market.clientOrderIndex,
                qtyDecimals: market.qtyDecimals,
                priceDecimals: market.priceDecimals,
                latestPrice: getLatestPrice(market.marketId),
            };
        });

    if (positionsData.length === 0) return;

    const result = execSync(
        `python3 trade.py close_all '${JSON.stringify(positionsData)}' `,
        { cwd: import.meta.dir, env: process.env },
    ).toString().trim();

    console.log("Close all result:", result);
}

import { execSync } from "child_process";
import type { Account } from "./accounts";
import { BASE_URL, PYTHON } from "./config";
import { MARKETS } from "./markets";
import { getOpenPositions } from "./openPositions";
import { getAuthToken, fetchH2 } from "./auth";

async function getLatestPrice(marketId: number): Promise<number> {
    const token = getAuthToken();
    const now = Date.now();
    const url = `${BASE_URL}/api/v1/candles?market_id=${marketId}&resolution=1m&start_timestamp=${now - 300000}&end_timestamp=${now}&count_back=1`;
    const body = await fetchH2(url, token);
    const data = JSON.parse(body) as { c: Array<{ c: number }> };
    const price = data.c[data.c.length - 1]?.c;
    if (!price) throw new Error("No latest price found");
    return price;
}

export async function cancelAllOrders(account: Account) {
    const openPositions = await getOpenPositions(account.apiKey, account.accountIndex);
    if (!openPositions?.length) return;

    const nonZero = openPositions.filter(p => Number(p.position) !== 0);
    // Parallelize latest-price lookups across markets.
    const positionsData = await Promise.all(nonZero.map(async (p) => {
        const market = MARKETS[p.symbol as keyof typeof MARKETS];
        return {
            symbol: p.symbol,
            position: p.position,
            sign: p.sign,
            marketId: market.marketId,
            clientOrderIndex: market.clientOrderIndex,
            qtyDecimals: market.qtyDecimals,
            priceDecimals: market.priceDecimals,
            latestPrice: await getLatestPrice(market.marketId),
        };
    }));

    if (positionsData.length === 0) return;

    const result = execSync(
        `"${PYTHON}" trade.py close_all '${JSON.stringify(positionsData)}' `,
        { cwd: import.meta.dir, env: process.env },
    ).toString().trim();

    console.log("Close all result:", result);
}

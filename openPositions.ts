import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";

interface Position {
    symbol: string;
    position: string;
    sign: number;
    unrealizedPnl: string;
    realizedPnl: string;
    liquidationPrice: string;
}

export async function getOpenPositions(apiKey: string, accountIndex: string) {
    const token = getAuthToken();
    const body = await fetchH2(`${BASE_URL}/api/v1/account?by=index&value=${accountIndex}`, token);
    const data = JSON.parse(body) as { accounts: Array<{ positions: Position[] }> };

    return data.accounts[0]?.positions.map((p) => ({
        symbol: p.symbol,
        position: p.position,
        sign: p.sign == 1 ? "LONG" : "SHORT",
        unrealizedPnl: p.unrealizedPnl,
        realizedPnl: p.realizedPnl,
        liquidationPrice: p.liquidationPrice,
    }));
}

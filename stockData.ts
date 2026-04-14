import { getEma, getMacd } from "./indicators";
import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";

interface CandleRaw {
    t: number;
    o: number;
    c: number;
    h: number;
    l: number;
    V: number;
    i: number;
}

function fetchCandles(marketId: number, resolution: string, count: number): CandleRaw[] {
    const now = Date.now();
    const hours = resolution === "5m" ? 2 : 96;
    const start = now - 1000 * 60 * 60 * hours;
    const token = getAuthToken();

    const url = `${BASE_URL}/api/v1/candles?market_id=${marketId}&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${now}&count_back=${count}`;
    const body = fetchH2(url, token);
    const data = JSON.parse(body) as { c: CandleRaw[] };
    return data.c ?? [];
}

function getMidPrices(candles: CandleRaw[]): number[] {
    return candles.map(c => Number(((c.o + c.c) / 2).toFixed(3)));
}

export async function getIndicators(duration: "5m" | "4h", marketId: number): Promise<{ midPrices: number[], macd: number[], ema20s: number[] }> {
    const candles = fetchCandles(marketId, duration, 50);
    const midPrices = getMidPrices(candles);

    if (midPrices.length < 26) {
        return {
            midPrices: midPrices.slice(-10).map(x => Number(x.toFixed(3))),
            macd: [],
            ema20s: [],
        };
    }

    const macd = getMacd(midPrices).slice(-10);
    const ema20s = getEma(midPrices, 20);

    return {
        midPrices: midPrices.slice(-10).map(x => Number(x.toFixed(3))),
        macd: macd.slice(-10).map(x => Number(x.toFixed(3))),
        ema20s: ema20s.slice(-10).map(x => Number(x.toFixed(3))),
    };
}

import { getEma, getMacd, getRSI, getBollingerBands } from "./indicators";
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

interface IndicatorResult {
    midPrices: number[];
    macd: number[];
    ema20s: number[];
    rsi: number[];
    bollingerBands: { upper: number[]; middle: number[]; lower: number[] };
}

export async function getIndicators(duration: "5m" | "4h", marketId: number): Promise<IndicatorResult> {
    const candles = fetchCandles(marketId, duration, 50);
    const midPrices = getMidPrices(candles);

    if (midPrices.length < 26) {
        return {
            midPrices: midPrices.slice(-10).map(x => Number(x.toFixed(3))),
            macd: [],
            ema20s: [],
            rsi: [],
            bollingerBands: { upper: [], middle: [], lower: [] },
        };
    }

    const macd = getMacd(midPrices);
    const ema20s = getEma(midPrices, 20);
    const rsi = getRSI(midPrices, 14);
    const bb = getBollingerBands(midPrices, 20, 2);

    return {
        midPrices: midPrices.slice(-10).map(x => Number(x.toFixed(3))),
        macd: macd.slice(-10).map(x => Number(x.toFixed(3))),
        ema20s: ema20s.slice(-10).map(x => Number(x.toFixed(3))),
        rsi: rsi.slice(-10).map(x => Number(x.toFixed(1))),
        bollingerBands: {
            upper: bb.upper.slice(-10).map(x => Number(x.toFixed(3))),
            middle: bb.middle.slice(-10).map(x => Number(x.toFixed(3))),
            lower: bb.lower.slice(-10).map(x => Number(x.toFixed(3))),
        },
    };
}

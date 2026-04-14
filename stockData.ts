import {
    getEma,
    getMacd,
    getRSI,
    getBollingerBands,
    getATR,
    getADX,
} from "./indicators";
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

// Hours of history per resolution — sized to give indicators enough warmup.
// 5m: 50 candles need 250 min, plus warmup → 5h window
// 4h: 50 candles need 200h, plus warmup → 220h window
const RESOLUTION_HOURS: Record<string, number> = {
    "5m": 5,
    "1h": 72,
    "4h": 220,
    "1d": 24 * 200,
};

function fetchCandles(marketId: number, resolution: string, count: number): CandleRaw[] {
    const now = Date.now();
    const hours = RESOLUTION_HOURS[resolution] ?? 96;
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

export interface IndicatorResult {
    midPrices: number[];
    macd: number[];
    ema20s: number[];
    rsi: number[];
    bollingerBands: { upper: number[]; middle: number[]; lower: number[] };
    atr14: number[];
    adx14: number[];
    lastPrice: number;
    lastHigh: number;
    lastLow: number;
    bbWidth: number;     // last BB width as fraction of mid price
    atrPct: number;      // last ATR as fraction of last price
}

export async function getIndicators(
    duration: "5m" | "4h" | "1h" | "1d",
    marketId: number,
): Promise<IndicatorResult> {
    const candles = fetchCandles(marketId, duration, 50);
    const midPrices = getMidPrices(candles);
    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const closes = candles.map(c => c.c);

    const empty: IndicatorResult = {
        midPrices: midPrices.slice(-10).map(x => Number(x.toFixed(3))),
        macd: [],
        ema20s: [],
        rsi: [],
        bollingerBands: { upper: [], middle: [], lower: [] },
        atr14: [],
        adx14: [],
        lastPrice: midPrices[midPrices.length - 1] ?? 0,
        lastHigh: highs[highs.length - 1] ?? 0,
        lastLow: lows[lows.length - 1] ?? 0,
        bbWidth: 0,
        atrPct: 0,
    };

    if (midPrices.length < 26) return empty;

    const macd = getMacd(midPrices);
    const ema20s = getEma(midPrices, 20);
    const rsi = getRSI(midPrices, 14);
    const bb = getBollingerBands(midPrices, 20, 2);
    const atr14 = getATR(highs, lows, closes, 14);
    const adxResult = getADX(highs, lows, closes, 14);

    const lastBbUpper = bb.upper[bb.upper.length - 1] ?? 0;
    const lastBbLower = bb.lower[bb.lower.length - 1] ?? 0;
    const lastBbMiddle = bb.middle[bb.middle.length - 1] ?? 0;
    const bbWidth = lastBbMiddle > 0 ? (lastBbUpper - lastBbLower) / lastBbMiddle : 0;

    const lastPrice = midPrices[midPrices.length - 1] ?? 0;
    const lastAtr = atr14[atr14.length - 1] ?? 0;
    const atrPct = lastPrice > 0 ? lastAtr / lastPrice : 0;

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
        atr14: atr14.slice(-10).map(x => Number(x.toFixed(4))),
        adx14: adxResult.adx.slice(-10).map(x => Number(x.toFixed(1))),
        lastPrice,
        lastHigh: highs[highs.length - 1] ?? 0,
        lastLow: lows[lows.length - 1] ?? 0,
        bbWidth: Number(bbWidth.toFixed(4)),
        atrPct: Number(atrPct.toFixed(4)),
    };
}

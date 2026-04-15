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

// Snap `now` to the start of the current candle. The bot + backend + /chat
// all ask for the same candle window within the same bar, so we quantize the
// URL timestamps to the resolution boundary and the auth.ts response cache
// collapses all of them into a single Lighter call.
const RESOLUTION_MS: Record<string, number> = {
    "5m": 5 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
};

async function fetchCandles(marketId: number, resolution: string, count: number): Promise<CandleRaw[]> {
    const resMs = RESOLUTION_MS[resolution] ?? 5 * 60 * 1000;
    const now = Math.floor(Date.now() / resMs) * resMs;
    const hours = RESOLUTION_HOURS[resolution] ?? 96;
    const start = now - 1000 * 60 * 60 * hours;
    const token = getAuthToken();

    const url = `${BASE_URL}/api/v1/candles?market_id=${marketId}&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${now}&count_back=${count}`;
    const body = await fetchH2(url, token);
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

// Process-level cache for computed indicators. A fresh 5m candle only arrives
// every 5 minutes, 4h every 4 hours — polling more often than that burns
// Lighter calls for no information gain. TTL is sized well under the candle
// period so reactions still land inside the current bar.
type IndicatorCacheEntry = { at: number; value: Promise<IndicatorResult> };
const indicatorCache = new Map<string, IndicatorCacheEntry>();
const INDICATOR_TTL_MS: Record<string, number> = {
    "5m": 30_000,
    "1h": 60_000,
    "4h": 120_000,
    "1d": 300_000,
};

export async function getIndicators(
    duration: "5m" | "4h" | "1h" | "1d",
    marketId: number,
): Promise<IndicatorResult> {
    const key = `${duration}:${marketId}`;
    const ttl = INDICATOR_TTL_MS[duration] ?? 60_000;
    const hit = indicatorCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;

    const task = computeIndicators(duration, marketId);
    indicatorCache.set(key, { at: Date.now(), value: task });
    task.catch(() => indicatorCache.delete(key));
    return task;
}

async function computeIndicators(
    duration: "5m" | "4h" | "1h" | "1d",
    marketId: number,
): Promise<IndicatorResult> {
    const candles = await fetchCandles(marketId, duration, 50);
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

    // Return last 5 bars instead of 10 — halves the per-market payload sent
    // to the LLM, cutting input-token processing by ~30-40% per cycle.
    return {
        midPrices: midPrices.slice(-5).map(x => Number(x.toFixed(3))),
        macd: macd.slice(-5).map(x => Number(x.toFixed(3))),
        ema20s: ema20s.slice(-5).map(x => Number(x.toFixed(3))),
        rsi: rsi.slice(-5).map(x => Number(x.toFixed(1))),
        bollingerBands: {
            upper: bb.upper.slice(-5).map(x => Number(x.toFixed(3))),
            middle: bb.middle.slice(-5).map(x => Number(x.toFixed(3))),
            lower: bb.lower.slice(-5).map(x => Number(x.toFixed(3))),
        },
        atr14: atr14.slice(-5).map(x => Number(x.toFixed(4))),
        adx14: adxResult.adx.slice(-5).map(x => Number(x.toFixed(1))),
        lastPrice,
        lastHigh: highs[highs.length - 1] ?? 0,
        lastLow: lows[lows.length - 1] ?? 0,
        bbWidth: Number(bbWidth.toFixed(4)),
        atrPct: Number(atrPct.toFixed(4)),
    };
}


// @params{period} - The period for which the EMA is being calculated

import type { Candlestick } from "./lighter-sdk-ts/generated";
export function getEma(prices: number[], period: number): number[] {
    const multiplier = 2 / (period + 1);
    
    if (prices.length < period) {
        throw new Error("Not enough prices provided");
    }

    // Calculate initial SMA
    let sma = 0;
    for (let i = 0; i < period; i++) {
        sma += (prices[i] ?? 0);
    }
    sma /= period;

    const emas = [sma];
    
    // Calculate EMA for remaining prices
    for (let i = period; i < prices.length; i++) {
        const ema = (emas[emas.length - 1] ?? 0) * (1 - multiplier) + (prices[i] ?? 0) * multiplier;
        emas.push(ema);
    }
    
    return emas;
}

export function getMidPrices(candlesticks: Candlestick[]) {
    return candlesticks.map(({open, close}) => Number(((open + close) / 2).toFixed(3)));
}

// macd => ema12 = 38 points, ema26 = 24 points
export function getMacd(prices: number[]) {

    const ema26 = getEma(prices, 26); // [].length = 24
    let ema12 = getEma(prices, 12); // [].length = 38

    ema12 = ema12.slice(-ema26.length);

    const macd = ema12.map((_, index) => (ema12[index] ?? 0) - (ema26[index] ?? 0));
    return macd
}

export function getRSI(prices: number[], period: number = 14): number[] {
    if (prices.length < period + 1) {
        return [];
    }

    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const change = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? -change : 0);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
        avgGain += gains[i] ?? 0;
        avgLoss += losses[i] ?? 0;
    }
    avgGain /= period;
    avgLoss /= period;

    const rsiValues: number[] = [];
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - 100 / (1 + rs));

    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + (gains[i] ?? 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (losses[i] ?? 0)) / period;
        const currentRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiValues.push(100 - 100 / (1 + currentRs));
    }

    return rsiValues;
}

// True Range at bar i requires the previous close. TR_0 is undefined; we start at i=1.
function getTrueRange(highs: number[], lows: number[], closes: number[]): number[] {
    const tr: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        const h = highs[i] ?? 0;
        const l = lows[i] ?? 0;
        const prevClose = closes[i - 1] ?? 0;
        tr.push(Math.max(
            h - l,
            Math.abs(h - prevClose),
            Math.abs(l - prevClose),
        ));
    }
    return tr;
}

// Wilder smoothing: ATR_p = mean(TR_1..TR_p); ATR_i = (ATR_{i-1} * (p-1) + TR_i) / p
function wilderSmooth(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i] ?? 0;
    out.push(sum / period);
    for (let i = period; i < values.length; i++) {
        const prev = out[out.length - 1] ?? 0;
        out.push((prev * (period - 1) + (values[i] ?? 0)) / period);
    }
    return out;
}

export function getATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14,
): number[] {
    if (highs.length < period + 1) return [];
    const tr = getTrueRange(highs, lows, closes);
    return wilderSmooth(tr, period);
}

// ADX (Wilder 14). Returns the ADX series; callers typically only need the last value.
// +DM_i = up-move  if up-move > down-move and > 0, else 0
// -DM_i = down-move if down-move > up-move and > 0, else 0
// +DI = 100 * smoothed+DM / smoothedTR ; -DI analogous
// DX = 100 * |+DI - -DI| / (+DI + -DI)
// ADX = Wilder smoothing of DX over `period` bars.
export function getADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14,
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
    if (highs.length < period * 2 + 1) return { adx: [], plusDI: [], minusDI: [] };

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        const upMove = (highs[i] ?? 0) - (highs[i - 1] ?? 0);
        const downMove = (lows[i - 1] ?? 0) - (lows[i] ?? 0);
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        const h = highs[i] ?? 0;
        const l = lows[i] ?? 0;
        const prevClose = closes[i - 1] ?? 0;
        tr.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
    }

    const smoothPlusDM = wilderSmooth(plusDM, period);
    const smoothMinusDM = wilderSmooth(minusDM, period);
    const smoothTR = wilderSmooth(tr, period);

    const plusDI: number[] = [];
    const minusDI: number[] = [];
    const dx: number[] = [];
    for (let i = 0; i < smoothTR.length; i++) {
        const trVal = smoothTR[i] ?? 0;
        if (trVal === 0) {
            plusDI.push(0);
            minusDI.push(0);
            dx.push(0);
            continue;
        }
        const pDI = 100 * ((smoothPlusDM[i] ?? 0) / trVal);
        const mDI = 100 * ((smoothMinusDM[i] ?? 0) / trVal);
        plusDI.push(pDI);
        minusDI.push(mDI);
        const sum = pDI + mDI;
        dx.push(sum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / sum);
    }

    const adx = wilderSmooth(dx, period);
    return { adx, plusDI, minusDI };
}

export function getBollingerBands(
    prices: number[],
    period: number = 20,
    stdDevMultiplier: number = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
    if (prices.length < period) {
        return { upper: [], middle: [], lower: [] };
    }

    const upper: number[] = [];
    const middle: number[] = [];
    const lower: number[] = [];

    for (let i = period - 1; i < prices.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            sum += prices[j] ?? 0;
        }
        const sma = sum / period;

        let varianceSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const diff = (prices[j] ?? 0) - sma;
            varianceSum += diff * diff;
        }
        const stdDev = Math.sqrt(varianceSum / period);

        middle.push(sma);
        upper.push(sma + stdDevMultiplier * stdDev);
        lower.push(sma - stdDevMultiplier * stdDev);
    }

    return { upper, middle, lower };
}
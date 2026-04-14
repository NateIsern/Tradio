
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
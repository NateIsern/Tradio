import { PROMPT } from './prompt';
import { PYTHON } from './config';

// Async wrapper around `python3 trade.py ...` — lets us parallelize tool
// execution via Promise.all instead of blocking the event loop per call.
async function runTradePy(args: string[]): Promise<string> {
  const proc = Bun.spawn([PYTHON, "trade.py", ...args], {
    cwd: import.meta.dir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return out.trim();
}

import { type Account } from './accounts';
import { getIndicators, type IndicatorResult } from './stockData';
import { getOpenPositions } from './openPositions';
import { MARKETS } from './markets';
import { createPosition } from './createPosition';
import { cancelAllOrders } from './cancelOrder';
import { PrismaClient, ToolCallType, HaltType } from './generated/prisma/client';
import { getPortfolio } from './getPortfolio';
import { getAuthToken, fetchH2 } from './auth';
import { sendTelegramAlert } from './telegram';
import {
  BASE_URL,
  DRY_RUN,
  ENABLE_TRADING,
  LOOP_INTERVAL_MS,
  LOOP_ALIGN_BUFFER_MS,
  LLM_CONFIG,
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL_OVERRIDE,
  RISK,
} from './config';

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

const prisma = new PrismaClient();

interface ChatMessage { role: string; content: string }
interface ToolCall { id: string; type: string; function: { name: string; arguments: string } }
interface ChatChoice {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
  durationMs?: number;
}

const MARKET_LEVERAGE: Record<string, number> = {
  BTC: 10,
  ETH: 10,
  SOL: 10,
  ZEC: 5,
  HYPE: 10,
  DOGE: 10,
  XRP: 10,
  LINK: 10,
  BNB: 10,
  AVAX: 10,
  DOT: 10,
  AAVE: 10,
  APT: 10,
  WLD: 10,
  ENA: 10,
};

const MIN_RR = 1.5; // minimum reward-to-risk enforced by the risk engine
const TELEGRAM_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const lastTelegramAt: Record<string, number> = {};

// Native Bun fetch with retry + backoff. Replaces the curl-with-tmpfile hack:
// removes a file-system race condition between concurrent cycles and gives us
// real HTTP error handling.
// Native Ollama /api/chat. The OpenAI shim ignores `think` on reasoning
// models (qwen3.5), so the bot must use the native endpoint to keep chain-of
// -thought enabled *and* get tool calls with a stable schema.
async function callLLMChat(
  _model: string,
  messages: ChatMessage[],
  tools: object[],
): Promise<ChatChoice> {
  const llmStart = Date.now();
  const ollamaBase = LLM_BASE_URL.replace(/\/v1\/?$/, "");
  const body = JSON.stringify({
    model: LLM_MODEL_OVERRIDE,
    messages,
    tools,
    stream: false,
    think: true,
    keep_alive: "30m",
    options: {
      temperature: LLM_CONFIG.TEMPERATURE,
      num_predict: LLM_CONFIG.MAX_COMPLETION_TOKENS,
    },
  });

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < LLM_CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), LLM_CONFIG.TIMEOUT_MS);
    try {
      const response = await fetch(`${ollamaBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LLM API ${response.status}: ${text.slice(0, 300)}`);
      }

      type NativeToolCall = {
        id?: string;
        function: { name: string; arguments: unknown };
      };
      const data = (await response.json()) as {
        message?: {
          content?: string | null;
          thinking?: string | null;
          tool_calls?: NativeToolCall[];
        };
        done_reason?: string;
        error?: string;
      };
      if (data.error) throw new Error(data.error);
      if (!data.message) throw new Error("no message in LLM response");

      // Ollama returns arguments as a decoded object; the downstream validator
      // expects a JSON string (OpenAI shape), so normalize here.
      const normalizedCalls = (data.message.tool_calls ?? []).map((tc, i) => {
        const args = tc.function.arguments;
        const argStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
        return {
          id: tc.id ?? `call_${i}`,
          type: "function",
          function: { name: tc.function.name, arguments: argStr },
        };
      });

      return {
        message: {
          content: data.message.content ?? null,
          tool_calls: normalizedCalls.length > 0 ? normalizedCalls : undefined,
        },
        finish_reason: data.done_reason ?? "stop",
        // duration added for telemetry at call-site
        durationMs: Date.now() - llmStart,
      };
    } catch (err) {
      lastErr = err as Error;
      if (attempt < LLM_CONFIG.MAX_RETRIES - 1) {
        const delay = LLM_CONFIG.RETRY_BACKOFF_MS[attempt] ?? 5000;
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  throw new Error(
    `LLM API failed after ${LLM_CONFIG.MAX_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`,
  );
}

// --- Risk engine helpers ---

interface RiskCheckInput {
  symbol: string;
  side: "LONG" | "SHORT";
  requestedAmount: number;
  leverage: number;
  lastPrice: number;
  atr: number;
  adx: number;
  rsi: number;
  equity: number;
  availableCash: number;
  openPositions: Array<{ symbol: string; position: string; sign: string }>;
  seenInCycle: Set<string>;
  minRR?: number;
}

interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  capped: boolean;
  approvedAmount: number;
  approvedQuantity: number;
  atrStopDistance: number;
  stopPrice: number;
  minTakeProfit?: number;
}

function riskCheck(input: RiskCheckInput): RiskCheckResult {
  const empty = {
    capped: false,
    approvedAmount: 0,
    approvedQuantity: 0,
    atrStopDistance: 0,
    stopPrice: 0,
  };

  if (input.equity <= 0) return { ...empty, approved: false, reason: "zero equity" };
  if (!Number.isFinite(input.requestedAmount) || input.requestedAmount <= 0) {
    return { ...empty, approved: false, reason: "amount must be > 0" };
  }
  if (!Number.isFinite(input.lastPrice) || input.lastPrice <= 0) {
    return { ...empty, approved: false, reason: "invalid last price" };
  }

  if (input.seenInCycle.has(input.symbol)) {
    return { ...empty, approved: false, reason: "duplicate entry in same cycle" };
  }

  const openCount = input.openPositions.filter((p) => Number(p.position) !== 0).length;
  if (openCount >= RISK.MAX_POSITIONS) {
    return { ...empty, approved: false, reason: `max ${RISK.MAX_POSITIONS} positions already open` };
  }

  const existing = input.openPositions.find(
    (p) => p.symbol === input.symbol && Number(p.position) !== 0,
  );
  if (existing) {
    if (existing.sign === input.side) {
      return { ...empty, approved: false, reason: `already ${input.side} ${input.symbol} — no pyramiding` };
    }
    return { ...empty, approved: false, reason: `opposite ${existing.sign} on ${input.symbol} — close first` };
  }

  if (input.adx < RISK.MIN_ADX_FOR_MARKET) {
    return { ...empty, approved: false, reason: `weak trend (ADX ${input.adx.toFixed(1)} < ${RISK.MIN_ADX_FOR_MARKET})` };
  }

  if (input.side === "LONG" && input.rsi > RISK.LONG_RSI_MAX) {
    return { ...empty, approved: false, reason: `RSI ${input.rsi.toFixed(1)} too hot for longs` };
  }
  if (input.side === "SHORT" && input.rsi < RISK.SHORT_RSI_MIN) {
    return { ...empty, approved: false, reason: `RSI ${input.rsi.toFixed(1)} too cold for shorts` };
  }

  const rawStopDistance = input.atr > 0
    ? input.atr * RISK.ATR_STOP_MULTIPLIER
    : input.lastPrice * RISK.MIN_SL_DISTANCE_PCT * 1.5;
  const minDistance = input.lastPrice * RISK.MIN_SL_DISTANCE_PCT;
  const maxDistance = input.lastPrice * RISK.MAX_SL_DISTANCE_PCT;
  const atrStopDistance = Math.min(Math.max(rawStopDistance, minDistance), maxDistance);
  const atrStopPct = atrStopDistance / input.lastPrice;

  const notionalCap = input.equity * RISK.MAX_NOTIONAL_PER_TRADE_PCT;
  let approvedAmount = input.requestedAmount;
  let capped = false;
  if (approvedAmount * input.leverage > notionalCap) {
    approvedAmount = notionalCap / input.leverage;
    capped = true;
  }

  const maxRiskDollar = input.equity * RISK.MAX_RISK_PER_TRADE_PCT;
  if (atrStopPct > 0) {
    const atrCapAmount = maxRiskDollar / (input.leverage * atrStopPct);
    if (approvedAmount > atrCapAmount) {
      approvedAmount = atrCapAmount;
      capped = true;
    }
  }

  if (approvedAmount > input.availableCash) {
    approvedAmount = input.availableCash;
    capped = true;
  }

  if (approvedAmount < RISK.MIN_TRADE_NOTIONAL_USD) {
    return {
      ...empty,
      approved: false,
      reason: `dust trade $${approvedAmount.toFixed(2)} < $${RISK.MIN_TRADE_NOTIONAL_USD}`,
    };
  }

  const approvedQuantity = Number((approvedAmount * input.leverage).toFixed(6));
  const stopPrice = input.side === "LONG"
    ? input.lastPrice - atrStopDistance
    : input.lastPrice + atrStopDistance;

  // Enforce minimum reward-to-risk when the caller provides a TP heuristic.
  // With ATR-based stop distance, require at least 1.5R unless overridden.
  if (input.minRR && input.minRR > 0) {
    const rr = input.minRR;
    const tpDistance = atrStopDistance * rr;
    const minTakeProfit = input.side === "LONG"
      ? input.lastPrice + tpDistance
      : input.lastPrice - tpDistance;
    return {
      approved: true,
      capped,
      approvedAmount: Number(approvedAmount.toFixed(4)),
      approvedQuantity,
      atrStopDistance,
      stopPrice: Number(stopPrice.toFixed(6)),
      minTakeProfit: Number(minTakeProfit.toFixed(6)),
    };
  }

  return {
    approved: true,
    capped,
    approvedAmount: Number(approvedAmount.toFixed(4)),
    approvedQuantity,
    atrStopDistance,
    stopPrice: Number(stopPrice.toFixed(6)),
  };
}

function nextUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

interface CircuitBreakerResult {
  halted: boolean;
  reason?: string;
  hard?: boolean;
}

async function checkCircuitBreakers(
  accountId: string,
  equity: number,
): Promise<CircuitBreakerResult> {
  const activeHalt = await prisma.riskHaltEvent.findFirst({
    where: { modelId: accountId, clearsAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (activeHalt) {
    return { halted: true, reason: `${activeHalt.type} active until ${activeHalt.clearsAt.toISOString()}` };
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const todayPortfolios = await prisma.portfolioSize.findMany({
    where: { modelId: accountId, createdAt: { gte: startOfDay } },
    select: { netPortfolio: true },
  });

  if (todayPortfolios.length > 0 && equity > 0) {
    const todayValues = todayPortfolios
      .map((p) => Number(p.netPortfolio))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (todayValues.length > 0) {
      const dayHigh = Math.max(...todayValues, equity);
      if (dayHigh > 0) {
        const dd = (equity - dayHigh) / dayHigh;
        if (dd <= -RISK.HARD_DAILY_DRAWDOWN_PCT) {
          await prisma.riskHaltEvent.create({
            data: {
              modelId: accountId,
              type: HaltType.HARD_DAILY_DD,
              clearsAt: nextUtcMidnight(),
              payload: JSON.stringify({ dd, dayHigh, equity }),
            },
          });
          return { halted: true, hard: true, reason: `HARD daily DD ${(dd * 100).toFixed(2)}%` };
        }
        if (dd <= -RISK.MAX_DAILY_DRAWDOWN_PCT) {
          await prisma.riskHaltEvent.create({
            data: {
              modelId: accountId,
              type: HaltType.DAILY_DD,
              clearsAt: nextUtcMidnight(),
              payload: JSON.stringify({ dd, dayHigh, equity }),
            },
          });
          return { halted: true, reason: `daily DD ${(dd * 100).toFixed(2)}%` };
        }
      }
    }
  }

  return { halted: false };
}

// Places a stop-loss order for a freshly opened position. Called unconditionally
// after every new entry: the LLM's own SL request still runs, but this is the
// safety net that always fires. If SL placement fails, the caller must close.
async function placeAutoStopLoss(
  symbol: string,
  side: "LONG" | "SHORT",
  quantity: number,
  stopPrice: number,
): Promise<{ ok: boolean; error?: string; stopPrice: number }> {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] auto-SL ${side} ${symbol} qty=${quantity} @ ${stopPrice}`);
    return { ok: true, stopPrice };
  }

  const market = MARKETS[symbol as keyof typeof MARKETS];
  if (!market) return { ok: false, error: `unknown market ${symbol}`, stopPrice };

  // LONG exits via SELL (is_ask=true); SHORT exits via BUY (is_ask=false).
  const isAsk = side === "LONG";
  const triggerPriceInt = Math.round(stopPrice * market.priceDecimals);
  const execPrice = side === "LONG" ? stopPrice * 0.999 : stopPrice * 1.001;
  const execPriceInt = Math.round(execPrice * market.priceDecimals);
  const baseAmount = Math.abs(Math.round(quantity * market.qtyDecimals));

  try {
    const result = await runTradePy([
      "stop_loss",
      String(market.marketId),
      String(market.clientOrderIndex),
      String(baseAmount),
      String(triggerPriceInt),
      String(execPriceInt),
      String(isAsk),
    ]);
    const parsed = JSON.parse(result) as { error?: string };
    if (parsed.error) return { ok: false, error: parsed.error, stopPrice };
    return { ok: true, stopPrice };
  } catch (err) {
    return { ok: false, error: (err as Error).message, stopPrice };
  }
}

interface NormalizedArgs {
  symbol?: string;
  side?: "LONG" | "SHORT";
  amount?: number;
  price?: number;
  triggerPrice?: number;
  mode?: StrategyMode;
  bias?: StrategyBias;
  riskTier?: StrategyRiskTier;
  note?: string;
}

type StrategyMode = "aggressive" | "balanced" | "defensive" | "cash";
type StrategyBias = "long" | "short" | "neutral";
type StrategyRiskTier = "low" | "normal" | "high";
interface StrategyState {
  mode: StrategyMode;
  bias: StrategyBias;
  riskTier: StrategyRiskTier;
  note: string;
}
const STRATEGY_MODES: StrategyMode[] = ["aggressive", "balanced", "defensive", "cash"];
const STRATEGY_BIASES: StrategyBias[] = ["long", "short", "neutral"];
const STRATEGY_TIERS: StrategyRiskTier[] = ["low", "normal", "high"];
const DEFAULT_STRATEGY: StrategyState = {
  mode: "balanced",
  bias: "neutral",
  riskTier: "normal",
  note: "initial",
};

function parseStrategy(raw: string | null | undefined): StrategyState {
  if (!raw) return { ...DEFAULT_STRATEGY };
  try {
    const j = JSON.parse(raw) as Partial<StrategyState>;
    return {
      mode: STRATEGY_MODES.includes(j.mode as StrategyMode)
        ? (j.mode as StrategyMode)
        : DEFAULT_STRATEGY.mode,
      bias: STRATEGY_BIASES.includes(j.bias as StrategyBias)
        ? (j.bias as StrategyBias)
        : DEFAULT_STRATEGY.bias,
      riskTier: STRATEGY_TIERS.includes(j.riskTier as StrategyRiskTier)
        ? (j.riskTier as StrategyRiskTier)
        : DEFAULT_STRATEGY.riskTier,
      note: typeof j.note === "string" ? j.note.slice(0, 200) : DEFAULT_STRATEGY.note,
    };
  } catch {
    return { ...DEFAULT_STRATEGY };
  }
}

function validateToolArgs(
  fn: string,
  raw: string,
  validSymbols: Set<string>,
): { ok: true; args: NormalizedArgs } | { ok: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "tool args not valid JSON" };
  }

  const out: NormalizedArgs = {};

  if (fn === "closeAllPositions") return { ok: true, args: out };

  const symbol = parsed['symbol'];
  if (typeof symbol !== "string" || !validSymbols.has(symbol)) {
    return { ok: false, reason: `unknown symbol ${String(symbol)}` };
  }
  out.symbol = symbol;

  if (fn === "closePosition") return { ok: true, args: out };

  if (fn === "createPosition" || fn === "limitOrder") {
    const side = parsed['side'];
    if (side !== "LONG" && side !== "SHORT") {
      return { ok: false, reason: `side must be LONG|SHORT, got ${String(side)}` };
    }
    out.side = side;
    const amount = parsed['amount'];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: `amount must be a positive number, got ${String(amount)}` };
    }
    out.amount = amount;
    if (fn === "limitOrder") {
      const price = parsed['price'];
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        return { ok: false, reason: `price must be a positive number, got ${String(price)}` };
      }
      out.price = price;
    }
    return { ok: true, args: out };
  }

  if (fn === "setStopLoss" || fn === "setTakeProfit") {
    const triggerPrice = parsed['triggerPrice'];
    if (typeof triggerPrice !== "number" || !Number.isFinite(triggerPrice) || triggerPrice <= 0) {
      return { ok: false, reason: `triggerPrice must be > 0, got ${String(triggerPrice)}` };
    }
    out.triggerPrice = triggerPrice;
    return { ok: true, args: out };
  }

  if (fn === "notifyTelegram") {
    const title = parsed['title'];
    const message = parsed['message'];
    if (typeof title !== "string" || title.trim().length < 2) {
      return { ok: false, reason: "title must be a short string" };
    }
    if (typeof message !== "string" || message.trim().length < 2) {
      return { ok: false, reason: "message must be a short string" };
    }
    out.note = `${title.slice(0, 100)}|${message.slice(0, 400)}`;
    return { ok: true, args: out };
  }

  return { ok: false, reason: `unknown tool ${fn}` };
}

function validateStrategyArgs(
  raw: string,
): { ok: true; args: NormalizedArgs } | { ok: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "tool args not valid JSON" };
  }
  const out: NormalizedArgs = {};
  const mode = parsed['mode'];
  if (typeof mode !== "string" || !STRATEGY_MODES.includes(mode as StrategyMode)) {
    return { ok: false, reason: `mode must be one of ${STRATEGY_MODES.join("|")}` };
  }
  out.mode = mode as StrategyMode;
  const bias = parsed['bias'];
  if (typeof bias !== "string" || !STRATEGY_BIASES.includes(bias as StrategyBias)) {
    return { ok: false, reason: `bias must be one of ${STRATEGY_BIASES.join("|")}` };
  }
  out.bias = bias as StrategyBias;
  const riskTier = parsed['riskTier'];
  if (typeof riskTier !== "string" || !STRATEGY_TIERS.includes(riskTier as StrategyRiskTier)) {
    return { ok: false, reason: `riskTier must be one of ${STRATEGY_TIERS.join("|")}` };
  }
  out.riskTier = riskTier as StrategyRiskTier;
  const note = parsed['note'];
  if (typeof note !== "string" || note.trim().length < 5) {
    return { ok: false, reason: "note must be a sentence explaining WHY the strategy is changing" };
  }
  out.note = note.slice(0, 200);
  return { ok: true, args: out };
}

// --- Main agent loop ---

export const invokeAgent = async (account: Account) => {
  const t0 = Date.now();
  const mark = (label: string) => console.log(`[timing] ${label}: ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const portfolio = await getPortfolio(account);
  const equity = Number(portfolio.total);
  const availableCash = Number(portfolio.available);
  mark("portfolio");

  // Halt check first — do not waste LLM budget on a halted account.
  const breaker = await checkCircuitBreakers(account.id, equity);
  mark("circuit-breakers");
  if (breaker.halted) {
    console.log(`[HALT] ${account.name}: ${breaker.reason}`);
    if (breaker.hard) {
      try {
        await cancelAllOrders(account);
      } catch (err) {
        console.error("Hard halt close failed:", (err as Error).message);
      }
    }
    await prisma.invocations.create({
      data: {
        modelId: account.id,
        response: `[HALTED] ${breaker.reason}`,
        toolCalls: {
          create: {
            toolCallType: ToolCallType.HALT,
            metadata: JSON.stringify({ reason: breaker.reason, hard: breaker.hard ?? false }),
          },
        },
      },
    });
    return `[HALTED] ${breaker.reason}`;
  }

  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  // Keep per-symbol 5m indicators around so the risk engine can read ATR at open time.
  const indicatorBySymbol = new Map<string, IndicatorResult>();
  const longTermBySymbol = new Map<string, IndicatorResult>();

  await Promise.all(marketSlugs.map(async (marketSlug) => {
    const [intradayIndicators, longTermIndicators] = await Promise.all([
      getIndicators("5m", MARKETS[marketSlug].marketId),
      getIndicators("4h", MARKETS[marketSlug].marketId),
    ]);
    indicatorBySymbol.set(marketSlug, intradayIndicators);
    longTermBySymbol.set(marketSlug, longTermIndicators);
  }));
  mark("indicators");

  // Context budget: only dump full indicator history for markets worth looking
  // at. "Worth looking at" = either we already hold it (need to manage exit)
  // or the 5m structure shows a real signal (trending with momentum deviation).
  // Everything else gets a one-line summary — no arrays, no tail history.
  const currentOpenPositions = await getOpenPositions(account.apiKey, account.accountIndex);
  const openPositions = currentOpenPositions;
  mark("open-positions");

  const openSymbols = new Set(
    (currentOpenPositions ?? []).map((p) => p.symbol).filter((s): s is string => !!s),
  );
  const fmt = (n: number, d = 4) =>
    Number.isFinite(n) ? Number(n.toFixed(d)) : 0;
  const tail = <T>(arr: T[], n = 3) => arr.slice(-n);
  const isRelevant = (slug: string, ind: IndicatorResult) => {
    if (openSymbols.has(slug)) return true;
    const adx = ind.adx14[ind.adx14.length - 1] ?? 0;
    const rsi = ind.rsi[ind.rsi.length - 1] ?? 50;
    return adx >= RISK.MIN_ADX_FOR_MARKET && Math.abs(rsi - 50) >= 12;
  };

  const blocks: string[] = [];
  for (const slug of marketSlugs) {
    const i5 = indicatorBySymbol.get(slug);
    const i4 = longTermBySymbol.get(slug);
    if (!i5 || !i4) continue;
    if (!isRelevant(slug, i5)) continue;

    const bb5u = tail(i5.bollingerBands.upper).map((n) => fmt(n));
    const bb5l = tail(i5.bollingerBands.lower).map((n) => fmt(n));
    const bb5m = tail(i5.bollingerBands.middle).map((n) => fmt(n));
    const pick = (a: number[]) => fmt(a[a.length - 1] ?? 0);

    blocks.push(
      [
        `### ${slug}${openSymbols.has(slug) ? " (OPEN)" : ""}`,
        `5m (last 3): price=[${tail(i5.midPrices).map((n) => fmt(n, 2)).join(",")}] rsi=[${tail(i5.rsi).map((n) => fmt(n, 1)).join(",")}] macd=[${tail(i5.macd).map((n) => fmt(n)).join(",")}] ema20=[${tail(i5.ema20s).map((n) => fmt(n)).join(",")}] adx=${pick(i5.adx14)} atr=${pick(i5.atr14)} bb=[${bb5l[bb5l.length - 1]}..${bb5m[bb5m.length - 1]}..${bb5u[bb5u.length - 1]}] width=${fmt(i5.bbWidth * 100, 2)}% atr%=${fmt(i5.atrPct * 100, 2)}%`,
        `4h (latest):  price=${pick(i4.midPrices)} rsi=${pick(i4.rsi)} macd=${pick(i4.macd)} ema20=${pick(i4.ema20s)} adx=${pick(i4.adx14)}`,
      ].join("\n"),
    );
  }
  const ALL_INDICATOR_DATA =
    blocks.length > 0
      ? blocks.join("\n\n")
      : "No markets passing the signal filter this cycle. (Filter: open position OR 5m ADX≥18 AND |RSI-50|≥10.)";

  const modelInvocation = await prisma.invocations.create({
    data: {
      modelId: account.id,
      response: "",
      equity: equity.toString(),
      availableCash: availableCash.toString(),
      openPositions: JSON.stringify(currentOpenPositions ?? []),
      indicatorsSummary: ALL_INDICATOR_DATA.slice(0, 4000),
      llmDurationMs: 0, // filled after LLM call
    },
  });

  // Load current strategy regime. This survives across cycles — the LLM can
  // flip it with setStrategy when market conditions change.
  const modelRow = await prisma.models.findUnique({
    where: { id: account.id },
    select: { strategyState: true },
  });
  const strategy = parseStrategy(modelRow?.strategyState ?? null);
  const STRATEGY_STATE = `mode=${strategy.mode} | bias=${strategy.bias} | riskTier=${strategy.riskTier} | note="${strategy.note}"`;

  // Context hygiene: only the last 5 cycles (not 10), short one-liners only.
  const recentInvocations = await prisma.invocations.findMany({
    where: { modelId: account.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { toolCalls: true },
  });
  const tradeHistory = recentInvocations.length === 0
    ? "No previous trades."
    : recentInvocations
        .reverse()
        .map((inv) => {
          const actions = inv.toolCalls.length === 0
            ? "no-action"
            : inv.toolCalls.map((tc) => {
                try {
                  const meta = JSON.parse(tc.metadata) as {
                    symbol?: string;
                    side?: string;
                    amount?: number;
                    reason?: string;
                    type?: string;
                    mode?: string;
                  };
                  if (tc.toolCallType === "CREATE_POSITION") {
                    return `${meta.side ?? "?"} ${meta.symbol ?? "?"} $${meta.amount ?? "?"}`;
                  }
                  if (tc.toolCallType === "CLOSE_POSITION") return `CLOSE ${meta.symbol ?? "all"}`;
                  if (tc.toolCallType === "SET_SL") return `SL ${meta.symbol ?? "?"}`;
                  if (tc.toolCallType === "SET_TP") return `TP ${meta.symbol ?? "?"}`;
                  if (tc.toolCallType === "SET_STRATEGY") return `STRAT ${meta.mode ?? "?"}`;
                  if (tc.toolCallType === "HALT") return `HALT`;
                  if (tc.toolCallType === "REJECTED") return `REJ ${meta.type ?? "?"}:${meta.reason?.slice(0, 40) ?? ""}`;
                  return tc.toolCallType;
                } catch {
                  return tc.toolCallType;
                }
              }).join(";");
          const timestamp = inv.createdAt.toISOString().slice(11, 16);
          return `[${timestamp}] ${actions}`;
        })
        .join("\n");

  const enrichedPrompt = PROMPT
    .replace("{{INVOKATION_TIMES}}", account.invocationCount.toString())
    .replace("{{OPEN_POSITIONS}}", openPositions?.map((position) => `${position.symbol} ${position.position} ${position.sign}`).join(", ") ?? "none")
    .replace("{{PORTFOLIO_VALUE}}", portfolio.total)
    .replace("{{ALL_INDICATOR_DATA}}", ALL_INDICATOR_DATA)
    .replace("{{AVAILABLE_CASH}}", portfolio.available)
    .replace("{{CURRENT_ACCOUNT_VALUE}}", portfolio.total)
    .replace(
      "{{CURRENT_ACCOUNT_POSITIONS}}",
      openPositions && openPositions.length > 0
        ? openPositions
            .map((p) => `${p.symbol} ${p.sign} size=${p.position}`)
            .join("\n")
        : "none",
    )
    .replace("{{TRADE_HISTORY}}", tradeHistory)
    .replace("{{STRATEGY_STATE}}", STRATEGY_STATE);

  console.log(`[${account.name}] equity=$${equity.toFixed(2)} avail=$${availableCash.toFixed(2)} positions=${openPositions?.length ?? 0}`);
  console.log("Calling AI model:", account.modelName);

  const marketSymbols = Object.keys(MARKETS);
  const validSymbols = new Set(marketSymbols);
  const tools = [
    {
      type: "function",
      function: {
        name: "createPosition",
        description: "Open a MARKET order (executes immediately at current price). System enforces risk caps.",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Market symbol" },
            side: { type: "string", enum: ["LONG", "SHORT"] },
            amount: { type: "number", description: "Dollar amount to allocate (system will cap to policy)" },
          },
          required: ["symbol", "side", "amount"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "limitOrder",
        description: "Place a LIMIT order at a specific price. Executes only when price reaches target.",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Market symbol" },
            side: { type: "string", enum: ["LONG", "SHORT"] },
            amount: { type: "number", description: "Dollar amount to allocate" },
            price: { type: "number", description: "Target price for the limit order" },
          },
          required: ["symbol", "side", "amount", "price"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "closePosition",
        description: "Close a SPECIFIC position by symbol.",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Symbol of the position to close" },
          },
          required: ["symbol"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "closeAllPositions",
        description: "Close ALL open positions at once.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "setStopLoss",
        description: "Override the auto-placed stop-loss with a tighter level. Use only with a specific reason.",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Symbol of the position" },
            triggerPrice: { type: "number", description: "Price at which stop-loss triggers" },
          },
          required: ["symbol", "triggerPrice"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "setTakeProfit",
        description: "Set a take-profit order to lock in gains.",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Symbol of the position" },
            triggerPrice: { type: "number", description: "Price at which take-profit triggers" },
          },
          required: ["symbol", "triggerPrice"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "notifyTelegram",
        description: "Send a concise alert to Telegram (PnL, halts, questions). Use sparingly.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title" },
            message: { type: "string", description: "Main message content" },
          },
          required: ["title", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "notifyTelegram",
        description: "Send a concise alert to Telegram (PnL, halts, questions). Use sparingly.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title" },
            message: { type: "string", description: "Main message content" },
          },
          required: ["title", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "setStrategy",
        description: "Change the active regime. Use this when market conditions shift and your posture must shift with them (e.g. rising drawdown → defensive; strong breadth + trend → aggressive; uncertain regime → cash). The regime persists across cycles until you change it again. ALWAYS include a one-sentence reason in note.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: STRATEGY_MODES,
              description: "aggressive | balanced | defensive | cash",
            },
            bias: {
              type: "string",
              enum: STRATEGY_BIASES,
              description: "Directional tilt for new entries",
            },
            riskTier: {
              type: "string",
              enum: STRATEGY_TIERS,
              description: "low scales caps 0.5x, normal = 1x, high = unchanged (still hard-capped by policy)",
            },
            note: {
              type: "string",
              description: "Short sentence explaining why the regime is changing. Required.",
            },
          },
          required: ["mode", "bias", "riskTier", "note"],
        },
      },
    },
  ];

  mark("prompt-built");
  const choice = await callLLMChat(account.modelName, [{ role: "user", content: enrichedPrompt }], tools);
  mark("llm-call");
  let responseText = choice.message.content ?? "";
  const llmDuration = choice.durationMs ?? 0;

  const seenInCycle = new Set<string>();

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const fn = tc.function.name;
      const validation = validateToolArgs(fn, tc.function.arguments, validSymbols);
      if (!validation.ok) {
        responseText += ` [REJECTED ${fn}: ${validation.reason}]`;
        await prisma.toolCalls.create({
          data: {
            invocationId: modelInvocation.id,
            toolCallType: ToolCallType.REJECTED,
            metadata: JSON.stringify({ type: fn, reason: validation.reason, raw: tc.function.arguments.slice(0, 200) }),
          },
        });
        continue;
      }
      const args = validation.args;

      try {
        if (fn === "createPosition") {
          const symbol = args.symbol!;
          const side = args.side!;
          const indicators = indicatorBySymbol.get(symbol);
          const lastPrice = indicators?.lastPrice ?? (await getLatestPrice(MARKETS[symbol as keyof typeof MARKETS].marketId));
      const lastAtr = indicators?.atr14[indicators.atr14.length - 1] ?? 0;
      const lastAdx = indicators?.adx14[indicators.adx14.length - 1] ?? 0;
      const lastRsi = indicators?.rsi[indicators.rsi.length - 1] ?? 50;
      const leverage = MARKET_LEVERAGE[symbol] ?? 5;

          const decision = riskCheck({
            symbol,
            side,
            requestedAmount: args.amount!,
            leverage,
            lastPrice,
            atr: lastAtr,
            adx: lastAdx,
            rsi: lastRsi,
            equity,
            availableCash,
            openPositions: openPositions ?? [],
            seenInCycle,
            minRR: MIN_RR,
          });

          if (!decision.approved) {
            responseText += ` [REJECTED createPosition ${symbol}: ${decision.reason}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.REJECTED,
                metadata: JSON.stringify({ type: "createPosition", symbol, side, requested: args.amount, reason: decision.reason }),
              },
            });
            continue;
          }

          if (DRY_RUN || !ENABLE_TRADING) {
            responseText += ` [DRY_RUN MARKET ${side} ${symbol} $${decision.approvedAmount} @${leverage}x SL=${decision.stopPrice}${decision.minTakeProfit ? ", min-TP @ " + decision.minTakeProfit.toFixed(4) : ""}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.CREATE_POSITION,
                metadata: JSON.stringify({
                  symbol, side,
                  quantity: decision.approvedQuantity,
                  amount: decision.approvedAmount,
                  requested: args.amount,
                  capped: decision.capped,
                  stopPrice: decision.stopPrice,
                  type: "market",
                  dryRun: true,
                  minTakeProfit: decision.minTakeProfit,
                }),
              },
            });
            seenInCycle.add(symbol);
            continue;
          }

          await createPosition(account, symbol, side, decision.approvedQuantity);
          const slResult = await placeAutoStopLoss(symbol, side, decision.approvedQuantity, decision.stopPrice);
          if (!slResult.ok) {
            // SL failed → emergency close so we never hold unprotected
            console.error(`Auto-SL failed for ${symbol}: ${slResult.error}. Closing position.`);
            try {
              const market = MARKETS[symbol as keyof typeof MARKETS];
              const closeSide = side === "LONG" ? "SHORT" : "LONG";
              const isAsk = closeSide === "SHORT";
              const baseAmount = Math.abs(Math.round(decision.approvedQuantity * market.qtyDecimals));
              const closePrice = Math.round((side === "LONG" ? lastPrice * 0.99 : lastPrice * 1.01) * market.priceDecimals);
              await runTradePy([
                "close_position",
                String(market.marketId),
                String(market.clientOrderIndex),
                String(baseAmount),
                String(closePrice),
                String(isAsk),
              ]);
              responseText += ` [EMERGENCY CLOSE ${symbol}: SL failed "${slResult.error}"]`;
            } catch (closeErr) {
              responseText += ` [CRITICAL ${symbol}: SL AND close failed — ${(closeErr as Error).message}]`;
            }
            try {
              await prisma.riskHaltEvent.create({
                data: {
                  modelId: account.id,
                  type: HaltType.MANUAL,
                  clearsAt: new Date(Date.now() + RISK.SL_FAILURE_HALT_HOURS * 60 * 60 * 1000),
                  payload: JSON.stringify({ symbol, reason: slResult.error ?? "auto SL failed" }),
                },
              });
              responseText += ` [HALT ${RISK.SL_FAILURE_HALT_HOURS}h: auto-SL failed]`;
            } catch (haltErr) {
              console.error("Failed to record halt after SL failure:", (haltErr as Error).message);
            }
          } else {
            responseText += ` [MARKET ${side} ${symbol} $${decision.approvedAmount}${decision.capped ? " (CAPPED)" : ""} @${leverage}x, auto-SL @ ${decision.stopPrice.toFixed(4)}${decision.minTakeProfit ? ", min-TP @ " + decision.minTakeProfit.toFixed(4) : ""}]`;
          }
      await prisma.toolCalls.create({
        data: {
          invocationId: modelInvocation.id,
          toolCallType: ToolCallType.CREATE_POSITION,
          metadata: JSON.stringify({
            symbol, side,
            quantity: decision.approvedQuantity,
            amount: decision.approvedAmount,
            requested: args.amount,
            capped: decision.capped,
            stopPrice: decision.stopPrice,
            autoSlOk: slResult.ok,
            type: "market",
            minTakeProfit: decision.minTakeProfit,
          }),
        },
      });
          if (!DRY_RUN && slResult.ok && decision.minTakeProfit) {
            const last = lastTelegramAt[account.id] ?? 0;
            if (Date.now() - last > TELEGRAM_NOTIFY_COOLDOWN_MS) {
              lastTelegramAt[account.id] = Date.now();
              void sendTelegramAlert(
                `New position opened (${account.name})`,
                [
                  `${side} ${symbol} amount=$${decision.approvedAmount.toFixed(2)}${decision.capped ? " (capped)" : ""}`,
                  `auto SL @ ${decision.stopPrice.toFixed(4)} | min TP @ ${decision.minTakeProfit.toFixed(4)}`,
                ],
              );
            }
          }
          if (slResult.ok) {
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.SET_SL,
                metadata: JSON.stringify({ symbol, triggerPrice: decision.stopPrice, source: "auto" }),
              },
            });
          }
          seenInCycle.add(symbol);

        } else if (fn === "limitOrder") {
          const symbol = args.symbol!;
          const side = args.side!;
          const market = MARKETS[symbol as keyof typeof MARKETS];
          const indicators = indicatorBySymbol.get(symbol);
          const lastAtr = indicators?.atr14[indicators.atr14.length - 1] ?? 0;
          const lastAdx = indicators?.adx14[indicators.adx14.length - 1] ?? 0;
          const lastRsi = indicators?.rsi[indicators.rsi.length - 1] ?? 50;
          const leverage = MARKET_LEVERAGE[symbol] ?? 5;

          const decision = riskCheck({
            symbol,
            side,
            requestedAmount: args.amount!,
            leverage,
            lastPrice: args.price!,
            atr: lastAtr,
            adx: lastAdx,
            rsi: lastRsi,
            equity,
            availableCash,
            openPositions: openPositions ?? [],
            seenInCycle,
            minRR: MIN_RR,
          });

          if (!decision.approved) {
            responseText += ` [REJECTED limitOrder ${symbol}: ${decision.reason}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.REJECTED,
                metadata: JSON.stringify({ type: "limitOrder", symbol, side, requested: args.amount, reason: decision.reason }),
              },
            });
            continue;
          }

          if (DRY_RUN || !ENABLE_TRADING) {
            responseText += ` [DRY_RUN LIMIT ${side} ${symbol} $${decision.approvedAmount} @ $${args.price}${decision.minTakeProfit ? ", min-TP @ " + decision.minTakeProfit.toFixed(4) : ""}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.CREATE_POSITION,
                metadata: JSON.stringify({
                  symbol, side,
                  quantity: decision.approvedQuantity,
                  amount: decision.approvedAmount,
                  requested: args.amount,
                  capped: decision.capped,
                  price: args.price,
                  type: "limit",
                  dryRun: true,
                  minTakeProfit: decision.minTakeProfit,
                }),
              },
            });
            seenInCycle.add(symbol);
            continue;
          }

          const limitPrice = Math.round((args.price ?? 0) * market.priceDecimals);
          const baseAmount = Math.round(decision.approvedQuantity * market.qtyDecimals);
          const isAsk = side === "SHORT";
          const result = await runTradePy([
            "limit_order",
            String(market.marketId),
            String(market.clientOrderIndex),
            String(baseAmount),
            String(limitPrice),
            String(isAsk),
          ]);
          const parsed = JSON.parse(result) as { error?: string };
          if (parsed.error) throw new Error(parsed.error);
           await prisma.toolCalls.create({
             data: {
               invocationId: modelInvocation.id,
               toolCallType: ToolCallType.CREATE_POSITION,
               metadata: JSON.stringify({
                 symbol, side,
                 quantity: decision.approvedQuantity,
                 amount: decision.approvedAmount,
                 requested: args.amount,
                 capped: decision.capped,
                 price: args.price,
                 type: "limit",
                 minTakeProfit: decision.minTakeProfit,
               }),
             },
           });
           responseText += ` [LIMIT ${side} ${symbol} $${decision.approvedAmount}${decision.capped ? " (CAPPED)" : ""} @ $${args.price}${decision.minTakeProfit ? ", min-TP @ " + decision.minTakeProfit.toFixed(4) : ""}]`;
           seenInCycle.add(symbol);

        } else if (fn === "closePosition") {
          const symbol = args.symbol!;
          const pos = openPositions?.find(p => p.symbol === symbol);
          if (!pos || Number(pos.position) === 0) {
            responseText += ` [No open position for ${symbol}]`;
            continue;
          }
          if (DRY_RUN) {
            responseText += ` [DRY_RUN CLOSE ${symbol}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.CLOSE_POSITION,
                metadata: JSON.stringify({ symbol, dryRun: true }),
              },
            });
            continue;
          }
          const market = MARKETS[symbol as keyof typeof MARKETS];
          const latestPrice = await getLatestPrice(market.marketId);
          const closeSide = pos.sign === "LONG" ? "SHORT" : "LONG";
          const isAsk = closeSide === "SHORT";
          const baseAmount = Math.abs(Math.round(Number(pos.position) * market.qtyDecimals));
          const price = Math.round(
            (closeSide === "LONG" ? latestPrice * 1.01 : latestPrice * 0.99) * market.priceDecimals,
          );
          const result = await runTradePy([
            "close_position",
            String(market.marketId),
            String(market.clientOrderIndex),
            String(baseAmount),
            String(price),
            String(isAsk),
          ]);
          const parsed = JSON.parse(result) as { error?: string };
          if (parsed.error) throw new Error(parsed.error);
          await prisma.toolCalls.create({
            data: {
              invocationId: modelInvocation.id,
              toolCallType: ToolCallType.CLOSE_POSITION,
              metadata: JSON.stringify({ symbol }),
            },
          });
          responseText += ` [CLOSED ${symbol}]`;

        } else if (fn === "closeAllPositions") {
          if (DRY_RUN) {
            responseText += ` [DRY_RUN CLOSE ALL]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.CLOSE_POSITION,
                metadata: JSON.stringify({ type: "close_all", dryRun: true }),
              },
            });
            continue;
          }
          await cancelAllOrders(account);
          await prisma.toolCalls.create({
            data: {
              invocationId: modelInvocation.id,
              toolCallType: ToolCallType.CLOSE_POSITION,
              metadata: JSON.stringify({ type: "close_all" }),
            },
          });
          responseText += " [CLOSED ALL]";

        } else if (fn === "setStopLoss" || fn === "setTakeProfit") {
          const symbol = args.symbol!;
          const pos = openPositions?.find(p => p.symbol === symbol);
          if (!pos || Number(pos.position) === 0) {
            responseText += ` [No open position for ${symbol} to set ${fn}]`;
            continue;
          }
          if (DRY_RUN) {
            responseText += ` [DRY_RUN ${fn === "setStopLoss" ? "SL" : "TP"} ${symbol} @ $${args.triggerPrice}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: fn === "setStopLoss" ? ToolCallType.SET_SL : ToolCallType.SET_TP,
                metadata: JSON.stringify({ symbol, triggerPrice: args.triggerPrice, dryRun: true }),
              },
            });
            continue;
          }
          const market = MARKETS[symbol as keyof typeof MARKETS];
          const triggerPriceInt = Math.round((args.triggerPrice ?? 0) * market.priceDecimals);
          const slippage = fn === "setStopLoss" ? 0.98 : 1.02;
          const execPriceInt = Math.round((args.triggerPrice ?? 0) * slippage * market.priceDecimals);
          const baseAmount = Math.abs(Math.round(Number(pos.position) * market.qtyDecimals));
          const isAsk = pos.sign === "LONG";
          const action = fn === "setStopLoss" ? "stop_loss" : "take_profit";
          const result = await runTradePy([
            action,
            String(market.marketId),
            String(market.clientOrderIndex),
            String(baseAmount),
            String(triggerPriceInt),
            String(execPriceInt),
            String(isAsk),
          ]);
          const parsed = JSON.parse(result) as { error?: string };
          if (parsed.error) throw new Error(parsed.error);
          await prisma.toolCalls.create({
            data: {
              invocationId: modelInvocation.id,
              toolCallType: fn === "setStopLoss" ? ToolCallType.SET_SL : ToolCallType.SET_TP,
              metadata: JSON.stringify({ symbol, type: action, triggerPrice: args.triggerPrice, source: "llm" }),
            },
          });
          responseText += ` [${action.toUpperCase()} ${symbol} @ $${args.triggerPrice}]`;

        } else if (fn === "notifyTelegram") {
          const [title, message] = (args.note ?? "|").split("|", 2);
          const last = lastTelegramAt[account.id] ?? 0;
          if (Date.now() - last < TELEGRAM_NOTIFY_COOLDOWN_MS) {
            responseText += " [REJECTED notifyTelegram: cooldown]";
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.REJECTED,
                metadata: JSON.stringify({ type: "notifyTelegram", reason: "cooldown" }),
              },
            });
            continue;
          }
          lastTelegramAt[account.id] = Date.now();
          void sendTelegramAlert(title || "Alert", [message || "(empty)"]);
          responseText += " [NOTIFIED TELEGRAM]";
          await prisma.toolCalls.create({
            data: {
              invocationId: modelInvocation.id,
              toolCallType: ToolCallType.NOTIFY,
              metadata: JSON.stringify({ title, message }),
            },
          });

        } else if (fn === "setStrategy") {
          const stratValidation = validateStrategyArgs(tc.function.arguments);
          if (!stratValidation.ok) {
            responseText += ` [REJECTED setStrategy: ${stratValidation.reason}]`;
            await prisma.toolCalls.create({
              data: {
                invocationId: modelInvocation.id,
                toolCallType: ToolCallType.REJECTED,
                metadata: JSON.stringify({ type: "setStrategy", reason: stratValidation.reason }),
              },
            });
            continue;
          }
          const next: StrategyState = {
            mode: stratValidation.args.mode!,
            bias: stratValidation.args.bias!,
            riskTier: stratValidation.args.riskTier!,
            note: stratValidation.args.note!,
          };
          await prisma.models.update({
            where: { id: account.id },
            data: { strategyState: JSON.stringify(next) },
          });
          await prisma.toolCalls.create({
            data: {
              invocationId: modelInvocation.id,
              toolCallType: ToolCallType.SET_STRATEGY,
              metadata: JSON.stringify(next),
            },
          });
          responseText += ` [STRATEGY mode=${next.mode} bias=${next.bias} riskTier=${next.riskTier} note="${next.note}"]`;
        }
      } catch (err) {
        responseText += ` [ERROR ${fn}: ${(err as Error).message}]`;
        console.error(`Tool ${fn} failed:`, (err as Error).message);
      }
    }
  }

  mark("tools-executed");
  console.log("AI response:", responseText);

  await prisma.models.update({
    where: { id: account.id },
    data: { invocationCount: { increment: 1 } },
  });
  await prisma.invocations.update({
    where: { id: modelInvocation.id },
    data: {
      response: responseText.trim(),
      llmDurationMs: llmDuration,
    },
  });
  mark("total");
  return responseText;
};

async function main() {
    console.log(`[${new Date().toLocaleTimeString()}] Starting trading cycle... (DRY_RUN=${DRY_RUN ? "1" : "0"})`);
    const models = await prisma.models.findMany();

    for (const model of models) {
        try {
            const account: Account = {
                apiKey: model.lighterApiKey,
                modelName: model.openRoutermodelName,
                name: model.name,
                invocationCount: model.invocationCount,
                id: model.id,
                accountIndex: model.accountIndex,
            };
            await invokeAgent(account);

            const portfolio = await getPortfolio(account);
            await prisma.portfolioSize.create({
                data: {
                    modelId: model.id,
                    netPortfolio: portfolio.total,
                },
            });
            console.log(`[${new Date().toLocaleTimeString()}] Portfolio: $${portfolio.total}`);
        } catch (err) {
            console.error(`[${new Date().toLocaleTimeString()}] Error for ${model.name}:`, (err as Error).message);
        }
    }
    console.log(`[${new Date().toLocaleTimeString()}] Cycle complete.\n`);
}

// Align to the next 5-minute candle close (+ buffer). Then fire every 5 min.
// This ensures indicators are computed on closed candles, not half-formed ones.
function scheduleAligned() {
  const now = Date.now();
  const msIntoCandle = now % LOOP_INTERVAL_MS;
  const msUntilNext = (LOOP_INTERVAL_MS - msIntoCandle) + LOOP_ALIGN_BUFFER_MS;
  console.log(`Aligning to next candle close in ${(msUntilNext / 1000).toFixed(1)}s`);
  setTimeout(() => {
    main().catch((err) => console.error("main error:", (err as Error).message));
    setInterval(() => {
      main().catch((err) => console.error("main error:", (err as Error).message));
    }, LOOP_INTERVAL_MS);
  }, msUntilNext);
}

// Kick off one cycle immediately so we don't wait up to 5 minutes on cold start,
// then schedule the aligned interval.
main().catch((err) => console.error("main error:", (err as Error).message));
scheduleAligned();

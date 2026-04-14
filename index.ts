import { execSync } from 'child_process';
import { PROMPT } from './prompt';
import { type Account } from './accounts';
import { getIndicators, type IndicatorResult } from './stockData';
import { getOpenPositions } from './openPositions';
import { MARKETS } from './markets';
import { createPosition } from './createPosition';
import { cancelAllOrders } from './cancelOrder';
import { PrismaClient, ToolCallType, HaltType } from './generated/prisma/client';
import { getPortfolio } from './getPortfolio';
import { getAuthToken, fetchH2 } from './auth';
import {
  BASE_URL,
  DRY_RUN,
  ENABLE_TRADING,
  LOOP_INTERVAL_MS,
  LOOP_ALIGN_BUFFER_MS,
  LLM_CONFIG,
  RISK,
} from './config';

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

const prisma = new PrismaClient();

interface ChatMessage { role: string; content: string }
interface ToolCall { id: string; type: string; function: { name: string; arguments: string } }
interface ChatChoice { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }

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

// Native Bun fetch with retry + backoff. Replaces the curl-with-tmpfile hack:
// removes a file-system race condition between concurrent cycles and gives us
// real HTTP error handling.
async function callDOChat(
  model: string,
  messages: ChatMessage[],
  tools: object[],
): Promise<ChatChoice> {
  const body = JSON.stringify({
    model,
    messages,
    tools,
    max_completion_tokens: LLM_CONFIG.MAX_COMPLETION_TOKENS,
    temperature: LLM_CONFIG.TEMPERATURE,
    tool_choice: "auto",
  });

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < LLM_CONFIG.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), LLM_CONFIG.TIMEOUT_MS);
    try {
      const response = await fetch("https://inference.do-ai.run/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env['DO_MODEL_ACCESS_KEY'] ?? ""}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`DO API ${response.status}: ${text.slice(0, 300)}`);
      }

      const data = (await response.json()) as {
        choices?: ChatChoice[];
        error?: { message: string };
      };
      if (data.error) throw new Error(data.error.message);
      const first = data.choices?.[0];
      if (!first) throw new Error("no choices in DO response");
      return first;
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
    `DO API failed after ${LLM_CONFIG.MAX_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`,
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
  equity: number;
  availableCash: number;
  openPositions: Array<{ symbol: string; position: string; sign: string }>;
  seenInCycle: Set<string>;
}

interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  capped: boolean;
  approvedAmount: number;
  approvedQuantity: number;
  atrStopDistance: number;
  stopPrice: number;
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
  const execPrice = side === "LONG" ? stopPrice * 0.98 : stopPrice * 1.02;
  const execPriceInt = Math.round(execPrice * market.priceDecimals);
  const baseAmount = Math.abs(Math.round(quantity * market.qtyDecimals));

  try {
    const result = execSync(
      `python3 trade.py stop_loss ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${triggerPriceInt} ${execPriceInt} ${isAsk}`,
      { cwd: import.meta.dir, env: process.env },
    )
      .toString()
      .trim();
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

  return { ok: false, reason: `unknown tool ${fn}` };
}

// --- Main agent loop ---

export const invokeAgent = async (account: Account) => {
  const portfolio = await getPortfolio(account);
  const equity = Number(portfolio.total);
  const availableCash = Number(portfolio.available);

  // Halt check first — do not waste LLM budget on a halted account.
  const breaker = await checkCircuitBreakers(account.id, equity);
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

  let ALL_INDICATOR_DATA = "";
  let MARKETS_INFO = "";
  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  // Keep per-symbol 5m indicators around so the risk engine can read ATR at open time.
  const indicatorBySymbol = new Map<string, IndicatorResult>();

  await Promise.all(marketSlugs.map(async (marketSlug) => {
    const intradayIndicators = await getIndicators("5m", MARKETS[marketSlug].marketId);
    const longTermIndicators = await getIndicators("4h", MARKETS[marketSlug].marketId);
    indicatorBySymbol.set(marketSlug, intradayIndicators);
    const leverage = MARKET_LEVERAGE[marketSlug] ?? 10;
    const lastPrice = intradayIndicators.lastPrice;
    const lastRsi = intradayIndicators.rsi[intradayIndicators.rsi.length - 1] ?? 0;
    const lastAtr = intradayIndicators.atr14[intradayIndicators.atr14.length - 1] ?? 0;
    const lastAdx = intradayIndicators.adx14[intradayIndicators.adx14.length - 1] ?? 0;
    MARKETS_INFO += `${marketSlug}: $${lastPrice} | ${leverage}x | RSI ${lastRsi} | ATR ${lastAtr.toFixed(4)} (${(intradayIndicators.atrPct * 100).toFixed(2)}%) | ADX ${lastAdx.toFixed(1)}\n`;

    ALL_INDICATOR_DATA += `
    MARKET - ${marketSlug}
    Intraday (5m candles) (oldest → latest):
    Mid prices - [${intradayIndicators.midPrices.join(",")}]
    EMA20 - [${intradayIndicators.ema20s.join(",")}]
    MACD - [${intradayIndicators.macd.join(",")}]
    RSI - [${intradayIndicators.rsi.join(",")}]
    ATR14 - [${intradayIndicators.atr14.join(",")}]
    ADX14 - [${intradayIndicators.adx14.join(",")}]
    Bollinger Upper - [${intradayIndicators.bollingerBands.upper.join(",")}]
    Bollinger Middle - [${intradayIndicators.bollingerBands.middle.join(",")}]
    Bollinger Lower - [${intradayIndicators.bollingerBands.lower.join(",")}]

    Long Term (4h candles) (oldest → latest):
    Mid prices - [${longTermIndicators.midPrices.join(",")}]
    EMA20 - [${longTermIndicators.ema20s.join(",")}]
    MACD - [${longTermIndicators.macd.join(",")}]
    RSI - [${longTermIndicators.rsi.join(",")}]
    ATR14 - [${longTermIndicators.atr14.join(",")}]
    ADX14 - [${longTermIndicators.adx14.join(",")}]
    Bollinger Upper - [${longTermIndicators.bollingerBands.upper.join(",")}]
    Bollinger Middle - [${longTermIndicators.bollingerBands.middle.join(",")}]
    Bollinger Lower - [${longTermIndicators.bollingerBands.lower.join(",")}]

    `;
  }));

  const openPositions = await getOpenPositions(account.apiKey, account.accountIndex);
  const modelInvocation = await prisma.invocations.create({
    data: { modelId: account.id, response: "" },
  });

  const recentInvocations = await prisma.invocations.findMany({
    where: { modelId: account.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { toolCalls: true },
  });
  const tradeHistory = recentInvocations.length === 0
    ? "No previous trades."
    : recentInvocations
        .reverse()
        .map((inv) => {
          const actions = inv.toolCalls.length === 0
            ? "No action taken"
            : inv.toolCalls.map((tc) => {
                try {
                  const meta = JSON.parse(tc.metadata) as {
                    symbol?: string;
                    side?: string;
                    amount?: number;
                    requested?: number;
                    reason?: string;
                    type?: string;
                  };
                  if (tc.toolCallType === "CREATE_POSITION") {
                    return `Opened ${meta.side ?? "?"} ${meta.symbol ?? "?"} $${meta.amount ?? "?"}`;
                  }
                  if (tc.toolCallType === "CLOSE_POSITION") {
                    return `Closed ${meta.symbol ?? "all"}`;
                  }
                  if (tc.toolCallType === "SET_SL") return `SL ${meta.symbol ?? "?"}`;
                  if (tc.toolCallType === "SET_TP") return `TP ${meta.symbol ?? "?"}`;
                  if (tc.toolCallType === "HALT") return `HALT (${meta.reason ?? "?"})`;
                  if (tc.toolCallType === "REJECTED") return `REJECTED ${meta.type ?? "?"} ${meta.symbol ?? ""}: ${meta.reason ?? ""}`;
                  return tc.toolCallType;
                } catch {
                  return tc.toolCallType;
                }
              }).join("; ");
          const timestamp = inv.createdAt.toISOString().slice(0, 16).replace("T", " ");
          const summary = inv.response.length > 160 ? inv.response.slice(0, 160) + "..." : inv.response;
          return `[${timestamp}] ${actions} | ${summary}`;
        })
        .join("\n");

  const enrichedPrompt = PROMPT
    .replace("{{INVOKATION_TIMES}}", account.invocationCount.toString())
    .replace("{{OPEN_POSITIONS}}", openPositions?.map((position) => `${position.symbol} ${position.position} ${position.sign}`).join(", ") ?? "")
    .replace("{{PORTFOLIO_VALUE}}", portfolio.total)
    .replace("{{ALL_INDICATOR_DATA}}", ALL_INDICATOR_DATA)
    .replace("{{AVAILABLE_CASH}}", portfolio.available)
    .replace("{{CURRENT_ACCOUNT_VALUE}}", portfolio.total)
    .replace("{{CURRENT_ACCOUNT_POSITIONS}}", JSON.stringify(openPositions))
    .replace("{{TRADE_HISTORY}}", tradeHistory)
    .replace("{{MARKETS_INFO}}", MARKETS_INFO.trim());

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
  ];

  const choice = await callDOChat(account.modelName, [{ role: "user", content: enrichedPrompt }], tools);
  let responseText = choice.message.content ?? "";

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
          const lastPrice = indicators?.lastPrice ?? getLatestPrice(MARKETS[symbol as keyof typeof MARKETS].marketId);
          const lastAtr = indicators?.atr14[indicators.atr14.length - 1] ?? 0;
          const leverage = MARKET_LEVERAGE[symbol] ?? 5;

          const decision = riskCheck({
            symbol,
            side,
            requestedAmount: args.amount!,
            leverage,
            lastPrice,
            atr: lastAtr,
            equity,
            availableCash,
            openPositions: openPositions ?? [],
            seenInCycle,
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
            responseText += ` [DRY_RUN MARKET ${side} ${symbol} $${decision.approvedAmount} @${leverage}x SL=${decision.stopPrice}]`;
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
              execSync(
                `python3 trade.py close_position ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${closePrice} ${isAsk}`,
                { cwd: import.meta.dir, env: process.env },
              );
              responseText += ` [EMERGENCY CLOSE ${symbol}: SL failed "${slResult.error}"]`;
            } catch (closeErr) {
              responseText += ` [CRITICAL ${symbol}: SL AND close failed — ${(closeErr as Error).message}]`;
            }
          } else {
            responseText += ` [MARKET ${side} ${symbol} $${decision.approvedAmount}${decision.capped ? " (CAPPED)" : ""} @${leverage}x, auto-SL @ ${decision.stopPrice.toFixed(4)}]`;
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
              }),
            },
          });
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
          const leverage = MARKET_LEVERAGE[symbol] ?? 5;

          const decision = riskCheck({
            symbol,
            side,
            requestedAmount: args.amount!,
            leverage,
            lastPrice: args.price!,
            atr: lastAtr,
            equity,
            availableCash,
            openPositions: openPositions ?? [],
            seenInCycle,
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
            responseText += ` [DRY_RUN LIMIT ${side} ${symbol} $${decision.approvedAmount} @ $${args.price}]`;
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
                }),
              },
            });
            seenInCycle.add(symbol);
            continue;
          }

          const limitPrice = Math.round((args.price ?? 0) * market.priceDecimals);
          const baseAmount = Math.round(decision.approvedQuantity * market.qtyDecimals);
          const isAsk = side === "SHORT";
          const result = execSync(
            `python3 trade.py limit_order ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${limitPrice} ${isAsk}`,
            { cwd: import.meta.dir, env: process.env },
          ).toString().trim();
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
              }),
            },
          });
          responseText += ` [LIMIT ${side} ${symbol} $${decision.approvedAmount}${decision.capped ? " (CAPPED)" : ""} @ $${args.price}]`;
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
          const latestPrice = getLatestPrice(market.marketId);
          const closeSide = pos.sign === "LONG" ? "SHORT" : "LONG";
          const isAsk = closeSide === "SHORT";
          const baseAmount = Math.abs(Math.round(Number(pos.position) * market.qtyDecimals));
          const price = Math.round(
            (closeSide === "LONG" ? latestPrice * 1.01 : latestPrice * 0.99) * market.priceDecimals,
          );
          const result = execSync(
            `python3 trade.py close_position ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${price} ${isAsk}`,
            { cwd: import.meta.dir, env: process.env },
          ).toString().trim();
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
          const result = execSync(
            `python3 trade.py ${action} ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${triggerPriceInt} ${execPriceInt} ${isAsk}`,
            { cwd: import.meta.dir, env: process.env },
          ).toString().trim();
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
        }
      } catch (err) {
        responseText += ` [ERROR ${fn}: ${(err as Error).message}]`;
        console.error(`Tool ${fn} failed:`, (err as Error).message);
      }
    }
  }

  console.log("AI response:", responseText);

  await prisma.models.update({
    where: { id: account.id },
    data: { invocationCount: { increment: 1 } },
  });
  await prisma.invocations.update({
    where: { id: modelInvocation.id },
    data: { response: responseText.trim() },
  });
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

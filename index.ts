import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { PROMPT } from './prompt';
import { type Account } from './accounts';
import { getIndicators } from './stockData';
import { getOpenPositions } from './openPositions';
import { MARKETS } from './markets';
import { createPosition } from './createPosition';
import { cancelAllOrders } from './cancelOrder';
import { PrismaClient, ToolCallType } from './generated/prisma/client';
import { getPortfolio } from './getPortfolio';
import { getAuthToken, fetchH2 } from './auth';

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

function callDOChat(model: string, messages: ChatMessage[], tools: object[]): ChatChoice {
  const body = JSON.stringify({ model, messages, tools, max_completion_tokens: 4096 });
  const tmpFile = "/tmp/tradio-request.json";
  writeFileSync(tmpFile, body);
  const resp = execSync(
    `curl -s --http2 --max-time 120 -X POST "https://inference.do-ai.run/v1/chat/completions" -H "Authorization: Bearer ${process.env['DO_MODEL_ACCESS_KEY']}" -H "Content-Type: application/json" -d @${tmpFile}`,
  ).toString();
  try { unlinkSync(tmpFile); } catch {}
  const data = JSON.parse(resp) as { choices: ChatChoice[]; error?: { message: string } };
  if (data.error) throw new Error(`DO API error: ${data.error.message}`);
  return data.choices[0]!;
}

export const invokeAgent = async (account: Account) => {

  let ALL_INDICATOR_DATA = "";
  let MARKETS_INFO = "";
  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  await Promise.all(marketSlugs.map(async (marketSlug) => {
    const intradayIndicators = await getIndicators("5m", MARKETS[marketSlug].marketId);
    const longTermIndicators = await getIndicators("4h", MARKETS[marketSlug].marketId);
    const leverage = MARKET_LEVERAGE[marketSlug] ?? 10;
    const lastPrice = intradayIndicators.midPrices[intradayIndicators.midPrices.length - 1] ?? 0;
    const lastRsi = intradayIndicators.rsi[intradayIndicators.rsi.length - 1] ?? 0;
    MARKETS_INFO += `${marketSlug}: $${lastPrice} | ${leverage}x leverage | RSI ${lastRsi}\n`;

    ALL_INDICATOR_DATA = ALL_INDICATOR_DATA + `
    MARKET - ${marketSlug}
    Intraday (5m candles) (oldest → latest):
    Mid prices - [${intradayIndicators.midPrices.join(",")}]
    EMA20 - [${intradayIndicators.ema20s.join(",")}]
    MACD - [${intradayIndicators.macd.join(",")}]
    RSI - [${intradayIndicators.rsi.join(",")}]
    Bollinger Upper - [${intradayIndicators.bollingerBands.upper.join(",")}]
    Bollinger Middle - [${intradayIndicators.bollingerBands.middle.join(",")}]
    Bollinger Lower - [${intradayIndicators.bollingerBands.lower.join(",")}]

    Long Term (4h candles) (oldest → latest):
    Mid prices - [${longTermIndicators.midPrices.join(",")}]
    EMA20 - [${longTermIndicators.ema20s.join(",")}]
    MACD - [${longTermIndicators.macd.join(",")}]
    RSI - [${longTermIndicators.rsi.join(",")}]
    Bollinger Upper - [${longTermIndicators.bollingerBands.upper.join(",")}]
    Bollinger Middle - [${longTermIndicators.bollingerBands.middle.join(",")}]
    Bollinger Lower - [${longTermIndicators.bollingerBands.lower.join(",")}]

    `
  }))
  
  const portfolio = await getPortfolio(account);

  const openPositions = await getOpenPositions(account.apiKey, account.accountIndex);
  const modelInvocation = await prisma.invocations.create({
    data: {
      modelId: account.id,
      response: "",
    },
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
                if (tc.toolCallType === "CREATE_POSITION" && tc.metadata) {
                  const meta = JSON.parse(tc.metadata) as { symbol: string; side: string; quantity: number };
                  return `Opened ${meta.side} ${meta.quantity} ${meta.symbol}`;
                }
                return "Closed all positions";
              }).join("; ");
          const timestamp = inv.createdAt.toISOString().slice(0, 16).replace("T", " ");
          const summary = inv.response.length > 120 ? inv.response.slice(0, 120) + "..." : inv.response;
          return `[${timestamp}] ${actions} | ${summary}`;
        })
        .join("\n");

  const enrichedPrompt = PROMPT.replace("{{INVOKATION_TIMES}}", account.invocationCount.toString())
  .replace("{{OPEN_POSITIONS}}", openPositions?.map((position) => `${position.symbol} ${position.position} ${position.sign}`).join(", ") ?? "")
  .replace("{{PORTFOLIO_VALUE}}", portfolio.total)
  .replace("{{ALL_INDICATOR_DATA}}", ALL_INDICATOR_DATA)
  .replace("{{AVAILABLE_CASH}}", portfolio.available)
  .replace("{{CURRENT_ACCOUNT_VALUE}}", portfolio.total)
  .replace("{{CURRENT_ACCOUNT_POSITIONS}}", JSON.stringify(openPositions))
  .replace("{{TRADE_HISTORY}}", tradeHistory)
  .replace("{{MARKETS_INFO}}", MARKETS_INFO.trim())

  console.log("Calling AI model:", account.modelName);

  const marketSymbols = Object.keys(MARKETS);
  const tools = [
    {
      type: "function",
      function: {
        name: "createPosition",
        description: "Open a MARKET order (executes immediately at current price)",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: marketSymbols, description: "Market symbol" },
            side: { type: "string", enum: ["LONG", "SHORT"] },
            amount: { type: "number", description: "Dollar amount to allocate (e.g. 20 = $20)" },
          },
          required: ["symbol", "side", "amount"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "limitOrder",
        description: "Place a LIMIT order at a specific price (executes only when price reaches target)",
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
        description: "Close a SPECIFIC position by symbol (not all positions)",
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
        description: "Close ALL open positions at once",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "setStopLoss",
        description: "Set a stop-loss order to limit downside. Triggers when price drops to triggerPrice.",
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
        description: "Set a take-profit order to lock in gains. Triggers when price reaches triggerPrice.",
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

  const choice = callDOChat(account.modelName, [{ role: "user", content: enrichedPrompt }], tools);
  let responseText = choice.message.content ?? "";

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const fn = tc.function.name;
      try {
        if (fn === "createPosition") {
          const side = args.side as "LONG" | "SHORT";
          const symbol = args.symbol as string;
          const amount = Math.min(args.amount ?? 10, parseFloat(portfolio.available));
          const leverage = MARKET_LEVERAGE[symbol] ?? 5;
          const quantity = Number((amount * leverage).toFixed(2));
          await createPosition(account, symbol, side, quantity);
          await prisma.toolCalls.create({
            data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CREATE_POSITION, metadata: JSON.stringify({ symbol, side, quantity, amount, type: "market" }) },
          });
          responseText += ` [MARKET ${side} ${symbol} $${amount} @ ${leverage}x]`;

        } else if (fn === "limitOrder") {
          const side = args.side as "LONG" | "SHORT";
          const symbol = args.symbol as string;
          const market = MARKETS[symbol as keyof typeof MARKETS];
          const amount = Math.min(args.amount ?? 10, parseFloat(portfolio.available));
          const leverage = MARKET_LEVERAGE[symbol] ?? 5;
          const quantity = Number((amount * leverage).toFixed(2));
          const limitPrice = Math.round(args.price * market.priceDecimals);
          const baseAmount = Math.round(quantity * market.qtyDecimals);
          const isAsk = side === "SHORT";
          const result = execSync(
            `python3 trade.py limit_order ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${limitPrice} ${isAsk}`,
            { cwd: import.meta.dir, env: process.env },
          ).toString().trim();
          const parsed = JSON.parse(result);
          if (parsed.error) throw new Error(parsed.error);
          await prisma.toolCalls.create({
            data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CREATE_POSITION, metadata: JSON.stringify({ symbol, side, quantity, amount, price: args.price, type: "limit" }) },
          });
          responseText += ` [LIMIT ${side} ${symbol} $${amount} @ $${args.price}]`;

        } else if (fn === "closePosition") {
          const symbol = args.symbol as string;
          const pos = openPositions?.find(p => p.symbol === symbol);
          if (pos && Number(pos.position) !== 0) {
            const market = MARKETS[symbol as keyof typeof MARKETS];
            const latestPrice = getLatestPrice(market.marketId);
            const closeSide = pos.sign === "LONG" ? "SHORT" : "LONG";
            const isAsk = closeSide === "SHORT";
            const baseAmount = Math.abs(Math.round(Number(pos.position) * market.qtyDecimals));
            const price = Math.round((closeSide === "LONG" ? latestPrice * 1.01 : latestPrice * 0.99) * market.priceDecimals);
            const result = execSync(
              `python3 trade.py close_position ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${price} ${isAsk}`,
              { cwd: import.meta.dir, env: process.env },
            ).toString().trim();
            const parsed = JSON.parse(result);
            if (parsed.error) throw new Error(parsed.error);
            await prisma.toolCalls.create({
              data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CLOSE_POSITION, metadata: JSON.stringify({ symbol }) },
            });
            responseText += ` [CLOSED ${symbol}]`;
          } else {
            responseText += ` [No open position for ${symbol}]`;
          }

        } else if (fn === "closeAllPositions") {
          await cancelAllOrders(account);
          await prisma.toolCalls.create({
            data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CLOSE_POSITION, metadata: JSON.stringify({ type: "close_all" }) },
          });
          responseText += " [CLOSED ALL]";

        } else if (fn === "setStopLoss" || fn === "setTakeProfit") {
          const symbol = args.symbol as string;
          const pos = openPositions?.find(p => p.symbol === symbol);
          if (pos && Number(pos.position) !== 0) {
            const market = MARKETS[symbol as keyof typeof MARKETS];
            const triggerPrice = Math.round(args.triggerPrice * market.priceDecimals);
            const slippage = fn === "setStopLoss" ? 0.98 : 1.02;
            const execPrice = Math.round(args.triggerPrice * slippage * market.priceDecimals);
            const baseAmount = Math.abs(Math.round(Number(pos.position) * market.qtyDecimals));
            const isAsk = pos.sign === "LONG";
            const action = fn === "setStopLoss" ? "stop_loss" : "take_profit";
            const result = execSync(
              `python3 trade.py ${action} ${market.marketId} ${market.clientOrderIndex} ${baseAmount} ${triggerPrice} ${execPrice} ${isAsk}`,
              { cwd: import.meta.dir, env: process.env },
            ).toString().trim();
            const parsed = JSON.parse(result);
            if (parsed.error) throw new Error(parsed.error);
            await prisma.toolCalls.create({
              data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CREATE_POSITION, metadata: JSON.stringify({ symbol, type: action, triggerPrice: args.triggerPrice }) },
            });
            responseText += ` [${action.toUpperCase()} ${symbol} @ $${args.triggerPrice}]`;
          } else {
            responseText += ` [No open position for ${symbol} to set ${fn}]`;
          }
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
    console.log(`[${new Date().toLocaleTimeString()}] Starting trading cycle...`);
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
    console.log(`[${new Date().toLocaleTimeString()}] Cycle complete. Next in 2 min.\n`);
}

setInterval(() => { main(); }, 1000 * 60 * 2);
main();
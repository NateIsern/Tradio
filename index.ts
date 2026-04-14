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
const prisma = new PrismaClient();

interface ChatMessage { role: string; content: string }
interface ToolCall { id: string; type: string; function: { name: string; arguments: string } }
interface ChatChoice { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }

const MARKET_LEVERAGE: Record<string, number> = {
  ZEC: 5,
  HYPE: 10,
  SOL: 10,
};

function callDOChat(model: string, messages: ChatMessage[], tools: object[]): ChatChoice {
  const body = JSON.stringify({ model, messages, tools, max_completion_tokens: 2048 });
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
  const marketSlugs = Object.keys(MARKETS) as Array<keyof typeof MARKETS>;
  await Promise.all(marketSlugs.map(async (marketSlug) => {
    const intradayIndicators = await getIndicators("5m", MARKETS[marketSlug].marketId);
    const longTermIndicators = await getIndicators("4h", MARKETS[marketSlug].marketId);

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

  console.log("Calling AI model:", account.modelName);

  const tools = [
    {
      type: "function",
      function: {
        name: "createPosition",
        description: "Open a position in the given market",
        parameters: {
          type: "object",
          properties: {
            symbol: { type: "string", enum: Object.keys(MARKETS), description: "The symbol to open the position at" },
            side: { type: "string", enum: ["LONG", "SHORT"] },
            quantity: { type: "number", description: "The quantity of the position to open" },
          },
          required: ["symbol", "side", "quantity"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "closeAllPosition",
        description: "Close all the currently open positions",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  const choice = callDOChat(account.modelName, [{ role: "user", content: enrichedPrompt }], tools);
  let responseText = choice.message.content ?? "";

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      if (tc.function.name === "createPosition") {
        const side = args.side as "LONG" | "SHORT";
        const symbol = args.symbol as string;
        const leverage = MARKET_LEVERAGE[symbol] ?? 5;
        const availableBalance = parseFloat(portfolio.available);
        const riskAmount = availableBalance * 0.02;
        const quantity = Number((riskAmount * leverage).toFixed(2));

        await createPosition(account, symbol, side, quantity);
        await prisma.toolCalls.create({
          data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CREATE_POSITION, metadata: JSON.stringify({ symbol, side, quantity }) },
        });
        responseText += ` [Created ${side} ${quantity} ${symbol} (2% risk, ${leverage}x leverage)]`;
      } else if (tc.function.name === "closeAllPosition") {
        await cancelAllOrders(account);
        await prisma.toolCalls.create({
          data: { invocationId: modelInvocation.id, toolCallType: ToolCallType.CLOSE_POSITION, metadata: "" },
        });
        responseText += " [Closed all positions]";
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
    console.log(`[${new Date().toLocaleTimeString()}] Cycle complete. Next in 5 min.\n`);
}

setInterval(() => { main(); }, 1000 * 60 * 5);
main();
export const API_KEY_INDEX = Number(process.env['API_KEY_INDEX'] ?? '4');
export const BASE_URL = "https://mainnet.zklighter.elliot.ai";

// Python interpreter for lighter-sdk calls. Defaults to project venv so
// PEP 668 systems (Debian/Ubuntu) don't need a globally-activated shell.
export const PYTHON = process.env['PYTHON'] ?? `${import.meta.dir}/.venv/bin/python3`;

// Operational flags
export const DRY_RUN = process.env['DRY_RUN'] === "1";
export const ENABLE_TRADING = process.env['ENABLE_TRADING'] !== "0";

// Decision loop cadence. Align to 2-minute cycle to reduce API pressure.
export const LOOP_INTERVAL_MS = 120 * 1000;
export const LOOP_ALIGN_BUFFER_MS = 3 * 1000;

// Risk policy. The RiskEngine enforces these regardless of what the LLM asks for.
// Every value is a hard cap; the LLM is informed of the same numbers in the prompt
// so it doesn't waste budget arguing with the engine.
export const RISK = {
  // Position sizing caps (all fractions of total equity)
  MAX_NOTIONAL_PER_TRADE_PCT: 0.08,    // leveraged notional per new position (tightened while iterating)
  MAX_GROSS_NOTIONAL_PCT:     0.40,    // sum of |leveraged notional| across open positions
  MAX_POSITIONS:              4,       // maximum concurrent open positions
  MIN_TRADE_NOTIONAL_USD:     5,       // below this, the trade is rejected as dust
  MAX_RISK_PER_TRADE_PCT:     0.005,   // initial $risk = notional * (SL distance / price) ≤ 0.5% of equity

  // Stop loss / take profit
  ATR_STOP_MULTIPLIER:        1.5,     // auto SL distance = 1.5 * ATR(14, 5m)
  MIN_SL_DISTANCE_PCT:        0.004,   // floor — never place SL tighter than 0.4% from entry
  MAX_SL_DISTANCE_PCT:        0.05,    // ceiling — never place SL wider than 5% from entry
  BREAKEVEN_AT_R:             1.0,     // move SL to breakeven after +1R
  MIN_ADX_FOR_MARKET:         20,      // block market entries when 5m ADX is weak
  LONG_RSI_MAX:               75,      // reject longs if RSI is too hot
  SHORT_RSI_MIN:              25,      // reject shorts if RSI is too cold
  SL_FAILURE_HALT_HOURS:      6,       // halt trading for the model when auto-SL fails

  // Circuit breakers
  MAX_DAILY_DRAWDOWN_PCT:     0.05,    // -5% from day-high → halt until 00:00 UTC
  HARD_DAILY_DRAWDOWN_PCT:    0.08,    // -8% → halt AND close everything
  CONSECUTIVE_LOSS_LIMIT:     4,       // 4 losers in a row → halt 6h
  LOSS_STREAK_HALT_HOURS:     6,

  // Per-symbol throttling
  MIN_SECONDS_BETWEEN_ENTRIES: 300,    // 5 min between entries on the same symbol
} as const;

// LLM determinism. Reasoning models (qwen3.5, etc.) emit thinking tokens
// that eat budget before content appears — keep headroom generous.
export const LLM_CONFIG = {
  TEMPERATURE: 0.2,
  MAX_COMPLETION_TOKENS: 8192,
  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: [1000, 3000, 9000],
  TIMEOUT_MS: 180_000,
} as const;

// LLM provider endpoint. Defaults to local Ollama (OpenAI-compatible shim).
// Override via env for other providers.
export const LLM_BASE_URL =
  process.env['LLM_BASE_URL'] ?? "http://localhost:11434/v1";
export const LLM_API_KEY =
  process.env['LLM_API_KEY'] ?? process.env['DO_MODEL_ACCESS_KEY'] ?? "ollama";
// If set, overrides the model name stored in the DB for every LLM call.
export const LLM_MODEL_OVERRIDE =
  process.env['LLM_MODEL'] ?? "qwen3.5:latest";

// Telegram alerts (optional)
export const TELEGRAM_BOT_TOKEN =
  process.env['TELEGRAM_BOT_TOKEN'] ?? "8222165819:AAEg4qGPh-Topg0ngr-aduAzGMiPsu1vIek";
export const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'] ?? "570038640";
export const TELEGRAM_ALERTS_ENABLED = process.env['TELEGRAM_ALERTS_ENABLED'] !== "0";

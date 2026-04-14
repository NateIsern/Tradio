export const API_KEY_INDEX = Number(process.env['API_KEY_INDEX'] ?? '4');
export const BASE_URL = "https://mainnet.zklighter.elliot.ai";

// Operational flags
export const DRY_RUN = process.env['DRY_RUN'] === "1";
export const ENABLE_TRADING = process.env['ENABLE_TRADING'] !== "0";

// Decision loop cadence — align to 5-minute candle close so indicators are final.
export const LOOP_INTERVAL_MS = 5 * 60 * 1000;
export const LOOP_ALIGN_BUFFER_MS = 5 * 1000;

// Risk policy. The RiskEngine enforces these regardless of what the LLM asks for.
// Every value is a hard cap; the LLM is informed of the same numbers in the prompt
// so it doesn't waste budget arguing with the engine.
export const RISK = {
  // Position sizing caps (all fractions of total equity)
  MAX_NOTIONAL_PER_TRADE_PCT: 0.15,    // leveraged notional per new position
  MAX_GROSS_NOTIONAL_PCT:     0.60,    // sum of |leveraged notional| across open positions
  MAX_POSITIONS:              4,       // maximum concurrent open positions
  MIN_TRADE_NOTIONAL_USD:     5,       // below this, the trade is rejected as dust
  MAX_RISK_PER_TRADE_PCT:     0.0075,  // initial $risk = notional * (SL distance / price) ≤ 0.75% of equity

  // Stop loss / take profit
  ATR_STOP_MULTIPLIER:        1.5,     // auto SL distance = 1.5 * ATR(14, 5m)
  MIN_SL_DISTANCE_PCT:        0.004,   // floor — never place SL tighter than 0.4% from entry
  MAX_SL_DISTANCE_PCT:        0.05,    // ceiling — never place SL wider than 5% from entry
  BREAKEVEN_AT_R:             1.0,     // move SL to breakeven after +1R

  // Circuit breakers
  MAX_DAILY_DRAWDOWN_PCT:     0.05,    // -5% from day-high → halt until 00:00 UTC
  HARD_DAILY_DRAWDOWN_PCT:    0.08,    // -8% → halt AND close everything
  CONSECUTIVE_LOSS_LIMIT:     4,       // 4 losers in a row → halt 6h
  LOSS_STREAK_HALT_HOURS:     6,

  // Per-symbol throttling
  MIN_SECONDS_BETWEEN_ENTRIES: 300,    // 5 min between entries on the same symbol
} as const;

// LLM determinism
export const LLM_CONFIG = {
  TEMPERATURE: 0.2,
  TOP_P: 0.9,
  SEED: 42,
  MAX_COMPLETION_TOKENS: 4096,
  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: [1000, 3000, 9000],
  TIMEOUT_MS: 90_000,
} as const;

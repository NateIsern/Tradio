import { TELEGRAM_ALERTS_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "./config";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
  if (!TELEGRAM_ALERTS_ENABLED) return { ok: false };
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === "" || TELEGRAM_BOT_TOKEN.includes("YOUR")) {
    console.warn("[telegram] bot token missing; skipping");
    return { ok: false };
  }
  try {
    const resp = await fetch(`${TELEGRAM_API}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`telegram ${resp.status}: ${text.slice(0, 200)}`);
    }
    return { ok: true };
  } catch (err) {
    console.error("[telegram] send failed:", (err as Error).message);
    return { ok: false };
  }
}

// Outbound-only: post a plain message to the given chat. Inbound handling
// (commands, free-form chat) lives in the separate Python PTB process.
export async function sendTelegramMessage(
  text: string,
  chatId: string | undefined = TELEGRAM_CHAT_ID,
  opts: { parseMode?: "Markdown" | "HTML" | "none" } = {},
): Promise<{ ok: boolean }> {
  if (!chatId) {
    console.warn("[telegram] chat id missing; skipping message");
    return { ok: false };
  }
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode !== "none") body.parse_mode = opts.parseMode ?? "Markdown";
  return post("sendMessage", body);
}

export async function sendTelegramAlert(
  title: string,
  lines: string[],
  chatId: string | undefined = TELEGRAM_CHAT_ID,
): Promise<{ ok: boolean }> {
  const body = [`*${title}*`, ...lines].join("\n");
  return sendTelegramMessage(body, chatId);
}

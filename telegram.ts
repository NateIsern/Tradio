import { TELEGRAM_ALERTS_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from "./config";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

type PostResult =
  | { ok: false; skipped?: true; error?: string }
  | { ok: true; result: Record<string, unknown> };

async function post(path: string, body: Record<string, unknown>): Promise<PostResult> {
  if (!TELEGRAM_ALERTS_ENABLED) return { ok: false, skipped: true };
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === "" || TELEGRAM_BOT_TOKEN.includes("YOUR")) {
    console.warn("[telegram] bot token missing; skipping");
    return { ok: false, skipped: true };
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
    const json = (await resp.json()) as { ok?: boolean; result?: Record<string, unknown> };
    return { ok: true, result: json.result ?? {} };
  } catch (err) {
    console.error("[telegram] send failed:", (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}

// Send a message and return the new message_id so callers can edit it later.
// Used by the Telegram streaming path to repaint a single message with each
// partial LLM response, creating a real streaming UX inside the chat.
export async function sendTelegramMessage(
  text: string,
  chatId: string | undefined = TELEGRAM_CHAT_ID,
  opts: { parseMode?: "Markdown" | "HTML" | "none" } = {},
): Promise<{ ok: true; messageId: number } | { ok: false }> {
  if (!chatId) {
    console.warn("[telegram] chat id missing; skipping message");
    return { ok: false };
  }
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode !== "none") body.parse_mode = opts.parseMode ?? "Markdown";
  const res = await post("sendMessage", body);
  if (!res.ok) return { ok: false };
  const id = Number((res.result as { message_id?: number }).message_id ?? 0);
  if (!id) return { ok: false };
  return { ok: true, messageId: id };
}

// Edit an existing message in place. Telegram rate-limits edits to roughly
// one per second per chat; callers should debounce on the backend side.
export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  opts: { parseMode?: "Markdown" | "HTML" | "none" } = {},
): Promise<{ ok: boolean }> {
  if (!chatId || !messageId) return { ok: false };
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (opts.parseMode !== "none") body.parse_mode = opts.parseMode ?? "Markdown";
  const res = await post("editMessageText", body);
  return { ok: res.ok };
}

// Set the "typing..." indicator. Telegram auto-expires it after ~5s so we
// re-fire it periodically while a long LLM reply is being streamed.
export async function sendTelegramTyping(chatId: string): Promise<void> {
  if (!chatId) return;
  await post("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function sendTelegramAlert(title: string, lines: string[], chatId: string | undefined = TELEGRAM_CHAT_ID) {
  const body = [
    `*${title}*`,
    ...lines,
  ].join("\n");
  return sendTelegramMessage(body, chatId);
}

export async function fetchTelegramUpdates(offset: number, timeoutSec = 5) {
  if (!TELEGRAM_ALERTS_ENABLED) return { ok: false, skipped: true } as const;
  const url = `${TELEGRAM_API}/getUpdates?timeout=${timeoutSec}&offset=${offset}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`telegram getUpdates ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    return { ok: true, data: json } as const;
  } catch (err) {
    console.error("[telegram] getUpdates failed:", (err as Error).message);
    return { ok: false, error: (err as Error).message } as const;
  }
}

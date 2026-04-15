"""Tradio Telegram bot: proxies user chats to the Node /chat SSE endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

import httpx
from telegram import Message, Update
from telegram.constants import ChatAction
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s %(message)s")
LOG = logging.getLogger("tradio.telegram")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or "8731864765:AAHcLkwX--QiQxvPZzvne7x8GtoT-rarA3w"
API_BASE = os.environ.get("TRADIO_API_BASE", "http://localhost:3001")
HISTORY_LIMIT = 8
EDIT_DEBOUNCE_MS = 1000
TYPING_REFRESH_MS = 4000
STREAM_TIMEOUT_S = 120
MAX_MSG_LEN = 3800

history: dict[int, list[dict[str, str]]] = {}


def append_turn(chat_id: int, role: str, content: str) -> None:
    turns = history.setdefault(chat_id, [])
    turns.append({"role": role, "content": content})
    while len(turns) > HISTORY_LIMIT:
        turns.pop(0)


async def _edit(ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, mid: int, text: str) -> None:
    try:
        await ctx.bot.edit_message_text(chat_id=chat_id, message_id=mid, text=text[:MAX_MSG_LEN])
    except Exception as err:  # noqa: BLE001 — Telegram edit errors are recoverable
        LOG.warning("edit_message_text failed: %s", err)


async def cmd_start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await update.message.reply_text(
        "Tradio online. I watch your Lighter account live.\n"
        "Ask me about positions, strategy, or just chat.\n"
        "Commands: /status /halt /reset /help"
    )


async def cmd_help(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await update.message.reply_text(
        "/status - equity and open positions\n"
        "/halt - pause trading for 6h\n"
        "/reset - clear our chat history\n"
        "/help - this message\n"
        "Anything else: I'll reply with live context."
    )


async def cmd_reset(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None or update.effective_chat is None:
        return
    history.pop(update.effective_chat.id, None)
    await update.message.reply_text("History cleared.")


async def cmd_status(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            pos_resp, stats_resp = await asyncio.gather(
                c.get(f"{API_BASE}/positions"), c.get(f"{API_BASE}/stats")
            )
    except httpx.HTTPError as err:
        await update.message.reply_text(f"\u26a0 Backend unreachable: {err}")
        return

    stats = stats_resp.json() if stats_resp.status_code == 200 else {}
    positions = (pos_resp.json() or {}).get("data", []) if pos_resp.status_code == 200 else []
    equity = float((stats or {}).get("currentValue", 0) or 0)
    pnl = float((stats or {}).get("pnl", 0) or 0)
    lines = [f"Equity ${equity:.2f} (pnl {pnl:+.2f})"]
    for p in positions:
        lines.append(
            f"  {p.get('side', '?')} {p.get('symbol', '?')} size={p.get('size', 0)}"
            f" entry=${p.get('entryPrice', 0)} mark=${p.get('markPrice', 0)}"
            f" uPnL={float(p.get('unrealizedPnl', 0) or 0):+.2f}"
        )
    if not positions:
        lines.append("  No open positions.")
    await update.message.reply_text("\n".join(lines))


async def cmd_halt(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None:
        return
    await update.message.reply_text("Halt not wired through this bot yet. Use the dashboard.")


async def handle_chat(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message is None or update.effective_chat is None:
        return
    chat_id = update.effective_chat.id
    text = (update.message.text or "").strip()
    if not text:
        return

    append_turn(chat_id, "user", text)
    await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
    placeholder: Message = await update.message.reply_text("…")

    payload = {"messages": history[chat_id]}
    buffer = ""
    last_edit = 0.0
    last_typing = time.monotonic() * 1000
    last_sent = ""
    truncated = False

    async def maybe_flush(force: bool) -> None:
        nonlocal last_edit, last_sent
        if not buffer or buffer == last_sent:
            return
        now_ms = time.monotonic() * 1000
        if not force and now_ms - last_edit < EDIT_DEBOUNCE_MS:
            return
        last_edit = now_ms
        last_sent = buffer
        await _edit(ctx, chat_id, placeholder.message_id, buffer)

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(STREAM_TIMEOUT_S)) as client:
            async with client.stream(
                "POST", f"{API_BASE}/chat",
                headers={"Content-Type": "application/json"}, json=payload,
            ) as resp:
                resp.raise_for_status()
                event_name = "message"
                async for raw_line in resp.aiter_lines():
                    line = raw_line.strip()
                    if not line:
                        continue
                    if line.startswith("event:"):
                        event_name = line[len("event:"):].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if event_name == "token":
                        try:
                            buffer += json.loads(data).get("content", "")
                        except json.JSONDecodeError as err:
                            LOG.warning("token parse failed: %s", err)
                        await maybe_flush(force=False)
                        now_ms = time.monotonic() * 1000
                        if now_ms - last_typing > TYPING_REFRESH_MS:
                            last_typing = now_ms
                            await ctx.bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
                    elif event_name == "done":
                        break
                    elif event_name == "error":
                        buffer += f"\n\u26a0 error: {data[:200]}"
                        break
                    else:
                        LOG.debug("ignored event %s: %s", event_name, data)
        await maybe_flush(force=True)
    except httpx.TimeoutException:
        LOG.warning("chat stream timed out after %ss", STREAM_TIMEOUT_S)
        truncated = True
    except httpx.HTTPError as err:
        LOG.exception("chat stream failed")
        await _edit(ctx, chat_id, placeholder.message_id, f"\u26a0 Backend unreachable: {err}")
        return

    if truncated:
        buffer += " [truncated]"
        await _edit(ctx, chat_id, placeholder.message_id, buffer)
    append_turn(chat_id, "assistant", buffer.strip() or "(no response)")


def main() -> None:
    app = Application.builder().token(TOKEN).build()
    for cmd, fn in (("start", cmd_start), ("help", cmd_help), ("status", cmd_status),
                    ("halt", cmd_halt), ("reset", cmd_reset)):
        app.add_handler(CommandHandler(cmd, fn))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_chat))
    LOG.info("Starting Tradio Telegram bot (polling)")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

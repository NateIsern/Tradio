import { useState, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ToolCall = {
  toolCallType: string;
  metadata: string;
  createdAt: string | Date;
};

type Invocation = {
  id: string;
  response: string;
  createdAt: string | Date;
  model?: { name?: string };
  toolCalls?: ToolCall[];
};

type Props = {
  data: Invocation[] | null;
};

type ParsedToolCall = {
  type: string;
  metadata: string;
  createdAt: Date;
  parsed: Record<string, unknown> | null;
};

function parseToolMetadata(metadata: string): Record<string, unknown> | null {
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getToolCallDisplay(tc: ParsedToolCall): {
  label: string;
  bgClass: string;
  borderColor: string;
  textColor: string;
} {
  const typeLower = tc.type.toLowerCase();
  const meta = tc.parsed;

  if (typeLower.includes("create") || typeLower.includes("open")) {
    const side = meta?.side ?? meta?.direction ?? "";
    const sideStr = String(side).toUpperCase();
    const symbol = meta?.symbol ?? meta?.market ?? "";
    const size = meta?.size ?? meta?.amount ?? meta?.quantity ?? "";

    if (sideStr === "SHORT" || sideStr.includes("SHORT")) {
      return {
        label: `SHORT ${symbol} ${size ? `$${size}` : ""}`.trim(),
        bgClass: "bg-[#ff444420]",
        borderColor: "border-terminal-red",
        textColor: "text-terminal-red",
      };
    }

    return {
      label: `LONG ${symbol} ${size ? `$${size}` : ""}`.trim(),
      bgClass: "bg-[#00ff8820]",
      borderColor: "border-terminal-green",
      textColor: "text-terminal-green",
    };
  }

  if (typeLower.includes("close") || typeLower.includes("cancel")) {
    return {
      label: "Closed all positions",
      bgClass: "bg-[#f59e0b20]",
      borderColor: "border-terminal-amber",
      textColor: "text-terminal-amber",
    };
  }

  return {
    label: tc.type,
    bgClass: "bg-[#00ff8820]",
    borderColor: "border-terminal-green",
    textColor: "text-terminal-green",
  };
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(date: Date): string {
  const today = new Date();
  const isToday =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();

  if (isToday) return "Today";

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (isYesterday) return "Yesterday";

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ChatPanel({ data }: Props) {
  const [search, setSearch] = useState("");

  const messages = useMemo(() => {
    if (!data) return [];

    const mapped = data.map((inv) => ({
      id: inv.id,
      modelName: inv.model?.name ?? "Tradio AI",
      createdAt: new Date(inv.createdAt),
      response: inv.response,
      toolCalls: (inv.toolCalls ?? []).map((tc) => ({
        type: tc.toolCallType,
        metadata: tc.metadata,
        createdAt: new Date(tc.createdAt),
        parsed: parseToolMetadata(tc.metadata),
      })),
    }));

    if (!search.trim()) return mapped;

    const query = search.toLowerCase();
    return mapped.filter(
      (msg) =>
        msg.response.toLowerCase().includes(query) ||
        msg.toolCalls.some((tc) => tc.type.toLowerCase().includes(query))
    );
  }, [data, search]);

  if (!data) {
    return (
      <div className="flex h-full flex-col bg-[#0a0a0f]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border bg-terminal-surface shrink-0">
          <h3 className="text-[11px] font-bold text-terminal-green tracking-widest">
            AI TRADIO
          </h3>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-terminal-green/20 flex items-center justify-center animate-pulse">
              <span className="text-terminal-green text-sm font-bold">T</span>
            </div>
            <span className="text-terminal-subtle text-[10px] animate-pulse">
              Loading conversations...
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0a0f]">
      {/* Header */}
      <div className="shrink-0 border-b border-terminal-border bg-terminal-surface">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded-full bg-terminal-green flex items-center justify-center">
              <span className="text-[10px] font-bold text-[#0a0a0f]">T</span>
            </div>
            <h3 className="text-[11px] font-bold text-terminal-green tracking-widest">
              AI TRADIO
            </h3>
          </div>
          <span className="text-[10px] text-terminal-subtle">
            {messages.length} messages
          </span>
        </div>
        <div className="px-4 pb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages..."
            className="w-full rounded border border-terminal-border bg-terminal-panel px-3 py-1.5 text-[11px] text-terminal-text placeholder-terminal-subtle outline-none focus:border-terminal-green/50 transition-colors"
          />
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {messages.length === 0 && search.trim() ? (
          <div className="flex items-center justify-center py-12 text-terminal-subtle text-[10px]">
            No messages match "{search}"
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isLatest = idx === 0 && !search.trim();
            const dateLabel = formatDate(msg.createdAt);
            const prevDateLabel =
              idx > 0 ? formatDate(messages[idx - 1].createdAt) : null;
            const showDateSeparator = idx === 0 || dateLabel !== prevDateLabel;

            return (
              <div key={msg.id}>
                {showDateSeparator && (
                  <div className="flex items-center gap-3 px-4 py-2">
                    <div className="flex-1 h-px bg-terminal-border" />
                    <span className="text-[9px] text-terminal-subtle font-bold tracking-wider">
                      {dateLabel}
                    </span>
                    <div className="flex-1 h-px bg-terminal-border" />
                  </div>
                )}

                <div
                  className={`px-4 py-3 transition-colors ${
                    isLatest
                      ? "border-l-2 border-l-terminal-green bg-terminal-green/[0.03]"
                      : "border-l-2 border-l-transparent hover:bg-terminal-surface/30"
                  }`}
                >
                  {/* Avatar + header row */}
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 h-6 w-6 shrink-0 rounded-full flex items-center justify-center ${
                        isLatest ? "bg-terminal-green" : "bg-terminal-green/20"
                      }`}
                    >
                      <span
                        className={`text-[10px] font-bold ${
                          isLatest ? "text-[#0a0a0f]" : "text-terminal-green"
                        }`}
                      >
                        T
                      </span>
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Name + time */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[11px] font-bold text-terminal-text">
                          {msg.modelName}
                        </span>
                        {isLatest && (
                          <span className="text-[8px] font-bold tracking-wider text-terminal-green bg-terminal-green/10 px-1.5 py-0.5 rounded">
                            LATEST
                          </span>
                        )}
                        <span className="text-[10px] text-terminal-subtle ml-auto shrink-0">
                          {formatTime(msg.createdAt)}
                        </span>
                      </div>

                      {/* Message body */}
                      <div className="ai-markdown text-[11px] text-terminal-text leading-relaxed">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {msg.response}
                        </Markdown>
                      </div>

                      {/* Tool call badges */}
                      {msg.toolCalls.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {msg.toolCalls.map((tc, tcIdx) => {
                            const display = getToolCallDisplay(tc);
                            return (
                              <div
                                key={tcIdx}
                                className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 ${display.bgClass} ${display.borderColor}`}
                              >
                                <span
                                  className={`text-[10px] font-bold ${display.textColor}`}
                                >
                                  {display.label}
                                </span>
                                {tc.parsed && (
                                  <span className="text-[9px] text-terminal-subtle">
                                    {formatTime(tc.createdAt)}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Separator between messages */}
                {idx < messages.length - 1 && (
                  <div className="mx-4">
                    <div className="h-px bg-terminal-border/50" />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

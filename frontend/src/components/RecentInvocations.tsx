import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Invocation = {
  id: string;
  response: string;
  createdAt: string | Date;
  model?: { name?: string };
  toolCalls?: {
    toolCallType: string;
    metadata: string;
    createdAt: string | Date;
  }[];
};

type Props = {
  data: Invocation[] | null;
};

function parseSummary(
  response: string,
  toolCalls: Array<{ type: string; metadata: string }>
): { action: string; color: string } {
  const lower = response.toLowerCase();
  const hasToolCalls = toolCalls.length > 0;

  if (hasToolCalls) {
    const types = toolCalls.map((tc) => tc.type.toLowerCase());
    const hasOpen = types.some((t) => t.includes("open") || t.includes("create"));
    const hasClose = types.some((t) => t.includes("close") || t.includes("cancel"));

    if (hasOpen && lower.includes("long")) return { action: "OPENED LONG", color: "text-terminal-green" };
    if (hasOpen && lower.includes("short")) return { action: "OPENED SHORT", color: "text-terminal-red" };
    if (hasClose) return { action: "CLOSED POSITION", color: "text-terminal-amber" };
    return { action: `${toolCalls.length} TRADE${toolCalls.length > 1 ? "S" : ""}`, color: "text-terminal-green" };
  }

  if (lower.includes("no action") || lower.includes("hold") || lower.includes("wait"))
    return { action: "NO ACTION", color: "text-terminal-subtle" };

  return { action: "ANALYZED", color: "text-terminal-muted" };
}

export default function RecentInvocations({ data }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-8 text-terminal-subtle text-xs animate-pulse">
        Loading activity...
      </div>
    );
  }

  const items = data.map((inv) => ({
    id: inv.id,
    modelName: inv.model?.name ?? "Unknown",
    createdAt: new Date(inv.createdAt),
    response: inv.response,
    toolCalls: (inv.toolCalls ?? []).map((tc) => ({
      type: tc.toolCallType,
      createdAt: new Date(tc.createdAt),
      metadata: tc.metadata,
    })),
  }));

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-border bg-terminal-surface">
        <h3 className="text-xs font-bold text-terminal-muted tracking-widest">
          AI ACTIVITY LOG
        </h3>
        <span className="text-xs text-terminal-subtle">
          {items.length} entries
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {items.map((it) => {
          const isExpanded = expandedId === it.id;
          const { action, color } = parseSummary(it.response, it.toolCalls);
          const timeStr = it.createdAt.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          });

          return (
            <div
              key={it.id}
              className={`border-b border-terminal-border transition-colors ${
                isExpanded ? "bg-terminal-panel/50" : "hover:bg-terminal-panel/30"
              }`}
            >
              <button
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
                onClick={() => setExpandedId(isExpanded ? null : it.id)}
              >
                <span className="text-[10px] text-terminal-subtle font-mono w-16 shrink-0">
                  {timeStr}
                </span>
                <span className={`text-xs font-bold ${color}`}>
                  {action}
                </span>
                <span className="ml-auto text-[10px] text-terminal-subtle">
                  {it.modelName}
                </span>
                <span
                  className={`text-terminal-subtle text-[10px] transition-transform ${
                    isExpanded ? "rotate-90" : ""
                  }`}
                >
                  ▶
                </span>
              </button>

              {isExpanded && (
                <div className="px-4 pb-3 space-y-2">
                  {it.response && (
                    <div className="rounded border border-terminal-border bg-terminal-bg p-3">
                      <div className="text-[10px] text-terminal-muted mb-2 font-bold">
                        AI REASONING
                      </div>
                      <div className="ai-markdown text-xs text-terminal-text leading-relaxed">
                        <Markdown remarkPlugins={[remarkGfm]}>{it.response}</Markdown>
                      </div>
                    </div>
                  )}

                  {it.toolCalls.length > 0 && (
                    <div className="rounded border border-terminal-border bg-terminal-bg p-3">
                      <div className="text-[10px] text-terminal-muted mb-2 font-bold">
                        TOOL CALLS ({it.toolCalls.length})
                      </div>
                      <div className="space-y-2">
                        {it.toolCalls.map((tc, idx) => (
                          <div
                            key={idx}
                            className="rounded border border-terminal-border bg-terminal-surface p-2"
                          >
                            <div className="flex justify-between mb-1">
                              <span className="text-[10px] font-bold text-terminal-green">
                                {tc.type}
                              </span>
                              <span className="text-[9px] text-terminal-subtle">
                                {tc.createdAt.toLocaleTimeString("en-US", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                  hour12: false,
                                })}
                              </span>
                            </div>
                            {tc.metadata && (
                              <div className="text-[10px] text-terminal-muted font-mono">
                                {(() => {
                                  try {
                                    const parsed = JSON.parse(tc.metadata);
                                    return Object.entries(parsed).map(
                                      ([k, v]) => (
                                        <div key={k} className="flex gap-2">
                                          <span className="text-terminal-subtle min-w-[60px]">
                                            {k}:
                                          </span>
                                          <span className="text-terminal-text">
                                            {String(v)}
                                          </span>
                                        </div>
                                      )
                                    );
                                  } catch {
                                    return (
                                      <span className="text-terminal-muted">
                                        {tc.metadata}
                                      </span>
                                    );
                                  }
                                })()}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
      <div className="flex h-full items-center justify-center text-terminal-subtle text-[10px] animate-pulse">
        Loading research...
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

  const latest = items[0];
  const previous = items.slice(1);

  return (
    <div className="flex h-full flex-col border-l border-terminal-border bg-terminal-bg min-h-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-terminal-border bg-terminal-surface shrink-0">
        <h3 className="text-[10px] font-bold text-terminal-muted tracking-widest">
          AI RESEARCH
        </h3>
        <span className="text-[10px] text-terminal-subtle">
          {items.length} entries
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {latest && (
          <div className="border-b border-terminal-border">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-terminal-green">
                  LATEST ANALYSIS
                </span>
                <span className="text-[10px] text-terminal-subtle">
                  {latest.createdAt.toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: true,
                  })}
                </span>
              </div>
              <div className="ai-markdown text-xs text-terminal-text leading-relaxed">
                <Markdown remarkPlugins={[remarkGfm]}>{latest.response}</Markdown>
              </div>
              {latest.toolCalls.length > 0 && (
                <div className="mt-3 rounded border border-terminal-border bg-terminal-panel/50 p-2.5">
                  <div className="text-[9px] text-terminal-muted font-bold mb-1.5">
                    ACTIONS ({latest.toolCalls.length})
                  </div>
                  <div className="space-y-1.5">
                    {latest.toolCalls.map((tc, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-[10px]">
                        <span className="font-bold text-terminal-green">{tc.type}</span>
                        {tc.metadata && (() => {
                          try {
                            const parsed = JSON.parse(tc.metadata);
                            return (
                              <span className="text-terminal-muted truncate">
                                {Object.entries(parsed).map(([k, v]) => `${k}=${String(v)}`).join(" ")}
                              </span>
                            );
                          } catch {
                            return <span className="text-terminal-muted truncate">{tc.metadata}</span>;
                          }
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {previous.length > 0 && (
          <div>
            <div className="px-4 py-2 bg-terminal-surface/50 border-b border-terminal-border">
              <span className="text-[9px] font-bold text-terminal-subtle tracking-widest">
                PREVIOUS
              </span>
            </div>
            {previous.map((it) => {
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
                  className={`border-b border-terminal-border/50 transition-colors ${
                    isExpanded ? "bg-terminal-panel/30" : "hover:bg-terminal-panel/20"
                  }`}
                >
                  <button
                    className="flex w-full items-center gap-2 px-4 py-2 text-left"
                    onClick={() => setExpandedId(isExpanded ? null : it.id)}
                  >
                    <span className="text-[9px] text-terminal-subtle font-mono w-14 shrink-0">
                      {timeStr}
                    </span>
                    <span className={`text-[10px] font-bold ${color}`}>
                      {action}
                    </span>
                    <span className="ml-auto text-[9px] text-terminal-subtle">
                      {it.modelName}
                    </span>
                    <span
                      className={`text-terminal-subtle text-[9px] transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    >
                      &#9654;
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-3">
                      <div className="rounded border border-terminal-border bg-terminal-bg p-3">
                        <div className="ai-markdown text-xs text-terminal-text leading-relaxed">
                          <Markdown remarkPlugins={[remarkGfm]}>{it.response}</Markdown>
                        </div>
                      </div>
                      {it.toolCalls.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {it.toolCalls.map((tc, idx) => (
                            <div
                              key={idx}
                              className="rounded border border-terminal-border bg-terminal-surface p-2"
                            >
                              <div className="flex justify-between mb-1">
                                <span className="text-[9px] font-bold text-terminal-green">
                                  {tc.type}
                                </span>
                                <span className="text-[8px] text-terminal-subtle">
                                  {tc.createdAt.toLocaleTimeString("en-US", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                    hour12: false,
                                  })}
                                </span>
                              </div>
                              {tc.metadata && (
                                <div className="text-[9px] text-terminal-muted font-mono">
                                  {(() => {
                                    try {
                                      const parsed = JSON.parse(tc.metadata);
                                      return Object.entries(parsed).map(
                                        ([k, v]) => (
                                          <div key={k} className="flex gap-2">
                                            <span className="text-terminal-subtle min-w-[50px]">
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
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";

import AiChat from "./AiChat";
import ChatPanel from "./ChatPanel";

type Tab = "live" | "history";

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
  invocationsData: Invocation[] | null;
  backendUrl: string;
};

export default function RightPanel({ invocationsData, backendUrl }: Props) {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div className="flex h-full flex-col bg-[#0a0a0f]">
      <div className="flex shrink-0 border-b border-terminal-border bg-terminal-surface">
        <button
          type="button"
          onClick={() => setTab("live")}
          className={`flex-1 border-b-2 px-4 py-2.5 text-[10px] font-bold tracking-wider transition-colors ${
            tab === "live"
              ? "border-terminal-green text-terminal-green"
              : "border-transparent text-terminal-subtle hover:text-terminal-text"
          }`}
        >
          LIVE CHAT
        </button>
        <button
          type="button"
          onClick={() => setTab("history")}
          className={`flex-1 border-b-2 px-4 py-2.5 text-[10px] font-bold tracking-wider transition-colors ${
            tab === "history"
              ? "border-terminal-green text-terminal-green"
              : "border-transparent text-terminal-subtle hover:text-terminal-text"
          }`}
        >
          HISTORY
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "live" ? (
          <AiChat backendUrl={backendUrl} />
        ) : (
          <ChatPanel data={invocationsData} />
        )}
      </div>
    </div>
  );
}

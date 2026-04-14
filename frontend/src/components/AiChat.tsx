import { useCallback, useRef, useState } from "react";
import { ArrowUp, Square, RotateCcw } from "lucide-react";

import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from "@/components/prompt-kit/chat-container";
import { Loader } from "@/components/prompt-kit/loader";
import { Message, MessageContent } from "@/components/prompt-kit/message";
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/prompt-kit/prompt-input";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { Button } from "@/components/ui/button";

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};

type Props = {
  backendUrl: string;
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AiChat({ backendUrl }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      const userMsg: ChatMsg = { id: makeId(), role: "user", content: trimmed };
      const assistantId = makeId();
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput("");
      setIsLoading(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      let assistantInserted = false;
      const appendToken = (token: string) => {
        if (!assistantInserted) {
          assistantInserted = true;
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: token,
              streaming: true,
            },
          ]);
          return;
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + token } : m
          )
        );
      };

      try {
        const res = await fetch(`${backendUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const errData = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errData.error ?? `Request failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamError: string | null = null;
        let doneReceived = false;

        while (!doneReceived) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIdx: number;
          while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            if (!block) continue;

            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
              }
            }
            const payload = dataLines.join("\n");
            if (!payload) continue;

            if (eventName === "token") {
              try {
                const parsed = JSON.parse(payload) as { content?: string };
                if (parsed.content) appendToken(parsed.content);
              } catch {
                // ignore malformed token chunk
              }
            } else if (eventName === "error") {
              try {
                const parsed = JSON.parse(payload) as { message?: string };
                streamError = parsed.message ?? "stream error";
              } catch {
                streamError = "stream error";
              }
              doneReceived = true;
              break;
            } else if (eventName === "done") {
              doneReceived = true;
              break;
            }
          }
        }

        if (streamError) throw new Error(streamError);

        if (!assistantInserted) {
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "(empty response)",
            },
          ]);
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
          return;
        }
        setError((err as Error).message);
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [backendUrl, isLoading, messages]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const handleReset = useCallback(() => {
    handleStop();
    setMessages([]);
    setError(null);
  }, [handleStop]);

  const suggestions = [
    "What's the current market sentiment on BTC and ETH?",
    "Analyze my open positions and suggest adjustments.",
    "Which market has the strongest setup right now?",
  ];

  const waitingForFirstToken =
    isLoading &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user";

  return (
    <div className="flex h-full flex-col bg-[#0a0a0f]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-terminal-border bg-terminal-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-terminal-green">
            <span className="text-[10px] font-bold text-[#0a0a0f]">T</span>
          </div>
          <h3 className="text-[11px] font-bold tracking-widest text-terminal-green">
            TALK TO TRADIO
          </h3>
        </div>
        <button
          type="button"
          onClick={handleReset}
          disabled={messages.length === 0 && !isLoading}
          className="flex items-center gap-1 rounded border border-terminal-border bg-terminal-panel px-2 py-1 text-[9px] font-bold tracking-wider text-terminal-subtle transition-colors hover:border-terminal-green/50 hover:text-terminal-green disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" />
          RESET
        </button>
      </div>

      {/* Messages */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatContainerRoot className="flex-1 flex-col px-4 py-3">
          <ChatContainerContent className="space-y-4">
            {messages.length === 0 && !isLoading ? (
              <div className="flex flex-col items-center gap-4 pt-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-terminal-green/10">
                  <span className="text-xl font-bold text-terminal-green">
                    T
                  </span>
                </div>
                <p className="text-center text-[11px] text-terminal-subtle">
                  Ask Tradio anything about markets,
                  <br />
                  positions, or trading setups.
                </p>
                <div className="flex w-full flex-col gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => sendMessage(s)}
                      disabled={isLoading}
                      className="rounded border border-terminal-border bg-terminal-panel px-3 py-2 text-left text-[10px] text-terminal-text transition-colors hover:border-terminal-green/50 hover:text-terminal-green disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <Message
                    key={msg.id}
                    className={
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }
                  >
                    {msg.role === "assistant" && (
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terminal-green/20">
                        <span className="text-[10px] font-bold text-terminal-green">
                          T
                        </span>
                      </div>
                    )}
                    <MessageContent
                      markdown={msg.role === "assistant"}
                      className={
                        msg.role === "user"
                          ? "ai-markdown max-w-[85%] rounded-2xl bg-terminal-green/10 px-3 py-2 text-[11px] text-terminal-text"
                          : "ai-markdown max-w-[85%] rounded-2xl bg-transparent px-0 py-0 text-[11px] text-terminal-text"
                      }
                    >
                      {msg.content}
                    </MessageContent>
                    {msg.streaming && (
                      <span className="mt-1.5 ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-terminal-green" />
                    )}
                  </Message>
                ))}

                {waitingForFirstToken && (
                  <Message className="justify-start">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terminal-green/20">
                      <span className="text-[10px] font-bold text-terminal-green">
                        T
                      </span>
                    </div>
                    <div className="flex items-center px-2 py-2">
                      <Loader variant="typing" size="sm" />
                    </div>
                  </Message>
                )}
              </>
            )}

            {error && (
              <div className="rounded border border-terminal-red/40 bg-terminal-red/10 px-3 py-2 text-[10px] text-terminal-red">
                {error}
              </div>
            )}
          </ChatContainerContent>
          <ChatContainerScrollAnchor />
          <div className="absolute right-4 bottom-28">
            <ScrollButton className="border-terminal-border bg-terminal-surface text-terminal-green hover:bg-terminal-panel" />
          </div>
        </ChatContainerRoot>

        {/* Input */}
        <div className="shrink-0 border-t border-terminal-border bg-terminal-surface px-4 py-3">
          <PromptInput
            isLoading={isLoading}
            value={input}
            onValueChange={setInput}
            onSubmit={() => sendMessage(input)}
            className="border-terminal-border bg-terminal-panel p-2"
          >
            <PromptInputTextarea
              placeholder="Ask Tradio about the markets..."
              className="min-h-[36px] text-[11px] text-terminal-text placeholder:text-terminal-subtle"
              disabled={isLoading}
            />
            <PromptInputActions className="justify-end pt-2">
              {isLoading ? (
                <PromptInputAction tooltip="Stop">
                  <Button
                    type="button"
                    size="icon"
                    onClick={handleStop}
                    className="h-7 w-7 rounded-full bg-terminal-red text-white hover:bg-terminal-red/90"
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                </PromptInputAction>
              ) : (
                <PromptInputAction tooltip="Send (Enter)">
                  <Button
                    type="button"
                    size="icon"
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim()}
                    className="h-7 w-7 rounded-full bg-terminal-green text-[#0a0a0f] hover:bg-terminal-green/90 disabled:bg-terminal-panel disabled:text-terminal-subtle"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                </PromptInputAction>
              )}
            </PromptInputActions>
          </PromptInput>
          <p className="mt-1.5 text-center text-[9px] text-terminal-subtle">
            Read-only analysis. The autonomous loop executes trades.
          </p>
        </div>
      </div>
    </div>
  );
}

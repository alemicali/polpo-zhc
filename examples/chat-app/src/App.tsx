import { useState, useRef, useEffect, useCallback } from "react";
import { PolpoClient } from "@polpo-ai/sdk";
import type { ChatCompletionMessage } from "@polpo-ai/sdk";

// ─── Config ──────────────────────────────────────────────
// Set these in .env or replace directly:
const BASE_URL = import.meta.env.VITE_POLPO_URL ?? "http://localhost:1355";
const API_KEY = import.meta.env.VITE_POLPO_API_KEY ?? "";
const AGENT = import.meta.env.VITE_POLPO_AGENT ?? "";

const client = new PolpoClient({ baseUrl: BASE_URL, apiKey: API_KEY });

// ─── Types ───────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

// ─── Markdown (minimal — no deps) ───────────────────────

function renderMarkdown(text: string): string {
  return text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
      `<pre><code>${code.replace(/</g, "&lt;")}</code></pre>`,
    )
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Headers
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Lists
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    // Paragraphs (lines not already wrapped)
    .replace(/^(?!<[hulop])(.*\S.*)$/gm, "<p>$1</p>")
    // Line breaks
    .replace(/\n\n/g, "");
}

// ─── Components ──────────────────────────────────────────

function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        padding: "4px 0",
      }}
    >
      <div
        style={{
          maxWidth: isUser ? "75%" : "85%",
          padding: isUser ? "10px 14px" : "0",
          background: isUser ? "var(--bg-secondary)" : "transparent",
          border: isUser ? "1px solid var(--border)" : "none",
          fontSize: "14px",
          lineHeight: "1.7",
          color: isUser ? "var(--text)" : "var(--text-muted)",
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <div
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(message.content || "..."),
            }}
          />
        )}
        {message.streaming && (
          <span
            style={{
              display: "inline-block",
              width: 6,
              height: 14,
              background: "var(--accent)",
              marginLeft: 2,
              animation: "blink 1s infinite",
            }}
          />
        )}
      </div>
    </div>
  );
}

function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    // Reset height
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  // Auto-resize textarea
  function handleInput() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        gap: 8,
        padding: "16px 24px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => { setText(e.target.value); handleInput(); }}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        rows={1}
        disabled={disabled}
        style={{
          flex: 1,
          resize: "none",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          padding: "10px 14px",
          fontSize: 14,
          fontFamily: "var(--font-sans)",
          outline: "none",
          lineHeight: "1.5",
        }}
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        style={{
          background: text.trim() && !disabled ? "var(--text)" : "var(--border)",
          color: "var(--bg)",
          border: "none",
          padding: "0 20px",
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          cursor: text.trim() && !disabled ? "pointer" : "default",
          transition: "opacity 0.15s",
          whiteSpace: "nowrap",
        }}
      >
        {disabled ? "..." : "Send"}
      </button>
    </form>
  );
}

// ─── App ─────────────────────────────────────────────────

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async (text: string) => {
    // Add user message
    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    // Build conversation history for API
    const history: ChatCompletionMessage[] = [
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: text },
    ];

    // Add empty assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
    setStreaming(true);

    try {
      const stream = client.chatCompletionsStream({
        messages: history,
        stream: true,
        ...(AGENT ? { agent: AGENT } : {}),
      });

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...last,
              content: last.content + delta,
            };
            return updated;
          });
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Error: ${(err as Error).message}`,
        };
        return updated;
      });
    } finally {
      // Remove streaming flag
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, streaming: false };
        return updated;
      });
      setStreaming(false);
    }
  }, [messages]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.2em",
            }}
          >
            POLPO
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginLeft: 12,
            }}
          >
            chat example
          </span>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: streaming ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {streaming ? "streaming..." : "ready"}
        </span>
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 24,
                fontWeight: 800,
                letterSpacing: "0.3em",
                color: "var(--border)",
              }}
            >
              POLPO
            </span>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Send a message to start
            </span>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
      </div>

      {/* Input */}
      <ChatInput onSend={send} disabled={streaming} />

      {/* Blink animation */}
      <style>{`@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }`}</style>
    </div>
  );
}

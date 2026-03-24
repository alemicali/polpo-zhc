import { useState, useRef, useEffect, useCallback } from "react";
import { usePolpo, useSessions, useAgents } from "@polpo-ai/react";
import type { ChatMessage } from "@polpo-ai/sdk";

const AGENT_ENV = import.meta.env.VITE_POLPO_AGENT ?? "";

// ─── Theme ───────────────────────────────────────────────

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (typeof window !== "undefined" && localStorage.getItem("polpo-theme") as "dark" | "light") || "dark"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("polpo-theme", theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}

// ─── Markdown (minimal) ─────────────────────────────────

function md(text: string): string {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _l, code) => `<pre><code>${code.replace(/</g, "&lt;")}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/^(?!<[hulop])(.*\S.*)$/gm, "<p>$1</p>")
    .replace(/\n\n/g, "");
}

// ─── Components ──────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: { id: string; title?: string; agentName?: string; createdAt: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside
      style={{
        width: 260,
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, letterSpacing: "0.2em" }}>
          POLPO
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>chat example</div>
      </div>

      {/* New chat button */}
      <button
        onClick={onNew}
        style={{
          margin: "12px 12px 4px",
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          fontSize: 13,
          fontFamily: "var(--font-sans)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        + New chat
      </button>

      {/* Sessions list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              padding: "8px 10px",
              marginBottom: 2,
              cursor: "pointer",
              background: activeId === s.id ? "var(--accent-dim)" : "transparent",
              borderLeft: activeId === s.id ? "2px solid var(--accent)" : "2px solid transparent",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              transition: "background 0.1s",
            }}
          >
            <div style={{ overflow: "hidden", flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: activeId === s.id ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {s.title || s.agentName || "Untitled"}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 14,
                padding: "2px 4px",
                opacity: 0.5,
              }}
            >
              x
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function AgentSelector({
  agents,
  onSelect,
}: {
  agents: { name: string; model?: string }[];
  onSelect: (name: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 16,
        padding: 24,
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 800, letterSpacing: "0.3em", color: "var(--border)" }}>
        POLPO
      </span>
      <span style={{ fontSize: 14, color: "var(--text-muted)" }}>
        Select an agent to start chatting
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 320, marginTop: 8 }}>
        {agents.map((a) => (
          <button
            key={a.name}
            onClick={() => onSelect(a.name)}
            style={{
              padding: "12px 16px",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontSize: 14,
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
          >
            <span style={{ fontWeight: 600 }}>{a.name}</span>
            {a.model && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
                {a.model}
              </span>
            )}
          </button>
        ))}
        {agents.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: 20 }}>
            No agents found. Deploy an agent first.
          </div>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", padding: "4px 0" }}>
      <div
        style={{
          maxWidth: isUser ? "75%" : "85%",
          padding: isUser ? "10px 14px" : "0",
          background: isUser ? "var(--user-bg)" : "transparent",
          border: isUser ? "1px solid var(--border)" : "none",
          fontSize: 14,
          lineHeight: "1.7",
          color: isUser ? "var(--text)" : "var(--text-muted)",
        }}
      >
        {isUser ? msg.content : <div dangerouslySetInnerHTML={{ __html: md(msg.content || "...") }} />}
        {msg.streaming && (
          <span style={{ display: "inline-block", width: 6, height: 14, background: "var(--accent)", marginLeft: 2, animation: "blink 1s infinite" }} />
        )}
      </div>
    </div>
  );
}

function ChatInput({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, padding: "16px 24px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => { setText(e.target.value); const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; } }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(e); } }}
        placeholder="Send a message..."
        rows={1}
        disabled={disabled}
        style={{
          flex: 1, resize: "none", background: "var(--bg-secondary)", border: "1px solid var(--border)",
          color: "var(--text)", padding: "10px 14px", fontSize: 14, fontFamily: "var(--font-sans)", outline: "none", lineHeight: "1.5",
        }}
      />
      <button
        type="submit"
        disabled={disabled || !text.trim()}
        style={{
          background: text.trim() && !disabled ? "var(--text)" : "var(--border)",
          color: "var(--bg)", border: "none", padding: "0 20px", fontSize: 13,
          fontWeight: 600, fontFamily: "var(--font-mono)", cursor: text.trim() && !disabled ? "pointer" : "default",
        }}
      >
        {disabled ? "..." : "Send"}
      </button>
    </form>
  );
}

// ─── App ─────────────────────────────────────────────────

export function App() {
  const { client } = usePolpo();
  const { theme, toggle: toggleTheme } = useTheme();
  const { sessions, activeSessionId, setActiveSessionId, getMessages, deleteSession, refetch: refetchSessions } = useSessions();
  const { agents } = useAgents();

  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(AGENT_ENV || null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load messages when selecting a session
  const loadSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    setSessionId(id);
    try {
      const msgs = await getMessages(id);
      setMessages(msgs.map((m: ChatMessage) => ({ role: m.role as "user" | "assistant", content: typeof m.content === "string" ? m.content : "" })));
      // Infer agent from session
      const session = sessions.find((s) => s.id === id);
      if (session?.agentName) setSelectedAgent(session.agentName);
    } catch {
      setMessages([]);
    }
  }, [getMessages, setActiveSessionId, sessions]);

  // New chat
  const startNewChat = useCallback(() => {
    setActiveSessionId(null);
    setSessionId(null);
    setMessages([]);
    // If only one agent or env agent set, skip selector
    if (AGENT_ENV) {
      setSelectedAgent(AGENT_ENV);
    } else if (agents.length === 1) {
      setSelectedAgent(agents[0].name);
    } else {
      setSelectedAgent(null);
    }
  }, [setActiveSessionId, agents]);

  // Send message
  const send = useCallback(async (text: string) => {
    if (!selectedAgent) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    const history = [
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: text },
    ];

    setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
    setStreaming(true);

    try {
      const stream = client.chatCompletionsStream({
        messages: history,
        stream: true,
        agent: selectedAgent,
        ...(sessionId ? { sessionId } : {}),
      });

      // Capture session ID from first chunk
      let capturedSessionId = sessionId;

      for await (const chunk of stream) {
        // Extract session ID from response if available
        if (!capturedSessionId && (chunk as any).sessionId) {
          capturedSessionId = (chunk as any).sessionId;
          setSessionId(capturedSessionId);
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = { ...last, content: last.content + delta };
            return updated;
          });
        }
      }

      // Refresh sessions list after new message
      await refetchSessions();
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: `Error: ${(err as Error).message}` };
        return updated;
      });
    } finally {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, streaming: false };
        return updated;
      });
      setStreaming(false);
    }
  }, [client, messages, selectedAgent, sessionId, refetchSessions]);

  // Show agent selector or chat
  const showSelector = !selectedAgent && messages.length === 0;

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Sidebar */}
      <Sidebar
        sessions={sessions as any[]}
        activeId={activeSessionId}
        onSelect={loadSession}
        onNew={startNewChat}
        onDelete={async (id) => { await deleteSession(id); if (activeSessionId === id) startNewChat(); }}
      />

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Top bar */}
        <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {selectedAgent && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600 }}>
                {selectedAgent}
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: streaming ? "var(--accent)" : "var(--text-muted)" }}>
              {streaming ? "streaming..." : selectedAgent ? "ready" : ""}
            </span>
          </div>
          <button
            onClick={toggleTheme}
            style={{
              background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
              padding: "4px 10px", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer",
            }}
          >
            {theme === "dark" ? "light" : "dark"}
          </button>
        </header>

        {/* Content */}
        {showSelector ? (
          <AgentSelector agents={agents as any[]} onSelect={setSelectedAgent} />
        ) : (
          <>
            <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              {messages.length === 0 && selectedAgent && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 800, letterSpacing: "0.3em", color: "var(--border)" }}>POLPO</span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Send a message to start</span>
                </div>
              )}
              {messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
              ))}
            </div>
            <ChatInput onSend={send} disabled={streaming} />
          </>
        )}
      </div>

      <style>{`@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }`}</style>
    </div>
  );
}

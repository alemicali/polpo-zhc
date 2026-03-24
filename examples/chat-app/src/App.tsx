import { useState, useRef, useEffect, useCallback } from "react";
import { usePolpo, useSessions, useAgents } from "@polpo-ai/react";
import type { ChatMessage, ChatCompletionStream } from "@polpo-ai/sdk";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import "streamdown/styles.css";
import { Columns2, Plus, Trash2, Square, ArrowUp, Sun, Moon, ChevronDown, ChevronRight, Wrench, Brain } from "lucide-react";

const AGENT_ENV = import.meta.env.VITE_POLPO_AGENT ?? "";

// ─── Theme ───────────────────────────────────────────────

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = localStorage.getItem("polpo-theme") as "dark" | "light" | null;
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("polpo-theme", theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}

// ─── Types ───────────────────────────────────────────────

interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  agent?: string;
  streaming?: boolean;
  toolCalls?: ToolCall[];
  thinking?: string;
}

// ─── Confirm Dialog ──────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)", border: "1px solid var(--border)",
          padding: 24, width: 320,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 20 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
              padding: "6px 14px", fontSize: 13, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: "#ef4444", border: "none", color: "#fff",
              padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────

function Sidebar({
  open,
  onToggle,
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  sessions: { id: string; title?: string; agent?: string; createdAt: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  return (
    <aside
      style={{
        width: open ? 260 : 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-secondary)",
        flexShrink: 0,
        transition: "width 0.2s",
      }}
    >
      <div style={{ width: 260, height: "100%", display: "flex", flexDirection: "column" }}>
        {/* Header with toggle */}
        <div style={{ padding: "12px 12px 12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, letterSpacing: "0.2em" }}>
              POLPO
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>chat example</div>
          </div>
          <button
            onClick={onToggle}
            style={{
              background: "none", border: "none", color: "var(--text-muted)",
              width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Columns2 size={16} />
          </button>
        </div>

          {/* New chat */}
          <button
            onClick={onNew}
            style={{
              margin: "4px 12px 8px",
              padding: "8px 12px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <Plus size={14} style={{ marginRight: 6 }} />
            New chat
          </button>

          {/* Sessions */}
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 12px" }}>
            {sessions.length === 0 && (
              <div style={{ padding: "16px 10px", fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                No chats yet
              </div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                onMouseEnter={() => setHoveredId(s.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  padding: "8px 10px",
                  marginBottom: 2,
                  cursor: "pointer",
                  background: activeId === s.id ? "var(--accent-dim)" : "transparent",
                  borderLeft: activeId === s.id ? "2px solid var(--accent)" : "2px solid transparent",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ overflow: "hidden", flex: 1 }}>
                  <div style={{
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: activeId === s.id ? "var(--text)" : "var(--text-muted)",
                  }}>
                    {s.title || s.agent || "Untitled"}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                </div>
                {hoveredId === s.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(s.id); }}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "2px", display: "flex", alignItems: "center" }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}

            <ConfirmDialog
              open={deleteTarget !== null}
              title="Delete chat"
              message="This will permanently delete this chat and all its messages."
              onConfirm={() => { if (deleteTarget) { onDelete(deleteTarget); setDeleteTarget(null); } }}
              onCancel={() => setDeleteTarget(null)}
            />
          </div>
        </div>
    </aside>
  );
}

// ─── Tool Call ───────────────────────────────────────────

function ToolCallBlock({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const stateColor = tool.state === "completed" ? "var(--accent)" : tool.state === "error" ? "#ef4444" : "var(--text-muted)";

  return (
    <div style={{ margin: "6px 0", border: "1px solid var(--border)", fontSize: 13 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: "var(--bg-secondary)", border: "none", color: "var(--text-muted)", cursor: "pointer",
          fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "left",
        }}
      >
        <Wrench size={12} style={{ color: stateColor }} />
        <span style={{ flex: 1 }}>{tool.name}</span>
        <span style={{ fontSize: 10, color: stateColor }}>{tool.state}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6 }}>
          {tool.arguments && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>args</div>
              <pre style={{ margin: 0, padding: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                <code>{JSON.stringify(tool.arguments, null, 2)}</code>
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>result</div>
              <pre style={{ margin: 0, padding: 8, background: "var(--bg)", border: "1px solid var(--border)", maxHeight: 200, overflow: "auto" }}>
                <code>{tool.result}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Thinking ────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ margin: "6px 0", border: "1px solid var(--border)", fontSize: 13 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: "var(--bg-secondary)", border: "none", color: "var(--text-muted)", cursor: "pointer",
          fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "left",
        }}
      >
        <Brain size={12} />
        <span style={{ flex: 1 }}>Thinking</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div style={{ padding: "12px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.7, fontStyle: "italic" }}>
          {content}
        </div>
      )}
    </div>
  );
}

// ─── Chat Bubble ─────────────────────────────────────────

function ChatBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ padding: "6px 0" }}>
      {/* Agent label */}
      {!isUser && msg.agent && (
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          marginBottom: 4,
        }}>
          {msg.agent}
        </div>
      )}
      <div style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}>
        <div style={{
          maxWidth: isUser ? "75%" : "100%",
          padding: isUser ? "10px 14px" : "0",
          background: isUser ? "var(--user-bg)" : "transparent",
          border: isUser ? "1px solid var(--border)" : "none",
          fontSize: 14,
          lineHeight: "1.7",
          color: isUser ? "var(--text)" : "var(--text-muted)",
        }}>
          {isUser ? (
            msg.content
          ) : (
            <>
              {msg.thinking && <ThinkingBlock content={msg.thinking} />}
              {msg.toolCalls?.map((tc, j) => <ToolCallBlock key={j} tool={tc} />)}
              {msg.content ? (
                <Streamdown mode={msg.streaming ? "streaming" : "static"} plugins={{ code }}>
                  {msg.content}
                </Streamdown>
              ) : msg.streaming ? (
                <span style={{ display: "inline-block", width: 6, height: 14, background: "var(--text-muted)", animation: "blink 1s infinite" }} />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Chat Input ──────────────────────────────────────────

function ChatInput({
  onSend,
  onStop,
  disabled,
  streaming,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
  streaming: boolean;
}) {
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
    <form onSubmit={submit} style={{ display: "flex", gap: 8, padding: "16px 0" }}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const el = ref.current;
          if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; }
        }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(e); } }}
        placeholder="Send a message..."
        rows={1}
        disabled={disabled && !streaming}
        style={{
          flex: 1, resize: "none", background: "var(--bg-secondary)", border: "1px solid var(--border)",
          color: "var(--text)", padding: "10px 14px", fontSize: 14, fontFamily: "var(--font-sans)", outline: "none", lineHeight: "1.5",
        }}
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          style={{
            background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
            padding: "0 14px", height: 40, display: "flex", alignItems: "center", justifyContent: "center",
            gap: 6, cursor: "pointer", fontSize: 13, fontFamily: "var(--font-sans)",
          }}
        >
          <Square size={12} />
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          style={{
            background: text.trim() && !disabled ? "var(--text)" : "var(--border)",
            color: "var(--bg)", border: "none", width: 40, height: 40,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: text.trim() && !disabled ? "pointer" : "default",
          }}
        >
          <ArrowUp size={16} />
        </button>
      )}
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<ChatCompletionStream | null>(null);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load session
  const loadSession = useCallback(async (id: string) => {
    setActiveSessionId(id);
    setSessionId(id);
    try {
      const msgs = await getMessages(id);
      setMessages(msgs.map((m: ChatMessage) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : "",
        agent: selectedAgent || undefined,
      })));
      const session = sessions.find((s) => s.id === id);
      if (session?.agent) setSelectedAgent(session.agent);
    } catch {
      setMessages([]);
    }
  }, [getMessages, setActiveSessionId, sessions, selectedAgent]);

  // New chat
  const startNewChat = useCallback(() => {
    setActiveSessionId(null);
    setSessionId(null);
    setMessages([]);
    if (AGENT_ENV) {
      setSelectedAgent(AGENT_ENV);
    } else {
      setSelectedAgent(null);
    }
  }, [setActiveSessionId, agents]);

  // Abort
  const handleStop = useCallback(() => {
    streamRef.current?.abort();
  }, []);

  // Send
  const send = useCallback(async (text: string) => {
    if (!selectedAgent) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);

    const history = [
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: text },
    ];

    setMessages((prev) => [...prev, { role: "assistant", content: "", agent: selectedAgent, streaming: true }]);
    setStreaming(true);

    try {
      const stream = client.chatCompletionsStream({
        messages: history,
        stream: true,
        agent: selectedAgent,
        ...(sessionId ? { sessionId } : {}),
      });
      streamRef.current = stream;

      for await (const chunk of stream) {
        // Capture session ID from stream (read from response header)
        if (!sessionId && stream.sessionId) {
          setSessionId(stream.sessionId);
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        // Text content
        const delta = choice.delta?.content;
        if (delta) {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = { ...last, content: last.content + delta };
            return updated;
          });
        }

        // Tool call events
        const tc = (choice as any).tool_call;
        if (tc) {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            const existing = last.toolCalls ?? [];
            const idx = existing.findIndex((t) => t.name === tc.name && t.state !== "completed");
            if (idx >= 0) {
              // Update existing tool call
              const newCalls = [...existing];
              newCalls[idx] = { ...newCalls[idx], ...tc };
              updated[updated.length - 1] = { ...last, toolCalls: newCalls };
            } else {
              // New tool call
              updated[updated.length - 1] = { ...last, toolCalls: [...existing, tc] };
            }
            return updated;
          });
        }
      }

      await refetchSessions();
    } catch (err) {
      // Don't show error if aborted
      if (!(err as Error)?.message?.includes("abort")) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${(err as Error).message}`, agent: selectedAgent };
          return updated;
        });
      }
    } finally {
      streamRef.current = null;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = { ...last, streaming: false };
        return updated;
      });
      setStreaming(false);
    }
  }, [client, messages, selectedAgent, sessionId, refetchSessions]);

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        sessions={sessions as any[]}
        activeId={activeSessionId}
        onSelect={loadSession}
        onNew={startNewChat}
        onDelete={async (id) => { await deleteSession(id); if (activeSessionId === id) startNewChat(); }}
      />

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Top bar */}
        <header style={{
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 12,
          minHeight: 48,
        }}>
          {/* Sidebar open toggle — only when closed */}
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              style={{
                background: "none", border: "none", color: "var(--text-muted)",
                width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", marginRight: 4,
              }}
            >
              <Columns2 size={16} />
            </button>
          )}
          <span style={{ fontSize: 13, fontWeight: 600, marginRight: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {selectedAgent && <span>{selectedAgent}</span>}
            {sessionId && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", fontWeight: 400 }}>
                {sessionId.slice(0, 8)}
              </span>
            )}
          </span>
          <button
            onClick={toggleTheme}
            style={{
              background: "none", border: "none", color: "var(--text-muted)",
              width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </header>

        {/* Chat area — max width centered */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
              {messages.length === 0 && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 12 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 800, letterSpacing: "0.3em", color: "var(--border)" }}>POLPO</span>
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Send a message to start</span>

                  {agents.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", maxWidth: 280, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "center", marginBottom: 4 }}>
                        select agent
                      </span>
                      {agents.map((a: any) => (
                        <button
                          key={a.name}
                          onClick={() => setSelectedAgent(a.name)}
                          style={{
                            padding: "10px 14px",
                            background: selectedAgent === a.name ? "var(--accent-dim)" : "var(--bg-secondary)",
                            border: selectedAgent === a.name ? "1px solid var(--accent)" : "1px solid var(--border)",
                            color: "var(--text)", fontSize: 13, fontFamily: "var(--font-sans)", cursor: "pointer",
                            textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center",
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{a.name}</span>
                          {a.model && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{a.model}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {messages.map((msg, i) => (
                <ChatBubble key={i} msg={msg} />
              ))}
            </div>
          </div>

          {/* Input — centered */}
          <div style={{ maxWidth: 720, margin: "0 auto", width: "100%", padding: "0 24px" }}>
            <ChatInput
              onSend={send}
              onStop={handleStop}
              disabled={!selectedAgent}
              streaming={streaming}
            />
          </div>
        </div>
      </div>

      <style>{`@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0 } }`}</style>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as WTermTerminal, type TerminalHandle } from "@wterm/react";
import "@wterm/react/css";
import { ShieldAlert } from "lucide-react";
import { useTerminalCore } from "@/hooks/use-terminal-core";
import { config, websocketUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "./types";

type Props = {
  sessionId: string;
  /** Bumped to force a fresh WebSocket + terminal instance. */
  revision: number;
  cwd: string;
  active: boolean;
  /** Agent CLI to run inside the terminal. Defaults to a raw shell. */
  agent?: "terminal" | "claude" | "codex";
  /** Stable id used by the agent CLI for `--continue` / `--resume`. */
  agentSessionId?: string;
  onConnectionChange: (state: ConnectionState) => void;
};

/** Self-contained terminal session — owns its WS, its xterm instance, and its lifecycle. */
export function TerminalSession({ sessionId, revision, cwd, active, agent, agentSessionId, onConnectionChange }: Props) {
  const [terminalReady, setTerminalReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalCore = useTerminalCore(revision);
  const terminalRef = useRef<TerminalHandle>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 30 });
  const activeRef = useRef(active);
  const onConnRef = useRef(onConnectionChange);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { onConnRef.current = onConnectionChange; }, [onConnectionChange]);

  useEffect(() => {
    setTerminalReady(false);
    setError(null);
    onConnRef.current("loading");
  }, [revision, terminalCore.loading]);

  const wsUrl = useMemo(() => {
    const url = new URL(websocketUrl("/ws/terminal"));
    url.searchParams.set("session_id", sessionId);
    url.searchParams.set("cwd", cwd || ".");
    url.searchParams.set("cols", String(sizeRef.current.cols));
    url.searchParams.set("rows", String(sizeRef.current.rows));
    url.searchParams.set("revision", String(revision));
    if (agent && agent !== "terminal") url.searchParams.set("agent", agent);
    if (agentSessionId) url.searchParams.set("agent_session_id", agentSessionId);
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    return url.toString();
  }, [agent, agentSessionId, cwd, sessionId, revision]);

  useEffect(() => {
    if (!terminalReady || terminalCore.loading || terminalCore.error) return;
    onConnRef.current("connecting");
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.addEventListener("open", () => {
      onConnRef.current("connected");
      if (activeRef.current) terminalRef.current?.focus();
      ws.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
    });
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
      terminalRef.current?.write(data);
      // wterm only auto-scrolls when its element was already at the bottom;
      // when the terminal is hidden (different right-panel tab, inactive
      // session) measurements drift and it stops. Force-pin to the bottom on
      // every chunk so output is never trapped above the fold.
      const el = terminalRef.current?.instance?.element;
      if (el) el.scrollTop = el.scrollHeight;
    });
    ws.addEventListener("close", () => onConnRef.current("closed"));
    ws.addEventListener("error", () => onConnRef.current("error"));

    return () => {
      socketRef.current = null;
      ws.close();
    };
  }, [terminalCore.error, terminalCore.loading, terminalReady, wsUrl]);

  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => {
      terminalRef.current?.resize(sizeRef.current.cols, sizeRef.current.rows);
      terminalRef.current?.focus();
      // Snap back to the live edge — output that arrived while we were
      // hidden may have left the scroll position in the middle.
      const el = terminalRef.current?.instance?.element;
      if (el) el.scrollTop = el.scrollHeight;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      className={cn(
        "absolute inset-0 transition-opacity duration-100",
        active ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
      )}
      aria-hidden={!active}
    >
      {terminalCore.error || error ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center gap-2 text-white/70">
            <ShieldAlert className="h-5 w-5 text-rose-400" />
            <p className="text-sm">{terminalCore.error ?? error ?? "Terminal failed to initialize."}</p>
          </div>
        </div>
      ) : terminalCore.loading ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div className="text-sm text-white/55">Loading Ghostty terminal core...</div>
        </div>
      ) : (
        <WTermTerminal
          key={revision}
          ref={terminalRef}
          core={terminalCore.core ?? undefined}
          autoResize
          cursorBlink
          // Override @wterm/react/css defaults so the terminal sits flush in the panel:
          // remove the 8px rounded corners + drop shadow but keep the inner 12px padding.
          className="!rounded-none !border-0 !shadow-none h-full w-full"
          onReady={() => setTerminalReady(true)}
          onData={(data) => {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "input", data }));
            }
          }}
          onResize={(cols, rows) => {
            sizeRef.current = { cols, rows };
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }}
          onError={(err) => {
            setError(err instanceof Error ? err.message : "Terminal failed to initialize.");
            onConnRef.current("error");
          }}
        />
      )}
    </div>
  );
}

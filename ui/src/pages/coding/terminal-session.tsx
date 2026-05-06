import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ShieldAlert } from "lucide-react";
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

/**
 * Self-contained xterm.js terminal session.
 *
 * Owns its own xterm instance, FitAddon, ResizeObserver and WebSocket. The
 * websocket URL is keyed off `sessionId + revision` so the server can replay
 * the scrollback buffer when we reconnect (see `/ws/terminal` handler).
 */
export function TerminalSession({ sessionId, revision, cwd, active, agent, agentSessionId, onConnectionChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onConnRef = useRef(onConnectionChange);
  useEffect(() => { onConnRef.current = onConnectionChange; }, [onConnectionChange]);

  // Mount the xterm instance once per (sessionId, revision). Bumping the
  // revision tears down the terminal and reconnects, which the server treats
  // as a fresh shell.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    setError(null);
    setReady(false);
    onConnRef.current("loading");

    const term = new Terminal({
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5_000,
      theme: {
        background: "#0a0a0a",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    termRef.current = term;
    fitRef.current = fit;

    // First fit once the host has its size from layout.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* host detached */ }
      setReady(true);
    });

    // Re-fit on container resize (panel drag, window resize, etc.)
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* layout in flux */ }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, revision]);

  const wsUrl = useMemo(() => {
    const url = new URL(websocketUrl("/ws/terminal"));
    url.searchParams.set("session_id", sessionId);
    url.searchParams.set("cwd", cwd || ".");
    url.searchParams.set("cols", "100");
    url.searchParams.set("rows", "30");
    url.searchParams.set("revision", String(revision));
    if (agent && agent !== "terminal") url.searchParams.set("agent", agent);
    if (agentSessionId) url.searchParams.set("agent_session_id", agentSessionId);
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    return url.toString();
  }, [agent, agentSessionId, cwd, sessionId, revision]);

  // WebSocket lifecycle — opens once xterm is ready, sends input + resize,
  // pipes pty output into the terminal.
  useEffect(() => {
    if (!ready) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    onConnRef.current("connecting");
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.addEventListener("open", () => {
      onConnRef.current("connected");
      sendResize();
      if (active) term.focus();
    });
    ws.addEventListener("message", (event) => {
      const payload = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
      term.write(payload);
    });
    ws.addEventListener("close", () => onConnRef.current("closed"));
    ws.addEventListener("error", () => onConnRef.current("error"));

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeDisposable = term.onResize(() => sendResize());

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      socketRef.current = null;
      ws.close();
    };
  }, [active, ready, wsUrl]);

  // When this pane becomes visible again, re-fit + focus + scroll-to-bottom.
  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* hidden */ }
      termRef.current?.focus();
      termRef.current?.scrollToBottom();
    });
    return () => window.cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      className={cn(
        "absolute inset-0 transition-opacity duration-100 bg-[#0a0a0a]",
        active ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
      )}
      aria-hidden={!active}
    >
      {error ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div className="flex flex-col items-center gap-2 text-white/70">
            <ShieldAlert className="h-5 w-5 text-rose-400" />
            <p className="text-sm">{error}</p>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="h-full w-full p-2" />
      )}
    </div>
  );
}

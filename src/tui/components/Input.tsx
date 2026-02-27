/**
 * Input — bottom bar with mode indicator, text input, processing shimmer, and voice recording.
 */

import { Box, Text, useInput, useApp } from "ink";
import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { usePolpo } from "../app.js";
import { startRecording, stopAndTranscribe, type RecordingHandle } from "../voice.js";
import { join } from "node:path";
import { createRequire } from "node:module";
import { formatToolDetails } from "../../llm/orchestrator-tools.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../../package.json") as { version: string };

const COMMANDS = [
  "/status", "/help", "/team", "/tasks", "/missions", "/plan",
  "/config", "/chat", "/task", "/sessions",
  "/abort", "/clear", "/clear-tasks", "/quit", "/memory",
  "/logs", "/logs sessions", "/inspect",
  "/team add", "/team remove", "/team edit", "/team rename",
  "/missions new", "/missions exec", "/missions resume", "/missions list",
  "/tasks list",
];

const MODE_COLORS: Record<string, string> = {
  task: "blue",
  plan: "yellow",
  chat: "magenta",
};

const SPINNER = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];

export function Input({
  onSubmit,
}: {
  onSubmit: (text: string) => void;
}) {
  const buffer = useStore((s) => s.inputBuffer);
  const cursorPos = useStore((s) => s.inputCursorPos);
  const setBuffer = useStore((s) => s.setInputBuffer);
  const mode = useStore((s) => s.inputMode);
  const processing = useStore((s) => s.processing);
  const processingLabel = useStore((s) => s.processingLabel);
  const streaming = useStore((s) => s.streaming);
  const streamingStartedAt = useStore((s) => s.streamingStartedAt);
  const streamingTokens = useStore((s) => s.streamingTokens);
  const history = useStore((s) => s.history);
  const page = useStore((s) => s.page);
  const recording = useStore((s) => s.recording);
  const polpo = usePolpo();
  const { exit } = useApp();

  const [historyIdx, setHistoryIdx] = useState(-1);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [approvalIdx, setApprovalIdx] = useState(0);
  const savedBuffer = useRef("");
  const lastCtrlC = useRef(0);
  const recordingHandle = useRef<RecordingHandle | null>(null);

  /** Update buffer and cursor atomically via Zustand. */
  const updateBuffer = (newBuf: string, pos?: number) => {
    setBuffer(newBuf, pos);
  };

  // Animate spinner during processing
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => setSpinnerTick((t) => (t + 1) % SPINNER.length), 80);
    return () => clearInterval(id);
  }, [processing]);

  // Track elapsed time for the entire streaming session (force re-render every second)
  const [streamingElapsed, setStreamingElapsed] = useState(0);
  useEffect(() => {
    if (!streaming || !streamingStartedAt) {
      setStreamingElapsed(0);
      return;
    }
    const update = () => {
      const elapsed = Date.now() - new Date(streamingStartedAt).getTime();
      setStreamingElapsed(elapsed);
    };
    update(); // initial
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [streaming, streamingStartedAt]);

  const completionActive = useStore((s) => s.completionActive);

  // Only capture input when on main page
  useInput(
    (input, key) => {
      if (page.id !== "main") return;

      // Clamp cursor to buffer length (safety net)
      const cpos = Math.min(cursorPos, buffer.length);

      // ── Esc — cancel processing or close menu ──
      if (key.escape) {
        if (processing) {
          useStore.getState().setProcessing(false);
          return;
        }
        // CompletionMenu handles its own Esc
        return;
      }

      // ── Ctrl+R — toggle voice recording ──
      if (input === "r" && key.ctrl) {
        const store = useStore.getState();
        if (store.recording) {
          // Stop recording and transcribe
          const handle = recordingHandle.current;
          if (!handle) {
            store.setRecording(false);
            return;
          }
          recordingHandle.current = null;
          store.setRecording(false);
          store.setProcessing(true, "Transcribing...");

          stopAndTranscribe(handle)
            .then((text) => {
              if (text) {
                const current = useStore.getState().inputBuffer;
                const separator = current && !current.endsWith(" ") ? " " : "";
                useStore.getState().setInputBuffer(current + separator + text);
              }
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              useStore.getState().log(`Voice error: ${msg}`, [
                { text: "Voice error: ", color: "red" },
                { text: msg, color: "gray" },
              ]);
            })
            .finally(() => {
              useStore.getState().setProcessing(false);
            });
        } else {
          // Start recording
          try {
            const tmpDir = join(polpo.getWorkDir(), ".polpo", "tmp");
            const handle = startRecording(tmpDir);
            recordingHandle.current = handle;
            store.setRecording(true);

            // If rec process exits unexpectedly, reset state
            handle.child.on("error", () => {
              recordingHandle.current = null;
              useStore.getState().setRecording(false);
              useStore.getState().log(
                "sox not found. Install with: sudo apt install sox",
                [{ text: "sox not found. Install with: ", color: "red" }, { text: "sudo apt install sox", color: "yellow" }],
              );
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            store.log(`Voice error: ${msg}`, [
              { text: "Voice error: ", color: "red" },
              { text: msg, color: "gray" },
            ]);
          }
        }
        return;
      }

      // ── Ctrl+A — toggle approval mode ──
      if (input === "a" && key.ctrl) {
        useStore.getState().toggleApprovalMode();
        return;
      }

      // ── Ctrl+O — toggle task panel ──
      if (input === "o" && key.ctrl) {
        useStore.getState().toggleTaskPanel();
        return;
      }

      // ── Ctrl+C — clear input / double-tap quit ──
      if (input === "c" && key.ctrl) {
        if (recording) {
          // Cancel recording without transcribing
          const handle = recordingHandle.current;
          if (handle) {
            handle.child.kill("SIGTERM");
          }
          recordingHandle.current = null;
          useStore.getState().setRecording(false);
          return;
        }
        if (processing) {
          // Do nothing during processing — use Esc instead
          return;
        }
        if (buffer.length > 0) {
          updateBuffer("");
          setHistoryIdx(-1);
          return;
        }
        const now = Date.now();
        if (now - lastCtrlC.current < 2000) {
          polpo.stop();
          exit();
          return;
        }
        lastCtrlC.current = now;
        setCtrlCHint(true);
        setTimeout(() => setCtrlCHint(false), 2000);
        return;
      }

      // ── Pending approval: ←→ navigate, Enter select ──
      const pending = useStore.getState().pendingApproval;
      if (pending) {
        const { extra } = formatToolDetails(pending.toolName, pending.args, polpo);
        const hasExtra = extra.length > 0;
        // Menu items: Approve, Reject, [Details], Inspect
        const menuItems = hasExtra
          ? ["Approve", "Reject", detailsExpanded ? "Hide details" : "Show details", "Inspect JSON"]
          : ["Approve", "Reject", "Inspect JSON"];
        const menuCount = menuItems.length;

        if (key.leftArrow) {
          setApprovalIdx((i) => (i - 1 + menuCount) % menuCount);
          return;
        }
        if (key.rightArrow) {
          setApprovalIdx((i) => (i + 1) % menuCount);
          return;
        }
        if (key.return) {
          const label = menuItems[approvalIdx];
          if (label === "Approve") {
            setDetailsExpanded(false);
            setApprovalIdx(0);
            pending.onApprove();
          } else if (label === "Reject") {
            setDetailsExpanded(false);
            setApprovalIdx(0);
            pending.onReject();
          } else if (label === "Show details" || label === "Hide details") {
            setDetailsExpanded((v) => !v);
          } else if (label === "Inspect JSON") {
            useStore.getState().navigate({
              id: "viewer",
              title: `Tool: ${pending.toolName}`,
              content: JSON.stringify(pending.args, null, 2),
              actions: ["Approve", "Reject"],
              onAction: (idx) => {
                useStore.getState().goMain();
                if (idx === 0) pending.onApprove();
                else pending.onReject();
              },
              onClose: () => useStore.getState().goMain(),
            });
          }
          return;
        }
        // y/n shortcuts still work
        if (input === "y" || input === "Y") {
          setDetailsExpanded(false);
          setApprovalIdx(0);
          pending.onApprove();
          return;
        }
        if (input === "n" || input === "N") {
          setDetailsExpanded(false);
          setApprovalIdx(0);
          pending.onReject();
          return;
        }
        return; // Ignore other keys during approval
      }

      // ── PageUp / PageDown — always scroll, even during processing ──
      if (input === "pageup" || (key.upArrow && key.meta)) {
        useStore.getState().scrollUp(15);
        return;
      }
      if (input === "pagedown" || (key.downArrow && key.meta)) {
        useStore.getState().scrollDown(15);
        return;
      }

      // ── Scroll during processing: allow arrow-key scrolling ──
      if (processing || recording) {
        if (key.upArrow) {
          useStore.getState().scrollUp(3);
          return;
        }
        if (key.downArrow) {
          useStore.getState().scrollDown(3);
          return;
        }
        return;
      }

      // Let CompletionMenu handle Enter/arrows/Esc when active
      if (completionActive && (key.return || key.upArrow || key.downArrow)) {
        return;
      }

      if (key.return) {
        const text = buffer.trim();
        if (text) {
          onSubmit(text);
          updateBuffer("");
          setHistoryIdx(-1);
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (cpos > 0) {
          updateBuffer(buffer.slice(0, cpos - 1) + buffer.slice(cpos), cpos - 1);
        }
        setHistoryIdx(-1);
        return;
      }

      // ── Left/Right — cursor movement ──
      if (key.leftArrow) {
        if (cpos > 0) setBuffer(buffer, cpos - 1);
        return;
      }
      if (key.rightArrow) {
        if (cpos < buffer.length) setBuffer(buffer, cpos + 1);
        return;
      }

      // Up/Down: scroll stream when buffer empty, history when typing
      if (key.upArrow) {
        if (buffer.length === 0) {
          // Always scroll when buffer is empty (regardless of historyIdx)
          useStore.getState().scrollUp(3);
          setHistoryIdx(-1);
        } else if (history.length > 0) {
          // History navigation only when there's text in the buffer
          if (historyIdx === -1) savedBuffer.current = buffer;
          const newIdx = Math.min(historyIdx + 1, history.length - 1);
          setHistoryIdx(newIdx);
          updateBuffer(history[history.length - 1 - newIdx] ?? "");
        }
        return;
      }
      if (key.downArrow) {
        if (buffer.length === 0) {
          // Always scroll when buffer is empty
          useStore.getState().scrollDown(3);
          setHistoryIdx(-1);
        } else if (historyIdx > 0) {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          updateBuffer(history[history.length - 1 - newIdx] ?? "");
        } else if (historyIdx === 0) {
          setHistoryIdx(-1);
          updateBuffer(savedBuffer.current);
        }
        return;
      }

      // Ctrl+L — clear stream
      if (input === "l" && key.ctrl) {
        useStore.getState().clearLines();
        return;
      }

      // Tab — command autocomplete when input starts with /
      if (key.tab && buffer.startsWith("/")) {
        const matches = COMMANDS.filter((c) => c.startsWith(buffer));
        if (matches.length === 1) {
          updateBuffer(matches[0]! + " ");
        } else if (matches.length > 1) {
          let prefix = matches[0]!;
          for (const m of matches) {
            while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
          }
          if (prefix.length > buffer.length) {
            updateBuffer(prefix);
          }
        }
        return;
      }

      // Tab — cycle mode
      if (key.tab) {
        const modes: Array<"task" | "plan" | "chat"> = ["chat", "plan", "task"];
        const next = modes[(modes.indexOf(mode) + 1) % modes.length]!;
        useStore.getState().setInputMode(next);
        return;
      }

      // Regular character input — insert at cursor position
      if (input && !key.ctrl && !key.meta) {
        updateBuffer(
          buffer.slice(0, cpos) + input + buffer.slice(cpos),
          cpos + input.length,
        );
        setHistoryIdx(-1);
      }
    },
    { isActive: page.id === "main" },
  );

  const modeColor = MODE_COLORS[mode] ?? "white";
  const approvalMode = useStore((s) => s.approvalMode);
  const pendingApproval = useStore((s) => s.pendingApproval);

  // Format elapsed time (e.g. "1m 4s", "12s")
  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  };

  // Format tokens (e.g. "2.8k", "150")
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <Box flexDirection="column">
      {/* Status line ABOVE the input box */}
      {processing && (
        <Box paddingX={2}>
          <Text>
            <Text color="cyan">{SPINNER[spinnerTick]} </Text>
            <Text color="gray">{processingLabel || "Processing..."}</Text>
            {streamingElapsed > 0 && (
              <>
                <Text color="gray"> · </Text>
                <Text color="cyan">{formatElapsed(streamingElapsed)}</Text>
              </>
            )}
          </Text>
        </Box>
      )}
      {!processing && streaming && (
        <Box paddingX={2}>
          <Text>
            <Text color="green">● </Text>
            <Text color="gray">Streaming</Text>
            {streamingElapsed > 0 && (
              <>
                <Text color="gray"> · </Text>
                <Text color="cyan">{formatElapsed(streamingElapsed)}</Text>
              </>
            )}
          </Text>
        </Box>
      )}
      {recording && (
        <Box paddingX={2}>
          <Text>
            <Text color="red" bold>● Recording...</Text>
            <Text color="gray"> (Ctrl+R to stop, Ctrl+C to cancel)</Text>
          </Text>
        </Box>
      )}

      {/* Pending approval OR normal input */}
      {pendingApproval ? (
        <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text>
            <Text color="yellow" bold>⚠ </Text>
            <Text color="white" bold inverse>{" "}{pendingApproval.description}{" "}</Text>
          </Text>
          {(() => {
            const { main, extra } = formatToolDetails(pendingApproval.toolName, pendingApproval.args, polpo);
            const hasExtra = extra.length > 0;
            const menuItems = hasExtra
              ? ["Approve", "Reject", detailsExpanded ? "Hide details" : "Show details", "Inspect JSON"]
              : ["Approve", "Reject", "Inspect JSON"];
            const menuColors: Record<string, string> = { Approve: "green", Reject: "red" };
            return (
              <>
                {main.map(([label, val]) => (
                  <Text key={label}>
                    <Text color="gray">  {label}: </Text>
                    <Text color="white" bold>{val}</Text>
                  </Text>
                ))}
                {detailsExpanded && extra.map(([label, val]) => (
                  <Text key={label}>
                    <Text color="gray">  {label}: </Text>
                    <Text>{val}</Text>
                  </Text>
                ))}
                <Box marginTop={0}>
                  {menuItems.map((item, i) => (
                    <Text key={item}>
                      {i > 0 && <Text color="gray">  </Text>}
                      <Text
                        color={i === approvalIdx ? (menuColors[item] ?? "cyan") : "gray"}
                        bold={i === approvalIdx}
                        inverse={i === approvalIdx}
                      >
                        {" "}{item}{" "}
                      </Text>
                    </Text>
                  ))}
                  <Text color="gray">  ←→ select  Enter confirm  y/n shortcut</Text>
                </Box>
              </>
            );
          })()}
        </Box>
      ) : (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          {ctrlCHint ? (
            <Text color="yellow">Press Ctrl+C again to quit</Text>
          ) : (
            <Text>
              <Text color={modeColor} bold>
                {mode}
              </Text>
              <Text color="gray"> ❯ </Text>
              <Text>{buffer.slice(0, Math.min(cursorPos, buffer.length))}</Text>
              <Text inverse={cursorPos < buffer.length} color={cursorPos < buffer.length ? undefined : "gray"}>
                {cursorPos < buffer.length ? buffer[cursorPos] : "█"}
              </Text>
              <Text>{cursorPos < buffer.length - 1 ? buffer.slice(cursorPos + 1) : ""}</Text>
            </Text>
          )}
        </Box>
      )}

      {/* Hint bar */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text color="cyan">Tab</Text><Text color="gray"> mode  </Text>
          <Text color="cyan">/</Text><Text color="gray"> cmds  </Text>
          <Text color="cyan">PgUp/Dn</Text><Text color="gray"> scroll  </Text>
          <Text color="cyan">Ctrl+R</Text><Text color="gray"> voice  </Text>
          <Text color="cyan">Ctrl+A</Text><Text color="gray"> approval  </Text>
          <Text color="cyan">Ctrl+C</Text><Text color="gray"> quit  </Text>
          <Text color="cyan">Esc</Text><Text color="gray"> cancel</Text>
        </Text>
        <Text>
          {approvalMode === "approval" ? (
            <Text color="gray">Standard</Text>
          ) : (
            <Text color="magenta" bold>Accept All</Text>
          )}
          <Text color="gray"> │ </Text>
          <Text color="cyan" bold>Polpo</Text>
          <Text color="gray"> v{PKG_VERSION}</Text>
        </Text>
      </Box>
    </Box>
  );
}

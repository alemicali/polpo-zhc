/**
 * Input — bottom bar with text input, processing shimmer, and voice recording.
 * Chat-only: no mode cycling, no task panel toggle, no approval mode.
 */

import { Box, Text, useInput, useApp } from "ink";
import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { usePolpo } from "../app.js";
import { startRecording, stopAndTranscribe, type RecordingHandle } from "../voice.js";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../../package.json") as { version: string };

const COMMANDS = [
  "/help", "/team", "/config", "/sessions",
  "/clear", "/quit", "/memory",
  "/team add", "/team remove", "/team edit", "/team rename",
];

const SPINNER = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];

export function Input({
  onSubmit,
}: {
  onSubmit: (text: string) => void;
}) {
  const buffer = useStore((s) => s.inputBuffer);
  const cursorPos = useStore((s) => s.inputCursorPos);
  const setBuffer = useStore((s) => s.setInputBuffer);
  const processing = useStore((s) => s.processing);
  const processingLabel = useStore((s) => s.processingLabel);
  const streaming = useStore((s) => s.streaming);
  const streamingStartedAt = useStore((s) => s.streamingStartedAt);
  const history = useStore((s) => s.history);
  const page = useStore((s) => s.page);
  const recording = useStore((s) => s.recording);
  const polpo = usePolpo();
  const { exit } = useApp();

  const [historyIdx, setHistoryIdx] = useState(-1);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const [ctrlCHint, setCtrlCHint] = useState(false);
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

      // ── Esc — cancel processing ──
      if (key.escape) {
        if (processing) {
          useStore.getState().setProcessing(false);
          return;
        }
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
          useStore.getState().scrollUp(3);
          setHistoryIdx(-1);
        } else if (history.length > 0) {
          if (historyIdx === -1) savedBuffer.current = buffer;
          const newIdx = Math.min(historyIdx + 1, history.length - 1);
          setHistoryIdx(newIdx);
          updateBuffer(history[history.length - 1 - newIdx] ?? "");
        }
        return;
      }
      if (key.downArrow) {
        if (buffer.length === 0) {
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

  // Format elapsed time (e.g. "1m 4s", "12s")
  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
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

      {/* Input box */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        {ctrlCHint ? (
          <Text color="yellow">Press Ctrl+C again to quit</Text>
        ) : (
          <Text>
            <Text color="magenta" bold>
              chat
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

      {/* Hint bar */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text color="cyan">/</Text><Text color="gray"> cmds  </Text>
          <Text color="cyan">PgUp/Dn</Text><Text color="gray"> scroll  </Text>
          <Text color="cyan">Ctrl+R</Text><Text color="gray"> voice  </Text>
          <Text color="cyan">Ctrl+L</Text><Text color="gray"> clear  </Text>
          <Text color="cyan">Ctrl+C</Text><Text color="gray"> quit  </Text>
          <Text color="cyan">Esc</Text><Text color="gray"> cancel</Text>
        </Text>
        <Text>
          <Text color="cyan" bold>Polpo</Text>
          <Text color="gray"> v{PKG_VERSION}</Text>
        </Text>
      </Box>
    </Box>
  );
}

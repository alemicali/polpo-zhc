/**
 * Input — bottom bar with mode indicator, text input, processing shimmer, and voice recording.
 */

import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { usePolpo } from "../app.js";
import { findMentionSpans } from "../mentions.js";
import { startRecording, stopAndTranscribe, type RecordingHandle } from "../voice.js";
import { basename, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../../package.json") as { version: string };

const MENTION_COLORS: Record<string, string> = {
  agent: "cyan",
  task: "yellow",
  plan: "blue",
};

const COMMANDS = [
  "/status", "/help", "/team", "/tasks", "/plans", "/plan",
  "/config", "/chat", "/task", "/sessions",
  "/abort", "/clear", "/clear-tasks", "/quit", "/memory",
  "/logs", "/logs sessions", "/inspect",
  "/team add", "/team remove", "/team edit", "/team rename",
  "/plans new", "/plans exec", "/plans resume", "/plans list",
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
  const setBuffer = useStore((s) => s.setInputBuffer);
  const mode = useStore((s) => s.inputMode);
  const processing = useStore((s) => s.processing);
  const processingLabel = useStore((s) => s.processingLabel);
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

  // Animate spinner during processing
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => setSpinnerTick((t) => (t + 1) % SPINNER.length), 80);
    return () => clearInterval(id);
  }, [processing]);

  const completionActive = useStore((s) => s.completionActive);

  // Only capture input when on main page
  useInput(
    (input, key) => {
      if (page.id !== "main") return;

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
          setBuffer("");
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

      if (processing || recording) return;

      // Let CompletionMenu handle Enter/arrows/Esc when active
      if (completionActive && (key.return || key.upArrow || key.downArrow)) {
        return;
      }

      if (key.return) {
        const text = buffer.trim();
        if (text) {
          onSubmit(text);
          setBuffer("");
          setHistoryIdx(-1);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setBuffer(buffer.slice(0, -1));
        setHistoryIdx(-1);
        return;
      }

      // History navigation
      if (key.upArrow && history.length > 0) {
        if (historyIdx === -1) savedBuffer.current = buffer;
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setBuffer(history[history.length - 1 - newIdx] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setBuffer(savedBuffer.current);
        } else {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          setBuffer(history[history.length - 1 - newIdx] ?? "");
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
          setBuffer(matches[0]! + " ");
        } else if (matches.length > 1) {
          let prefix = matches[0]!;
          for (const m of matches) {
            while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
          }
          if (prefix.length > buffer.length) {
            setBuffer(prefix);
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

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setBuffer(buffer + input);
        setHistoryIdx(-1);
      }
    },
    { isActive: page.id === "main" },
  );

  const modeColor = MODE_COLORS[mode] ?? "white";

  const renderWithMentions = (text: string) => {
    const spans = findMentionSpans(text);
    if (spans.length === 0) return <Text>{text}</Text>;

    const parts: React.ReactNode[] = [];
    let pos = 0;
    for (const span of spans) {
      if (span.start > pos) {
        parts.push(<Text key={`t${pos}`}>{text.slice(pos, span.start)}</Text>);
      }
      const color = MENTION_COLORS[span.type] ?? "white";
      parts.push(
        <Text key={`m${span.start}`} color={color} bold>
          {text.slice(span.start, span.end)}
        </Text>,
      );
      pos = span.end;
    }
    if (pos < text.length) {
      parts.push(<Text key={`t${pos}`}>{text.slice(pos)}</Text>);
    }
    return <>{parts}</>;
  };

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={recording ? "red" : "gray"} paddingX={1}>
        {recording ? (
          <Text>
            <Text color="red" bold>● Recording...</Text>
            <Text color="gray"> (Ctrl+R to stop, Ctrl+C to cancel)</Text>
          </Text>
        ) : processing ? (
          <Text>
            <Text color="cyan">{SPINNER[spinnerTick]} </Text>
            <Text color="gray">{processingLabel || "Processing..."}</Text>
          </Text>
        ) : ctrlCHint ? (
          <Text color="yellow">Press Ctrl+C again to quit</Text>
        ) : (
          <Text>
            <Text color={modeColor} bold>
              {mode}
            </Text>
            <Text color="gray"> ❯ </Text>
            {renderWithMentions(buffer)}
            <Text color="gray">█</Text>
          </Text>
        )}
      </Box>
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text color="cyan">Tab</Text><Text color="gray"> mode  </Text>
          <Text color="cyan">/</Text><Text color="gray"> cmds  </Text>
          <Text color="cyan">Ctrl+R</Text><Text color="gray"> voice  </Text>
          <Text color="cyan">Ctrl+C</Text><Text color="gray"> quit  </Text>
          <Text color="cyan">Esc</Text><Text color="gray"> cancel</Text>
        </Text>
        <Text>
          <Text color="cyan" bold>Polpo</Text>
          <Text color="gray"> v{PKG_VERSION}</Text>
          <Text color="gray"> — {basename(polpo.getWorkDir())}</Text>
        </Text>
      </Box>
    </Box>
  );
}

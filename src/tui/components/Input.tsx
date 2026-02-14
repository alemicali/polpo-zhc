/**
 * Input — bottom bar with mode indicator, text input, and processing shimmer.
 */

import { Box, Text, useInput, useApp } from "ink";
import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { usePolpo } from "../app.js";

const COMMANDS = [
  "/status", "/help", "/team", "/tasks", "/plans", "/plan",
  "/config", "/chat", "/task", "/sessions",
  "/abort", "/clear", "/clear-tasks", "/quit",
  "/team add", "/team remove", "/team edit", "/team rename",
  "/plans new", "/plans exec", "/plans resume", "/plans list",
  "/tasks list",
];

const MODE_COLORS: Record<string, string> = {
  task: "green",
  plan: "blue",
  chat: "magenta",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  const polpo = usePolpo();
  const { exit } = useApp();

  const [historyIdx, setHistoryIdx] = useState(-1);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const savedBuffer = useRef("");

  // Animate spinner during processing
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => setSpinnerTick((t) => (t + 1) % SPINNER.length), 80);
    return () => clearInterval(id);
  }, [processing]);

  // Only capture input when on main page and not processing
  useInput(
    (input, key) => {
      if (page.id !== "main") return;
      if (processing) return;

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

      // Ctrl+C — graceful stop / exit
      if (input === "c" && key.ctrl) {
        if (processing) {
          // Cancel current processing
          useStore.getState().setProcessing(false);
        } else if (buffer.length > 0) {
          // Clear input
          setBuffer("");
          setHistoryIdx(-1);
        } else {
          // Exit app
          polpo.stop();
          exit();
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
          // Find longest common prefix
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

      // Tab — cycle mode (when not autocompleting commands)
      if (key.tab) {
        const modes: Array<"task" | "plan" | "chat"> = ["task", "plan", "chat"];
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

  return (
    <Box height={1} paddingX={1}>
      {processing ? (
        <Text>
          <Text color="cyan">{SPINNER[spinnerTick]} </Text>
          <Text color="gray">{processingLabel || "Processing..."}</Text>
        </Text>
      ) : (
        <Text>
          <Text color={modeColor} bold>
            {mode}
          </Text>
          <Text color="gray"> ❯ </Text>
          <Text>{buffer}</Text>
          <Text color="gray">█</Text>
        </Text>
      )}
    </Box>
  );
}

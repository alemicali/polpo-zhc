/**
 * Input — bottom bar with mode indicator, text input, and processing shimmer.
 */

import { Box, Text, useInput } from "ink";
import { useState, useRef } from "react";
import { useStore } from "../store.js";

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

  const [historyIdx, setHistoryIdx] = useState(-1);
  const savedBuffer = useRef("");

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

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setBuffer(buffer + input);
        setHistoryIdx(-1);
      }
    },
    { isActive: page.id === "main" },
  );

  const modeColor = MODE_COLORS[mode] ?? "white";
  const tick = Math.floor(Date.now() / 80) % SPINNER.length;

  return (
    <Box height={1} paddingX={1}>
      {processing ? (
        <Text>
          <Text color="cyan">{SPINNER[tick]} </Text>
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

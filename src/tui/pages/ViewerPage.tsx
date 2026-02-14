/**
 * ViewerPage — full-screen scrollable content viewer with optional actions.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore, type Page } from "../store.js";

export function ViewerPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "viewer" }>;
  const { title, content, actions, onAction, onClose } = page;

  const lines = content.split("\n");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const maxVisible = 30;
  const hasActions = actions && actions.length > 0;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return && hasActions && onAction) {
      onAction(actionIdx);
      return;
    }

    // Scroll content
    if (key.upArrow || input === "k") {
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setScrollOffset((s) => Math.min(Math.max(0, lines.length - maxVisible), s + 1));
      return;
    }

    // Navigate actions with tab
    if (key.tab && hasActions) {
      setActionIdx((s) => (s + 1) % actions!.length);
      return;
    }
  });

  const visible = lines.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{title}</Text>
      <Text color="gray">{"─".repeat(Math.min(60, title.length + 4))}</Text>
      <Box height={1} />

      {visible.map((line, i) => (
        <Text key={scrollOffset + i}>{line || " "}</Text>
      ))}

      {lines.length > maxVisible && (
        <Text color="gray" dimColor>
          {"\n"}Lines {scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, lines.length)} of {lines.length}
        </Text>
      )}

      <Box height={1} />

      {hasActions ? (
        <Box>
          {actions!.map((action, i) => (
            <Text key={action}>
              <Text color={i === actionIdx ? "cyan" : "gray"} bold={i === actionIdx}>
                {i === actionIdx ? "❯ " : "  "}
                {action}
              </Text>
              <Text>  </Text>
            </Text>
          ))}
        </Box>
      ) : null}

      <Text color="gray">
        {hasActions
          ? "↑↓ scroll  Tab switch action  Enter confirm  Esc close"
          : "↑↓ scroll  Esc close"}
      </Text>
    </Box>
  );
}

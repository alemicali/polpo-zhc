/**
 * ViewerPage — full-screen scrollable content viewer with optional actions.
 *
 * Supports both plain string content and richContent (Seg[][] with colors).
 * Actions rendered as a vertical numbered menu at the bottom (press 1-9 or ↑↓+Enter).
 * Content fills the remaining height; menu is always visible at the bottom.
 */

import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { useStore, type Page, type Seg } from "../store.js";

/** Render a single Seg with its style. */
function SegText({ seg }: { seg: Seg }) {
  return (
    <Text
      color={seg.dim ? "gray" : (seg.color || undefined)}
      bold={seg.bold}
    >
      {seg.text}
    </Text>
  );
}

/** Render a line of segments. */
function RichLine({ segs }: { segs: Seg[] }) {
  return (
    <Text>
      {segs.map((s, i) => (
        <SegText key={i} seg={s} />
      ))}
    </Text>
  );
}

export function ViewerPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "viewer" }>;
  const { title, content, richContent, actions, onAction, onClose } = page;
  const { stdout } = useStdout();

  const richLines = richContent ?? content.split("\n").map((l) => [{ text: l || " " }] as Seg[]);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const hasActions = actions && actions.length > 0;

  // Layout: title(1) + sep(1) + [content area] + scroll_indicator(1) + spacer(1) + actions + hint(1) + padding(2)
  const actionCount = hasActions ? actions!.length : 0;
  const bottomHeight = actionCount + 3; // spacer + actions + hint + scroll indicator
  const termRows = stdout?.rows ?? 40;
  const maxVisible = Math.max(5, termRows - 4 - bottomHeight); // 4 = title + sep + top/bottom padding

  const maxScroll = Math.max(0, richLines.length - maxVisible);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    // Number keys 1-9 → direct action selection
    if (hasActions && onAction) {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= actions!.length) {
        onAction(num - 1);
        return;
      }
    }

    if (key.return && hasActions && onAction) {
      onAction(actionIdx);
      return;
    }

    // ↑↓ arrows → navigate actions menu
    if (key.upArrow && hasActions) {
      setActionIdx((s) => (s - 1 + actions!.length) % actions!.length);
      return;
    }
    if (key.downArrow && hasActions) {
      setActionIdx((s) => (s + 1) % actions!.length);
      return;
    }

    // j/k → scroll content
    if (input === "k") {
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }
    if (input === "j") {
      setScrollOffset((s) => Math.min(maxScroll, s + 1));
      return;
    }

    // Page up/down or ↑↓ when no actions
    if (key.pageUp || (key.upArrow && !hasActions)) {
      setScrollOffset((s) => Math.max(0, s - Math.floor(maxVisible / 2)));
      return;
    }
    if (key.pageDown || (key.downArrow && !hasActions)) {
      setScrollOffset((s) => Math.min(maxScroll, s + Math.floor(maxVisible / 2)));
      return;
    }
  });

  const visible = richLines.slice(scrollOffset, scrollOffset + maxVisible);
  // Pad with empty lines to fill the content area
  const emptyLines = Math.max(0, maxVisible - visible.length);

  const scrollable = richLines.length > maxVisible;
  const scrollPct = maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 100;

  return (
    <Box flexDirection="column" height={termRows} paddingX={2}>
      {/* Header */}
      <Text bold color="cyan">{title}</Text>
      <Text color="gray">{"─".repeat(Math.min(60, title.length + 4))}</Text>

      {/* Content area — fills available space */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((lineSegs, i) => (
          <RichLine key={scrollOffset + i} segs={lineSegs} />
        ))}
        {emptyLines > 0 && <Box height={emptyLines} />}
      </Box>

      {/* Scroll indicator */}
      {scrollable ? (
        <Text color="gray">
          Lines {scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, richLines.length)} of {richLines.length}  ({scrollPct}%)
        </Text>
      ) : (
        <Text> </Text>
      )}

      {/* Actions menu — anchored at bottom */}
      {hasActions ? (
        <Box flexDirection="column">
          {actions!.map((action, i) => (
            <Text key={action}>
              <Text color="gray">{i + 1}. </Text>
              <Text color={i === actionIdx ? "cyan" : "white"} bold={i === actionIdx}>
                {i === actionIdx ? "❯ " : "  "}
                {action}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Hint bar */}
      <Text color="gray">
        {hasActions
          ? "↑↓ select  j/k scroll  1-9 action  Enter confirm  Esc close"
          : "↑↓ scroll  Esc close"}
      </Text>
    </Box>
  );
}

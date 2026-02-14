/**
 * PickerPage — full-screen list selection.
 * Replaces the main view entirely, no overlay glitches.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore, type Page } from "../store.js";

export function PickerPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "picker" }>;
  const { title, items, hint, onSelect, onCancel, onKey } = page;

  const [selected, setSelected] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxVisible = 20;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const item = items[selected];
      if (item) onSelect(selected, item.value);
      return;
    }

    if (key.upArrow || input === "k") {
      setSelected((s) => {
        const next = Math.max(0, s - 1);
        if (next < scrollOffset) setScrollOffset(next);
        return next;
      });
      return;
    }

    if (key.downArrow || input === "j") {
      setSelected((s) => {
        const next = Math.min(items.length - 1, s + 1);
        if (next >= scrollOffset + maxVisible) setScrollOffset(next - maxVisible + 1);
        return next;
      });
      return;
    }

    // Forward custom keys to handler
    if (onKey) {
      const item = items[selected];
      if (item) onKey(input, selected, item.value);
    }
  });

  const visible = items.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{title}</Text>
      <Text color="gray">{"─".repeat(Math.min(60, title.length + 4))}</Text>
      <Box height={1} />

      {visible.map((item, i) => {
        const realIdx = scrollOffset + i;
        const isSelected = realIdx === selected;
        return (
          <Text key={item.value}>
            <Text color={isSelected ? "cyan" : "gray"}>
              {isSelected ? "❯ " : "  "}
            </Text>
            <Text bold={isSelected}>{item.label}</Text>
            {item.description && (
              <Text color="gray" dimColor> {item.description}</Text>
            )}
          </Text>
        );
      })}

      {items.length > maxVisible && (
        <Text color="gray" dimColor>
          {"\n"}
          {scrollOffset > 0 ? "↑ " : "  "}
          {scrollOffset + maxVisible < items.length ? "↓ " : "  "}
          {items.length} items
        </Text>
      )}

      <Box height={1} />
      <Text color="gray">
        {hint ?? "↑↓ navigate  Enter select  Esc cancel"}
      </Text>
    </Box>
  );
}

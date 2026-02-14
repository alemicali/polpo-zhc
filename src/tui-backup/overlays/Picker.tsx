import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PickerProps {
  title: string;
  items: Array<{ label: string; value: string }>;
  onSelect: (index: number, value: string) => void;
  onCancel: () => void;
  borderColor?: string;
  /** Custom key handler for additional keys (d, a, r, etc.) */
  onKey?: (input: string, key: any, selectedIndex: number, selectedValue: string) => void;
  /** Custom hint bar text (default: "Enter select  Escape cancel") */
  hint?: string;
  /** Max visible items before scrolling (default: all items) */
  maxVisible?: number;
}

export function Picker({ title, items, onSelect, onCancel, borderColor = "cyan", onKey, hint, maxVisible }: PickerProps) {
  const [selected, setSelected] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const maxV = maxVisible ?? items.length;
  const needsScroll = items.length > maxV;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((s) => {
        const next = Math.max(0, s - 1);
        setScrollOffset((so) => (next < so ? next : so));
        return next;
      });
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((s) => {
        const next = Math.min(items.length - 1, s + 1);
        setScrollOffset((so) => (next >= so + maxV ? next - maxV + 1 : so));
        return next;
      });
      return;
    }
    if (key.return) {
      const item = items[selected];
      if (item) onSelect(selected, item.value);
      return;
    }
    // Forward unhandled keys to custom handler
    if (onKey) {
      const item = items[selected];
      if (item) onKey(input, key, selected, item.value);
    }
  });

  const visibleItems = needsScroll
    ? items.slice(scrollOffset, scrollOffset + maxV)
    : items;
  const hasMoreAbove = needsScroll && scrollOffset > 0;
  const hasMoreBelow = needsScroll && scrollOffset + maxV < items.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      <Text bold> {title} </Text>
      {hasMoreAbove && (
        <Text dimColor>  ▲ {scrollOffset} more</Text>
      )}
      <Box flexDirection="column" marginTop={hasMoreAbove ? 0 : 1}>
        {visibleItems.map((item, i) => {
          const globalIdx = needsScroll ? scrollOffset + i : i;
          return (
            <Box key={item.value}>
              <Text
                inverse={globalIdx === selected}
                color={globalIdx === selected ? "white" : undefined}
                bold={globalIdx === selected}
              >
                {globalIdx === selected ? " > " : "   "}
                {item.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {hasMoreBelow && (
        <Text dimColor>  ▼ {items.length - scrollOffset - maxV} more</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hint ?? "Enter select  Escape cancel"}</Text>
      </Box>
    </Box>
  );
}

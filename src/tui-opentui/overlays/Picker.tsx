import { useState } from "react";
import { useKeyboard } from "@opentui/react";

export interface PickerProps {
  title: string;
  items: Array<{ label: string; value: string }>;
  onSelect: (index: number, value: string) => void;
  onCancel: () => void;
  borderColor?: string;
  onKey?: (input: string, key: any, selectedIndex: number, selectedValue: string) => void;
  hint?: string;
  maxVisible?: number;
}

export function Picker({ title, items, onSelect, onCancel, borderColor = "#00FFFF", onKey, hint, maxVisible }: PickerProps) {
  const [selected, setSelected] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const maxV = maxVisible ?? items.length;
  const needsScroll = items.length > maxV;

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "up" || key.char === "k") {
      setSelected((s) => {
        const next = Math.max(0, s - 1);
        setScrollOffset((so) => (next < so ? next : so));
        return next;
      });
      return;
    }
    if (key.name === "down" || key.char === "j") {
      setSelected((s) => {
        const next = Math.min(items.length - 1, s + 1);
        setScrollOffset((so) => (next >= so + maxV ? next - maxV + 1 : so));
        return next;
      });
      return;
    }
    if (key.name === "return") {
      const item = items[selected];
      if (item) onSelect(selected, item.value);
      return;
    }
    // Forward unhandled keys to custom handler
    if (onKey && key.char) {
      const item = items[selected];
      if (item) onKey(key.char, key, selected, item.value);
    }
  });

  const visibleItems = needsScroll
    ? items.slice(scrollOffset, scrollOffset + maxV)
    : items;
  const hasMoreAbove = needsScroll && scrollOffset > 0;
  const hasMoreBelow = needsScroll && scrollOffset + maxV < items.length;

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor,
        padding: 1,
      }}
    >
      <text bold> {title} </text>
      {hasMoreAbove && (
        <text fg="#555555">  ▲ {scrollOffset} more</text>
      )}
      <box style={{ flexDirection: "column", marginTop: hasMoreAbove ? 0 : 1 }}>
        {visibleItems.map((item, i) => {
          const globalIdx = needsScroll ? scrollOffset + i : i;
          const isSelected = globalIdx === selected;
          return (
            <text key={item.value}>
              {isSelected ? (
                <span bg="#0000FF" fg="#FFFFFF" bold> {">"} {item.label}</span>
              ) : (
                <span>   {item.label}</span>
              )}
            </text>
          );
        })}
      </box>
      {hasMoreBelow && (
        <text fg="#555555">  ▼ {items.length - scrollOffset - maxV} more</text>
      )}
      <text fg="#555555">{hint ?? "Enter select  Escape cancel"}</text>
    </box>
  );
}

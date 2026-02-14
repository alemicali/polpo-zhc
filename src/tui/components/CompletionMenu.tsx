/**
 * CompletionMenu — inline dropdown that appears above the input
 * when the user types "/". Filters commands as they type.
 * Arrow keys navigate, Enter selects, Esc closes.
 */

import { Box, Text, useInput } from "ink";
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { COMMANDS } from "../commands/help.js";

const MAX_VISIBLE = 8;

export function CompletionMenu({
  onSelect,
}: {
  onSelect: (command: string) => void;
}) {
  const buffer = useStore((s) => s.inputBuffer);
  const setBuffer = useStore((s) => s.setInputBuffer);
  const page = useStore((s) => s.page);
  const processing = useStore((s) => s.processing);
  const setCompletionActive = useStore((s) => s.setCompletionActive);

  const [selectedIdx, setSelectedIdx] = useState(0);

  // Only show when buffer starts with "/" and on main page
  const showMenu = page.id === "main" && !processing && buffer.startsWith("/") && !buffer.includes(" ");
  const query = buffer.slice(1).toLowerCase();

  // Filter commands matching the query
  const filtered = showMenu
    ? COMMANDS.filter(([cmd]) => {
        const base = cmd.split(" ")[0]!.slice(1);
        return base.startsWith(query);
      })
    : [];

  const active = showMenu && filtered.length > 0;

  // Sync completion state to store so Input knows to skip Enter/arrows
  useEffect(() => {
    setCompletionActive(active);
    return () => setCompletionActive(false);
  }, [active, setCompletionActive]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useInput(
    (_input, key) => {
      if (!active) return;

      if (key.upArrow) {
        setSelectedIdx((i) => (i > 0 ? i - 1 : filtered.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => (i < filtered.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const selected = filtered[selectedIdx];
        if (selected) {
          const cmd = selected[0].split(" ")[0]!;
          setBuffer("");
          onSelect(cmd);
        }
        return;
      }
      if (key.escape) {
        setBuffer("");
        return;
      }
    },
    { isActive: active },
  );

  if (!active) return null;

  // Show up to MAX_VISIBLE items, scrolling around selection
  const start = Math.max(0, Math.min(selectedIdx - Math.floor(MAX_VISIBLE / 2), filtered.length - MAX_VISIBLE));
  const visible = filtered.slice(start, start + MAX_VISIBLE);
  const startIdx = start;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginX={1}>
      {visible.map(([cmd, desc], i) => {
        const realIdx = startIdx + i;
        const isSelected = realIdx === selectedIdx;
        return (
          <Box key={cmd}>
            <Text inverse={isSelected}>
              <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                {cmd.padEnd(26)}
              </Text>
              <Text color="gray">
                {desc}
              </Text>
            </Text>
          </Box>
        );
      })}
      {filtered.length > MAX_VISIBLE && (
        <Text color="gray" dimColor>
          {" "}↑↓ {filtered.length} commands
        </Text>
      )}
    </Box>
  );
}

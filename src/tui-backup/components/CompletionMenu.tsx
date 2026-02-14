import { Box, Text } from "ink";
import { useTUIStore } from "../store.js";

/**
 * Command/mention completion menu — appears above the input box.
 * Matches old blessed TUI: cyan border, label "Commands", selected item highlighted.
 * Navigation (up/down/enter/escape) is handled by InputBar to avoid dual useInput conflicts.
 */
export function CompletionMenu() {
  const menuType = useTUIStore((s) => s.menuType);
  const menuItems = useTUIStore((s) => s.menuItems);
  const selected = useTUIStore((s) => s.menuIndex);

  if (!menuType || menuItems.length === 0) return null;

  const maxLabelLen = Math.max(...menuItems.map((i) => i.label.length));
  const menuWidth = Math.min(50, Math.max(30, maxLabelLen + 4));
  const innerW = menuWidth - 2;
  const label = menuType === "command" ? " Commands " : " Agents ";
  const topRight = Math.max(0, innerW - label.length - 1);
  const topBorder = `┌${label}${"─".repeat(topRight)}┐`;
  const bottomBorder = `└${"─".repeat(innerW)}┘`;

  return (
    <Box flexDirection="column" width={menuWidth}>
      <Text color="cyan">{topBorder}</Text>
      {menuItems.map((item, i) => {
        const text = item.label.slice(0, innerW).padEnd(innerW);
        return (
          <Text key={item.value}>
            <Text color="cyan">│</Text>
            {i === selected ? (
              <Text backgroundColor="blue" color="white" bold>
                {text}
              </Text>
            ) : (
              <Text>{text}</Text>
            )}
            <Text color="cyan">│</Text>
          </Text>
        );
      })}
      <Text color="cyan">{bottomBorder}</Text>
    </Box>
  );
}

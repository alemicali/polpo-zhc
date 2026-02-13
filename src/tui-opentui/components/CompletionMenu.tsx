import { useTUIStore } from "../../tui/store.js";

/**
 * Command/mention completion menu — appears above the input box.
 * Cyan border, selected item highlighted with blue background.
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
    <box style={{ flexDirection: "column", width: menuWidth }}>
      <text fg="#00FFFF">{topBorder}</text>
      {menuItems.map((item, i) => {
        const text = item.label.slice(0, innerW).padEnd(innerW);
        return (
          <text key={item.value}>
            <span fg="#00FFFF">│</span>
            {i === selected ? (
              <span bg="#0088FF" fg="#FFFFFF" bold>{text}</span>
            ) : (
              <span>{text}</span>
            )}
            <span fg="#00FFFF">│</span>
          </text>
        );
      })}
      <text fg="#00FFFF">{bottomBorder}</text>
    </box>
  );
}

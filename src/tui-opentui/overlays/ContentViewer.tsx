import { useState } from "react";
import { useKeyboard } from "@opentui/react";

export interface ContentViewerProps {
  title: string;
  content: string;
  actions?: string[];
  onAction?: (index: number) => void;
  onClose: () => void;
  onTab?: () => string | null;
  height?: number;
}

/**
 * Scrollable content viewer with optional action buttons.
 */
export function ContentViewer({
  title,
  content,
  actions,
  onAction,
  onClose,
  onTab,
  height,
}: ContentViewerProps) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedAction, setSelectedAction] = useState(0);
  const [viewContent, setViewContent] = useState(content);

  const viewLines = viewContent.split("\n");
  const viewHeight = (height ?? 20) - 6;
  const visibleLines = viewLines.slice(scrollOffset, scrollOffset + viewHeight);
  const hasActions = actions && actions.length > 0;

  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose();
      return;
    }

    if (key.name === "tab" && onTab) {
      const newContent = onTab();
      if (newContent !== null) {
        setViewContent(newContent);
        setScrollOffset(0);
      }
      return;
    }

    if (hasActions) {
      if (key.name === "up") {
        setSelectedAction((s) => Math.max(0, s - 1));
      } else if (key.name === "down") {
        setSelectedAction((s) => Math.min(actions!.length - 1, s + 1));
      } else if (key.name === "return") {
        onAction?.(selectedAction);
      }
    } else {
      if (key.name === "up") {
        setScrollOffset((s) => Math.max(0, s - 1));
      } else if (key.name === "down") {
        setScrollOffset((s) => Math.min(Math.max(0, viewLines.length - viewHeight), s + 1));
      }
    }
  });

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor: "#00FFFF",
        padding: 1,
      }}
    >
      <text bold> {title} </text>
      <box style={{ flexDirection: "column", marginTop: 1, height: viewHeight }}>
        {visibleLines.map((line, i) => (
          <text key={i + scrollOffset}>{stripBlessedTags(line)}</text>
        ))}
      </box>
      {hasActions && (
        <box
          style={{
            flexDirection: "column",
            marginTop: 1,
            border: true,
            borderColor: "#888888",
            padding: 1,
          }}
        >
          {actions!.map((action, i) => (
            <text key={action}>
              {i === selectedAction ? (
                <span bg="#0000FF" fg="#FFFFFF" bold> {">"} {stripBlessedTags(action)}</span>
              ) : (
                <span>   {stripBlessedTags(action)}</span>
              )}
            </text>
          ))}
        </box>
      )}
      <text fg="#555555">
        {hasActions ? "Enter select  " : ""}
        {onTab ? "Tab toggle  " : ""}
        Escape close  {!hasActions ? "↑↓ scroll" : ""}
      </text>
    </box>
  );
}

function stripBlessedTags(text: string): string {
  return text
    .replace(/\{[^}]*-fg\}/g, "")
    .replace(/\{\/[^}]*-fg\}/g, "")
    .replace(/\{[^}]*-bg\}/g, "")
    .replace(/\{\/[^}]*-bg\}/g, "")
    .replace(/\{bold\}/g, "")
    .replace(/\{\/bold\}/g, "")
    .replace(/\{open\}/g, "{")
    .replace(/\{close\}/g, "}")
    .replace(/\{[^}]*\}/g, "");
}

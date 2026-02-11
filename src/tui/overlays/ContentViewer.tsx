import { Box, Text, useInput } from "ink";
import { useState } from "react";

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

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.tab && onTab) {
      const newContent = onTab();
      if (newContent !== null) {
        setViewContent(newContent);
        setScrollOffset(0);
      }
      return;
    }

    if (hasActions) {
      if (key.upArrow) {
        setSelectedAction((s) => Math.max(0, s - 1));
      } else if (key.downArrow) {
        setSelectedAction((s) => Math.min(actions!.length - 1, s + 1));
      } else if (key.return) {
        onAction?.(selectedAction);
      }
    } else {
      if (key.upArrow) {
        setScrollOffset((s) => Math.max(0, s - 1));
      } else if (key.downArrow) {
        setScrollOffset((s) => Math.min(Math.max(0, viewLines.length - viewHeight), s + 1));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text bold> {title} </Text>
      <Box flexDirection="column" marginTop={1} height={viewHeight}>
        {visibleLines.map((line, i) => (
          <Text key={i + scrollOffset}>{stripBlessedTags(line)}</Text>
        ))}
      </Box>
      {hasActions && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {actions!.map((action, i) => (
            <Text
              key={action}
              inverse={i === selectedAction}
              bold={i === selectedAction}
            >
              {i === selectedAction ? " > " : "   "}{stripBlessedTags(action)}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {hasActions ? "Enter select  " : ""}
          {onTab ? "Tab toggle  " : ""}
          Escape close  {!hasActions ? "↑↓ scroll" : ""}
        </Text>
      </Box>
    </Box>
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

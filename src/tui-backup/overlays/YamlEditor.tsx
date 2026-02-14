import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface YamlEditorProps {
  title: string;
  initial?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

/**
 * Multi-line YAML editor overlay.
 * Navigate with arrow keys, type to insert at cursor, Ctrl+S to save.
 */
export function YamlEditor({ title, initial = "", onSave, onCancel }: YamlEditorProps) {
  const [lines, setLines] = useState<string[]>(initial.split("\n"));
  const [cursorRow, setCursorRow] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);

  useInput((input, key) => {
    // Save
    if (input === "s" && key.ctrl) {
      onSave(lines.join("\n"));
      return;
    }
    // Cancel
    if (key.escape) {
      onCancel();
      return;
    }
    // Navigation
    if (key.upArrow) {
      setCursorRow((r) => Math.max(0, r - 1));
      return;
    }
    if (key.downArrow) {
      setCursorRow((r) => Math.min(lines.length - 1, r + 1));
      return;
    }
    if (key.leftArrow) {
      setCursorCol((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorCol((c) => Math.min((lines[cursorRow] ?? "").length, c + 1));
      return;
    }
    // Enter — split line
    if (key.return) {
      setLines((ls) => {
        const line = ls[cursorRow] ?? "";
        const before = line.slice(0, cursorCol);
        const after = line.slice(cursorCol);
        const newLines = [...ls];
        newLines.splice(cursorRow, 1, before, after);
        return newLines;
      });
      setCursorRow((r) => r + 1);
      setCursorCol(0);
      return;
    }
    // Backspace
    if (key.backspace || key.delete) {
      if (cursorCol > 0) {
        setLines((ls) => {
          const line = ls[cursorRow] ?? "";
          const newLine = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
          const newLines = [...ls];
          newLines[cursorRow] = newLine;
          return newLines;
        });
        setCursorCol((c) => c - 1);
      } else if (cursorRow > 0) {
        // Join with previous line
        setLines((ls) => {
          const prevLine = ls[cursorRow - 1] ?? "";
          const curLine = ls[cursorRow] ?? "";
          const newLines = [...ls];
          newLines.splice(cursorRow - 1, 2, prevLine + curLine);
          return newLines;
        });
        const prevLen = (lines[cursorRow - 1] ?? "").length;
        setCursorRow((r) => r - 1);
        setCursorCol(prevLen);
      }
      return;
    }
    // Character input
    if (input && !key.ctrl && !key.meta) {
      setLines((ls) => {
        const line = ls[cursorRow] ?? "";
        const newLine = line.slice(0, cursorCol) + input + line.slice(cursorCol);
        const newLines = [...ls];
        newLines[cursorRow] = newLine;
        return newLines;
      });
      setCursorCol((c) => c + input.length);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold> {title} </Text>
      <Text dimColor> Ctrl+S save  Escape cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <Box key={i}>
            <Text dimColor>{String(i + 1).padStart(3)} </Text>
            {i === cursorRow ? (
              <Text>
                {line.slice(0, cursorCol)}
                <Text inverse>{line[cursorCol] ?? " "}</Text>
                {line.slice(cursorCol + 1)}
              </Text>
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

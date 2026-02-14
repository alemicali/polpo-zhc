/**
 * EditorPage — full-screen multi-line text/YAML editor.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore, type Page } from "../store.js";

export function EditorPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "editor" }>;
  const { title, initial, onSave, onCancel } = page;

  const [lines, setLines] = useState(initial.split("\n"));
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Ctrl+S to save
    if (key.ctrl && input === "s") {
      onSave(lines.join("\n"));
      return;
    }

    if (key.return) {
      const before = lines[row]!.slice(0, col);
      const after = lines[row]!.slice(col);
      const newLines = [...lines];
      newLines.splice(row, 1, before, after);
      setLines(newLines);
      setRow(row + 1);
      setCol(0);
      return;
    }

    if (key.backspace || key.delete) {
      if (col > 0) {
        const newLines = [...lines];
        newLines[row] = lines[row]!.slice(0, col - 1) + lines[row]!.slice(col);
        setLines(newLines);
        setCol(col - 1);
      } else if (row > 0) {
        const prevLen = lines[row - 1]!.length;
        const newLines = [...lines];
        newLines[row - 1] = lines[row - 1]! + lines[row]!;
        newLines.splice(row, 1);
        setLines(newLines);
        setRow(row - 1);
        setCol(prevLen);
      }
      return;
    }

    if (key.upArrow) {
      if (row > 0) {
        setRow(row - 1);
        setCol(Math.min(col, lines[row - 1]!.length));
      }
      return;
    }
    if (key.downArrow) {
      if (row < lines.length - 1) {
        setRow(row + 1);
        setCol(Math.min(col, lines[row + 1]!.length));
      }
      return;
    }
    if (key.leftArrow) {
      setCol(Math.max(0, col - 1));
      return;
    }
    if (key.rightArrow) {
      setCol(Math.min(lines[row]!.length, col + 1));
      return;
    }

    // Regular character
    if (input && !key.ctrl && !key.meta) {
      const newLines = [...lines];
      newLines[row] = lines[row]!.slice(0, col) + input + lines[row]!.slice(col);
      setLines(newLines);
      setCol(col + input.length);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{title}</Text>
      <Text color="gray">{"─".repeat(Math.min(60, title.length + 4))}</Text>
      <Box height={1} />

      {lines.map((line, i) => (
        <Text key={i}>
          <Text color="gray" dimColor>{String(i + 1).padStart(3)} </Text>
          {i === row ? (
            <Text>
              {line.slice(0, col)}
              <Text inverse>{line[col] ?? " "}</Text>
              {line.slice(col + 1)}
            </Text>
          ) : (
            <Text>{line}</Text>
          )}
        </Text>
      ))}

      <Box height={1} />
      <Text color="gray">Ctrl+S save  Esc cancel</Text>
    </Box>
  );
}

import { useState } from "react";
import { useKeyboard } from "@opentui/react";

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

  useKeyboard((key) => {
    // Save
    if (key.name === "s" && key.ctrl) {
      onSave(lines.join("\n"));
      return;
    }
    // Cancel
    if (key.name === "escape") {
      onCancel();
      return;
    }
    // Navigation
    if (key.name === "up") {
      setCursorRow((r) => Math.max(0, r - 1));
      return;
    }
    if (key.name === "down") {
      setCursorRow((r) => Math.min(lines.length - 1, r + 1));
      return;
    }
    if (key.name === "left") {
      setCursorCol((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "right") {
      setCursorCol((c) => Math.min((lines[cursorRow] ?? "").length, c + 1));
      return;
    }
    // Enter — split line
    if (key.name === "return") {
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
    if (key.name === "backspace" || key.name === "delete") {
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
    if (key.char && !key.ctrl && !key.alt) {
      setLines((ls) => {
        const line = ls[cursorRow] ?? "";
        const newLine = line.slice(0, cursorCol) + key.char + line.slice(cursorCol);
        const newLines = [...ls];
        newLines[cursorRow] = newLine;
        return newLines;
      });
      setCursorCol((c) => c + (key.char?.length ?? 1));
    }
  });

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderColor: "#FFFF00",
        padding: 1,
      }}
    >
      <text bold> {title} </text>
      <text fg="#555555"> Ctrl+S save  Escape cancel</text>
      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {lines.map((line, i) => (
          <text key={i}>
            <span fg="#555555">{String(i + 1).padStart(3)} </span>
            {i === cursorRow ? (
              <>
                <span>{line.slice(0, cursorCol)}</span>
                <span bg="#FFFFFF" fg="#000000">{line[cursorCol] ?? " "}</span>
                <span>{line.slice(cursorCol + 1)}</span>
              </>
            ) : (
              <span>{line}</span>
            )}
          </text>
        ))}
      </box>
    </box>
  );
}

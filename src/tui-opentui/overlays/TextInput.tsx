import { useState } from "react";
import { useKeyboard } from "@opentui/react";

export interface TextInputOverlayProps {
  title: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function TextInputOverlay({ title, initial = "", onSubmit, onCancel }: TextInputOverlayProps) {
  const [buffer, setBuffer] = useState(initial);

  useKeyboard((key) => {
    if (key.name === "return") {
      if (buffer.trim()) onSubmit(buffer.trim());
      return;
    }
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "backspace" || key.name === "delete") {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.char && !key.ctrl && !key.alt) {
      setBuffer((b) => b + key.char);
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
      <box style={{ marginTop: 1 }}>
        <text>
          <span>{buffer}</span>
          <span fg="#555555">_</span>
        </text>
      </box>
      <text fg="#555555">Enter confirm  Escape cancel</text>
    </box>
  );
}

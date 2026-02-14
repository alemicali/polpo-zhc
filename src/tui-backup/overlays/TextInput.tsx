import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface TextInputOverlayProps {
  title: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function TextInputOverlay({ title, initial = "", onSubmit, onCancel }: TextInputOverlayProps) {
  const [buffer, setBuffer] = useState(initial);

  useInput((input, key) => {
    if (key.return) {
      if (buffer.trim()) onSubmit(buffer.trim());
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b + input);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold> {title} </Text>
      <Box marginTop={1}>
        <Text>{buffer}</Text>
        <Text dimColor>_</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter confirm  Escape cancel</Text>
      </Box>
    </Box>
  );
}

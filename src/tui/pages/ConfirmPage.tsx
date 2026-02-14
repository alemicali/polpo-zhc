/**
 * ConfirmPage — full-screen yes/no confirmation.
 * Used for destructive or important actions.
 */

import { Box, Text, useInput } from "ink";
import { useStore, type Page } from "../store.js";

export function ConfirmPage() {
  const page = useStore((s) => s.page) as Extract<Page, { id: "confirm" }>;
  const { message, onConfirm, onCancel } = page;

  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") {
      onCancel();
      return;
    }
    if (key.return || input === "y" || input === "Y") {
      onConfirm();
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="yellow">{message}</Text>
      <Box height={1} />
      <Text>
        <Text color="green" bold>y</Text>
        <Text color="gray">es  </Text>
        <Text color="red" bold>n</Text>
        <Text color="gray">o</Text>
      </Text>
    </Box>
  );
}

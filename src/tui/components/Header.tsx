/**
 * Header — minimal top bar: POLPO | <dir> | streaming status.
 */

import { Box, Text } from "ink";
import { usePolpo } from "../app.js";
import { useStore } from "../store.js";
import { basename } from "node:path";

export function Header() {
  const polpo = usePolpo();
  const streaming = useStore((s) => s.streaming);

  const dir = basename(polpo.getWorkDir());

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="white" bold>POLPO</Text>
        <Text color="gray"> | </Text>
        <Text color="gray">{dir}</Text>
      </Text>
      <Text>
        {streaming ? (
          <Text color="green">● streaming</Text>
        ) : (
          <Text color="gray">● ready</Text>
        )}
      </Text>
    </Box>
  );
}

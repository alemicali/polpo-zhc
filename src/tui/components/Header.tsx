/**
 * Header — persistent top bar showing project and team.
 */

import { Box, Text } from "ink";
import { usePolpo } from "../app.js";

export function Header() {
  const polpo = usePolpo();
  const config = polpo.getConfig();
  const project = config?.project ?? "polpo";
  const agents = config?.team.agents ?? [];

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>🐙 {project}</Text>
        <Text color="gray"> — {polpo.getWorkDir()}</Text>
      </Text>
      <Text>
        <Text color="gray">team </Text>
        {agents.length > 0 ? (
          agents.map((a, i) => (
            <Text key={a.name}>
              {i > 0 && <Text color="gray">, </Text>}
              <Text color="gray">{a.name}</Text>
            </Text>
          ))
        ) : (
          <Text color="gray">—</Text>
        )}
      </Text>
    </Box>
  );
}

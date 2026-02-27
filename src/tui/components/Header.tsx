/**
 * Header — persistent top bar: POLPO | <dir> | ● N running | ✓ N done | status
 */

import { Box, Text } from "ink";
import { usePolpo } from "../app.js";
import { useStore } from "../store.js";
import { basename } from "node:path";

export function Header() {
  const polpo = usePolpo();
  const tasks = useStore((s) => s.tasks);
  const missions = useStore((s) => s.missions);

  const dir = basename(polpo.getWorkDir());
  const done = tasks.filter((t) => t.status === "done").length;
  const running = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "review",
  ).length;
  const orchestrating = running > 0;
  const draftMissions = missions.filter((p) => p.status === "draft").length;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="white" bold>POLPO</Text>
        <Text color="gray"> | </Text>
        <Text color="gray">{dir}</Text>
      </Text>
      <Text wrap="truncate">
        {running > 0 && <Text color="#FFA500">● {running} running</Text>}
        {running > 0 && <Text color="gray"> | </Text>}
        {done > 0 && <Text color="green">✓ {done} done</Text>}
        {done > 0 && <Text color="gray"> | </Text>}
        {draftMissions > 0 && <Text color="yellow">□ {draftMissions} draft</Text>}
        {draftMissions > 0 && <Text color="gray"> | </Text>}
        <Text color={orchestrating ? "green" : "gray"}>
          {orchestrating ? "♪ running" : "♪ idle"}
        </Text>
      </Text>
    </Box>
  );
}

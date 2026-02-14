import { Box, Text } from "ink";
import { useTUIStore } from "../store.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 1-line header, no border.
 * Content: ` project  |  ● N running  |  ✓ N done  |  ⠋ orchestrating`
 */
export function Header({ width }: { width: number }) {
  const state = useTUIStore((s) => s.state);
  const frame = useTUIStore((s) => s.frame);
  const config = useTUIStore((s) => s.config);

  const tasks = state?.tasks ?? [];
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const running =
    (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
  const done = counts["done"] || 0;
  const failed = counts["failed"] || 0;

  const hasActive = state?.processes?.some((p) => p.alive);
  const spin = SPINNER[frame % SPINNER.length];

  return (
    <Box width={width} height={1}>
      <Text>
        {" "}
        {config?.project ? <Text bold>{config.project}</Text> : null}
        {running > 0 ? (
          <>
            <Text dimColor>  |  </Text>
            <Text color="yellow">● {running} running</Text>
          </>
        ) : null}
        {done > 0 ? (
          <>
            <Text dimColor>  |  </Text>
            <Text color="green">✓ {done} done</Text>
          </>
        ) : null}
        {failed > 0 ? (
          <>
            <Text dimColor>  |  </Text>
            <Text color="red">✗ {failed} failed</Text>
          </>
        ) : null}
        {hasActive ? (
          <>
            <Text dimColor>  |  </Text>
            <Text color="cyan">{spin} orchestrating</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}

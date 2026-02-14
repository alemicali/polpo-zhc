/**
 * MainView — default page: Stream + TaskPanel side by side + Input at bottom.
 */

import { Box, useStdout } from "ink";
import { Stream } from "./Stream.js";
import { TaskPanel } from "./TaskPanel.js";
import { Input } from "./Input.js";

const TASK_PANEL_WIDTH = 28;
const INPUT_HEIGHT = 1;

export function MainView({ onSubmit }: { onSubmit: (text: string) => void }) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const contentHeight = Math.max(1, rows - INPUT_HEIGHT - 1);
  const streamWidth = Math.max(10, cols - TASK_PANEL_WIDTH);

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" height={contentHeight}>
        <Box width={streamWidth}>
          <Stream height={contentHeight} />
        </Box>
        <TaskPanel width={TASK_PANEL_WIDTH} height={contentHeight} />
      </Box>
      <Input onSubmit={onSubmit} />
    </Box>
  );
}

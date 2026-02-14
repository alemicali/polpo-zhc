/**
 * MainView — default page: Stream + TaskPanel side by side + Input at bottom.
 * CompletionMenu appears above Input when typing "/".
 */

import { Box, useStdout } from "ink";
import { Header } from "./Header.js";
import { Stream } from "./Stream.js";
import { TaskPanel } from "./TaskPanel.js";
import { Input } from "./Input.js";
import { CompletionMenu } from "./CompletionMenu.js";
import { useStore } from "../store.js";
import { dispatch } from "../commands/router.js";
import { usePolpo } from "../app.js";
import { COMMANDS } from "../commands/help.js";

const TASK_PANEL_WIDTH = 36;
const HEADER_HEIGHT = 1;
const INPUT_HEIGHT = 4; // border (3) + hint row (1)
const MAX_MENU_ITEMS = 8;

export function MainView({ onSubmit }: { onSubmit: (text: string) => void }) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  const polpo = usePolpo();

  const buffer = useStore((s) => s.inputBuffer);
  const processing = useStore((s) => s.processing);

  // Calculate menu height when active
  const menuActive = !processing && buffer.startsWith("/") && !buffer.includes(" ");
  const query = buffer.slice(1).toLowerCase();
  const matchCount = menuActive
    ? COMMANDS.filter(([cmd]) => cmd.split(" ")[0]!.slice(1).startsWith(query)).length
    : 0;
  const menuHeight = matchCount > 0 ? Math.min(matchCount, MAX_MENU_ITEMS) + 2 : 0; // +2 for border

  const contentHeight = Math.max(1, rows - HEADER_HEIGHT - INPUT_HEIGHT - menuHeight - 1);
  const streamWidth = Math.max(10, cols - TASK_PANEL_WIDTH);

  const handleCommandSelect = (cmd: string) => {
    const store = useStore.getState();
    dispatch(cmd, { polpo, store, args: [] });
  };

  return (
    <Box flexDirection="column" height={rows}>
      <Header />
      <Box flexDirection="row" height={contentHeight}>
        <Box width={streamWidth}>
          <Stream height={contentHeight} />
        </Box>
        <TaskPanel width={TASK_PANEL_WIDTH} height={contentHeight} />
      </Box>
      {menuHeight > 0 && <CompletionMenu onSelect={handleCommandSelect} />}
      <Input onSubmit={onSubmit} />
    </Box>
  );
}

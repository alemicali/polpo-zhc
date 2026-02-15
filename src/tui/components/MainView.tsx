/**
 * MainView — default page: Stream + TaskPanel side by side + Input at bottom.
 * CompletionMenu appears above Input when typing "/".
 */

import { useEffect } from "react";
import { Box, useStdout } from "ink";
import { Header } from "./Header.js";
import { Stream } from "./Stream.js";
import { TaskPanel } from "./TaskPanel.js";
import { Input } from "./Input.js";
import { CompletionMenu } from "./CompletionMenu.js";
import { useStore } from "../store.js";
import { dispatch } from "../commands/router.js";
import { usePolpo } from "../app.js";

const TASK_PANEL_WIDTH = 64;
const HEADER_HEIGHT = 1;
const INPUT_HEIGHT = 4; // border (3) + hint row (1)
const MAX_MENU_ITEMS = 8;

export function MainView({ onSubmit }: { onSubmit: (text: string) => void }) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;
  const polpo = usePolpo();

  const processing = useStore((s) => s.processing);
  const streaming = useStore((s) => s.streaming);
  const recording = useStore((s) => s.recording);
  const taskPanelVisible = useStore((s) => s.taskPanelVisible);
  const completionActive = useStore((s) => s.completionActive);

  // CompletionMenu reports its active state — we reserve space for it
  const menuHeight = completionActive ? MAX_MENU_ITEMS + 2 : 0;

  // Status line above input adds 1 row when processing, streaming, or recording
  const statusLineHeight = (processing || streaming || recording) ? 1 : 0;
  const contentHeight = Math.max(1, rows - HEADER_HEIGHT - INPUT_HEIGHT - menuHeight - statusLineHeight);
  const panelWidth = taskPanelVisible ? TASK_PANEL_WIDTH : 0;
  const streamWidth = Math.max(10, cols - panelWidth);

  // ── Mouse wheel scrolling ──
  // Alternate scroll mode: terminal converts wheel events to arrow keys.
  // No escape sequence parsing needed — Ink handles arrow keys natively.
  // The existing up/down arrow handler in Input.tsx scrolls the stream.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?1007h"); // enable alternate scroll mode
    return () => {
      process.stdout.write("\x1b[?1007l"); // disable
    };
  }, []);

  const handleCommandSelect = (cmd: string) => {
    const store = useStore.getState();
    dispatch(cmd, { polpo, store, args: [] });
  };

  return (
    <Box flexDirection="column" height={rows}>
      <Header />
      <Box flexDirection="row" height={contentHeight}>
        <Box width={streamWidth}>
          <Stream height={contentHeight} width={streamWidth} />
        </Box>
        {taskPanelVisible && (
          <TaskPanel width={TASK_PANEL_WIDTH} height={contentHeight} />
        )}
      </Box>
      <CompletionMenu onSelect={handleCommandSelect} />
      <Input onSubmit={onSubmit} />
    </Box>
  );
}
